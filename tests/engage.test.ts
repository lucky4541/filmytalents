import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { api, auth, loginAdmin, loginMember } from './helpers';
import { db, schema } from '../src/db';

const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946000101', 'hex'), Buffer.alloc(200, 1)]);
let admin: Awaited<ReturnType<typeof loginAdmin>>;
let pro1: Awaited<ReturnType<typeof loginMember>>;
let pro2: Awaited<ReturnType<typeof loginMember>>;
let free: Awaited<ReturnType<typeof loginMember>>;

const giveProTo = (id: string) => api().post(`/api/v1/admin/users/${id}/plan`).set(auth(admin.token)).send({ planId: 'pro', days: 30 });

beforeAll(async () => {
  admin = await loginAdmin();
  pro1 = await loginMember(); pro2 = await loginMember(); free = await loginMember();
  await api().patch('/api/v1/me').set(auth(pro1.token)).send({ name: 'Chat Pro One', city: 'Chennai', crafts: ['Dancer'] });
  await api().patch('/api/v1/me').set(auth(pro2.token)).send({ name: 'Chat Pro Two', city: 'Chennai' });
  await api().patch('/api/v1/me').set(auth(free.token)).send({ name: 'Chat Free', city: 'Kochi' });
  await giveProTo(pro1.user.id); await giveProTo(pro2.user.id);
});

describe('notifications', () => {
  it('lists, counts unread, marks read', async () => {
    const l = await api().get('/api/v1/notifications').set(auth(pro1.token));
    expect(l.body.unread).toBeGreaterThan(0); // "You got Pro!"
    await api().post('/api/v1/notifications/read').set(auth(pro1.token)).send({ all: true });
    expect((await api().get('/api/v1/notifications/unread-count').set(auth(pro1.token))).body.unread).toBe(0);
  });
});

describe('campaigns & auto messages', () => {
  it('previews audience and sends to a segment', async () => {
    const seg = { plan: 'paid', craft: 'Dancer', city: 'Chennai', inactiveDays: 0 };
    const a = await api().post('/api/v1/admin/engage/campaigns/audience').set(auth(admin.token)).send(seg);
    expect(a.body.audience).toBe(1);
    const c = await api().post('/api/v1/admin/engage/campaigns').set(auth(admin.token)).send({ title: 'Dance week', message: 'New dance auditions this week in Chennai!', channels: ['push', 'sms'], segment: seg, link: '/auditions', send: true });
    expect(c.body.campaign.status).toBe('sent');
    expect(c.body.campaign.delivered).toBe(1);
    const n = await api().get('/api/v1/notifications').set(auth(pro1.token));
    const item = n.body.items.find((x: { title: string }) => x.title === 'Dance week');
    expect(item).toBeTruthy();
    await api().post(`/api/v1/notifications/${item.id}/click`).set(auth(pro1.token));
    const row = await db.query.campaigns.findFirst({ where: eq(schema.campaigns.id, c.body.campaign.id) });
    expect(row!.clicked).toBe(1);
  });

  it('scheduled campaign is sent when due', async () => {
    const c = await api().post('/api/v1/admin/engage/campaigns').set(auth(admin.token)).send({ title: 'Later', message: 'Scheduled hello to all', segment: { plan: 'all', craft: 'all', city: 'Kochi' }, scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    expect(c.body.campaign.status).toBe('scheduled');
    await db.update(schema.campaigns).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(schema.campaigns.id, c.body.campaign.id));
    const l = await api().get('/api/v1/admin/engage/campaigns').set(auth(admin.token));
    expect(l.body.items.find((x: { id: string }) => x.id === c.body.campaign.id).status).toBe('sent');
  });

  it('switching a rule off stops its messages', async () => {
    const r = await api().patch('/api/v1/admin/engage/rules/shortlisted').set(auth(admin.token)).send({ enabled: false, template: 'Shortlisted for {role}!' });
    expect(r.body.rule.enabled).toBe(false);
    const { notifyRule } = await import('../src/lib/notify');
    expect(await notifyRule('shortlisted', free.user.id, { role: 'x' })).toBe(0);
    await api().patch('/api/v1/admin/engage/rules/shortlisted').set(auth(admin.token)).send({ enabled: true });
  });

  it('saves home page content', async () => {
    const r = await api().put('/api/v1/admin/engage/home').set(auth(admin.token)).send({ hero: { title: 'Get cast today' }, banners: [{ id: 'b1', title: 'Diwali offer', audience: 'free', active: true }] });
    expect(r.body.hero.title).toBe('Get cast today');
    expect(r.body.hero.subtitle).toBeTruthy(); // merged, not replaced
  });
});

describe('support', () => {
  it('member opens ticket, admin replies with {name}, internal notes hidden', async () => {
    const t = await api().post('/api/v1/support/tickets').set(auth(free.token)).send({ subject: 'Payment not reflected', category: 'Payments & plans', text: 'I paid ₹99 but still see Free plan.' });
    expect(t.status).toBe(201);
    expect(t.body.ticket.priority).toBe('high');
    await api().post(`/api/v1/admin/support/tickets/${t.body.ticket.id}/reply`).set(auth(admin.token)).send({ text: 'Checked Razorpay, refund pending', internal: true });
    await api().post(`/api/v1/admin/support/tickets/${t.body.ticket.id}/reply`).set(auth(admin.token)).send({ text: 'Hi {name}, fixed it!' });
    const m = await api().get(`/api/v1/support/tickets/${t.body.ticket.id}`).set(auth(free.token));
    expect(m.body.messages).toHaveLength(2);
    expect(m.body.messages[1].text).toBe('Hi Chat, fixed it!');
    expect(m.body.ticket.status).toBe('pending');
    const list = await api().get('/api/v1/admin/support/tickets?status=open,pending').set(auth(admin.token));
    expect(list.body.items.find((x: { id: string }) => x.id === t.body.ticket.id).assignee.name).toBe(admin.admin.name);
    expect((await api().get('/api/v1/admin/support/canned').set(auth(admin.token))).body.items.length).toBeGreaterThan(3);
  });
});

describe('Pro chat', () => {
  let convId = '';
  it('Free members cannot start chats', async () => {
    expect((await api().post('/api/v1/chat/start').set(auth(free.token)).send({ code: pro1.user.code })).status).toBe(402);
  });

  it('Pro starts chat, sends, other reads, unread counts', async () => {
    const s = await api().post('/api/v1/chat/start').set(auth(pro1.token)).send({ code: pro2.user.code });
    convId = s.body.conversation.id;
    const again = await api().post('/api/v1/chat/start').set(auth(pro2.token)).send({ code: pro1.user.code });
    expect(again.body.conversation.id).toBe(convId);
    expect((await api().post(`/api/v1/chat/${convId}/messages`).set(auth(pro1.token)).send({ text: 'Hi! Loved your reel.' })).status).toBe(201);
    expect((await api().get('/api/v1/chat/unread-count').set(auth(pro2.token))).body.unread).toBe(1);
    const list = await api().get('/api/v1/chat').set(auth(pro2.token));
    expect(list.body.items[0].lastMessage.text).toBe('Hi! Loved your reel.');
    await api().post(`/api/v1/chat/${convId}/read`).set(auth(pro2.token));
    expect((await api().get('/api/v1/chat/unread-count').set(auth(pro2.token))).body.unread).toBe(0);
  });

  it('blocks phone numbers, flags money words', async () => {
    expect((await api().post(`/api/v1/chat/${convId}/messages`).set(auth(pro1.token)).send({ text: 'call me 98765 43210' })).status).toBe(400);
    const f = await api().post(`/api/v1/chat/${convId}/messages`).set(auth(pro1.token)).send({ text: 'Pay the registration fee first' });
    expect(f.body.warning).toBeTruthy();
    const fm = await api().get('/api/v1/admin/moderation/flagged-messages').set(auth(admin.token));
    expect(fm.body.items.some((m: { text: string }) => m.text === 'Pay the registration fee first')).toBe(true);
  });

  it('chat report → admin mutes the sender', async () => {
    const r = await api().post(`/api/v1/chat/${convId}/report`).set(auth(pro2.token)).send({ reason: 'Asking for money' });
    expect(r.status).toBe(201);
    const one = await api().get(`/api/v1/admin/moderation/chat-reports/${r.body.report.id}`).set(auth(admin.token));
    expect(one.body.messages.length).toBeGreaterThan(0);
    await api().post(`/api/v1/admin/moderation/chat-reports/${r.body.report.id}/resolve`).set(auth(admin.token)).send({ action: 'mute', note: 'Asked for money', days: 3 });
    expect((await api().post(`/api/v1/chat/${convId}/messages`).set(auth(pro1.token)).send({ text: 'hello?' })).status).toBe(403);
  });

  it('blocked members cannot message', async () => {
    const p3 = await loginMember(); await giveProTo(p3.user.id);
    await api().post(`/api/v1/talent/${p3.user.code}/block`).set(auth(pro2.token));
    expect((await api().post('/api/v1/chat/start').set(auth(p3.token)).send({ code: pro2.user.code })).status).toBe(403);
  });
});

describe('community & reports', () => {
  it('posts, likes, comments; video is Pro only', async () => {
    const p = await api().post('/api/v1/posts').set(auth(free.token)).send({ text: 'First day on set!' });
    expect(p.status).toBe(201);
    const ph = await api().post('/api/v1/posts').set(auth(free.token)).field('text', 'Headshot').attach('file', JPG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(ph.body.post.type).toBe('PHOTO');
    expect((await api().post('/api/v1/posts?kind=video').set(auth(free.token)).attach('file', JPG, { filename: 'a.mp4', contentType: 'video/mp4' })).status).toBe(402);
    expect((await api().post(`/api/v1/posts/${p.body.post.id}/like`).set(auth(pro2.token))).body.likes).toBe(1);
    await api().post(`/api/v1/posts/${p.body.post.id}/like`).set(auth(pro2.token));
    const c = await api().post(`/api/v1/posts/${p.body.post.id}/comments`).set(auth(pro2.token)).send({ text: 'Congrats!' });
    expect(c.status).toBe(201);
    const d = await api().get(`/api/v1/posts/${p.body.post.id}`);
    expect(d.body.post.likes).toBe(1);
    expect(d.body.comments).toHaveLength(1);
    const feed = await api().get(`/api/v1/posts?user=${free.user.code}`);
    expect(feed.body.items.length).toBe(2);
  });

  it('3 reports auto-hide a post; moderator removes it and warns', async () => {
    const p = await api().post('/api/v1/posts').set(auth(free.token)).send({ text: 'Spam spam spam' });
    for (const m of [pro1, pro2, await loginMember()]) {
      expect((await api().post('/api/v1/reports').set(auth(m.token)).send({ targetType: 'post', targetId: p.body.post.id, reason: 'Spam' })).status).toBe(201);
    }
    expect((await api().post('/api/v1/reports').set(auth(pro1.token)).send({ targetType: 'post', targetId: p.body.post.id, reason: 'Spam' })).status).toBe(409);
    expect((await api().get(`/api/v1/posts/${p.body.post.id}`)).status).toBe(404);
    const list = await api().get('/api/v1/admin/moderation/reports').set(auth(admin.token));
    const rep = list.body.items.find((r: { targetId: string }) => r.targetId === p.body.post.id);
    expect(rep.timesReported).toBe(3);
    const res = await api().post(`/api/v1/admin/moderation/reports/${rep.id}/resolve`).set(auth(admin.token)).send({ action: 'remove', note: 'Spam is not allowed' });
    expect(res.body.closed).toBe(3);
    const post = await db.query.posts.findFirst({ where: eq(schema.posts.id, p.body.post.id) });
    expect(post!.status).toBe('REMOVED');
  });

  it('urgent priority for scam reports on a member', async () => {
    const r = await api().post('/api/v1/reports').set(auth(pro1.token)).send({ targetType: 'user', targetId: free.user.code, reason: 'Scam or fraud', details: 'Asked me for money' });
    expect(r.status).toBe(201);
    const s = await api().get('/api/v1/admin/moderation/stats').set(auth(admin.token));
    expect(s.body.reports.urgent).toBeGreaterThanOrEqual(1);
  });

  it('content queue: flagged posts can be approved', async () => {
    const p = await api().post('/api/v1/posts').set(auth(pro2.token)).send({ text: 'DM me, gpay accepted' });
    const q = await api().get('/api/v1/admin/moderation/content?flagged=true').set(auth(admin.token));
    expect(q.body.items.some((x: { id: string }) => x.id === p.body.post.id)).toBe(true);
    const a = await api().post(`/api/v1/admin/moderation/content/${p.body.post.id}`).set(auth(admin.token)).send({ action: 'hide', userAction: 'warn', reason: 'Payments outside the app' });
    expect(a.body.post.status).toBe('HIDDEN');
  });
});
