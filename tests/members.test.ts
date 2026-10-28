import { describe, expect, it, beforeAll } from 'vitest';
import { api, auth, loginAdmin, loginMember, TEST_PASSWORD } from './helpers';
import { db, schema } from '../src/db';
import { eq } from 'drizzle-orm';

const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946000101', 'hex'), Buffer.alloc(200, 1)]);
const PDF = Buffer.from('%PDF-1.4\n%fake\n'.padEnd(200, ' '));
const MP4 = Buffer.concat([Buffer.from('0000001866747970', 'hex'), Buffer.from('mp42'), Buffer.alloc(200, 0)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0)]);

let a: Awaited<ReturnType<typeof loginMember>>;
let b: Awaited<ReturnType<typeof loginMember>>;
let admin: Awaited<ReturnType<typeof loginAdmin>>;

beforeAll(async () => {
  a = await loginMember();
  b = await loginMember();
  admin = await loginAdmin();
  await api().patch('/api/v1/me').set(auth(a.token)).send({ name: 'Ravi Teja Test', gender: 'Male', city: 'Hyderabad', crafts: ['Actor'], languages: ['Telugu', 'Hindi'], dob: '1998-05-10', heightCm: 178, bio: 'Theatre actor' });
  await api().patch('/api/v1/me').set(auth(b.token)).send({ name: 'Meera Test', gender: 'Female', city: 'Mumbai', crafts: ['Model'], languages: ['Hindi'], dob: '2001-02-02' });
});

describe('my profile', () => {
  it('updates and returns profile with completion %', async () => {
    const r = await api().get('/api/v1/me').set(auth(a.token));
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe('Ravi Teja Test');
    expect(r.body.user.profileComplete).toBeGreaterThan(70);
  });

  it('requires a guardian for under-18 members', async () => {
    const kid = await loginMember();
    const dob = new Date(); dob.setFullYear(dob.getFullYear() - 12);
    const r = await api().patch('/api/v1/me').set(auth(kid.token)).send({ name: 'Child Artist', dob: dob.toISOString() });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/guardian/i);
    const ok = await api().patch('/api/v1/me').set(auth(kid.token)).send({ name: 'Child Artist', dob: dob.toISOString(), guardianName: 'Parent', guardianRelation: 'Mother', guardianPhone: '9123456780', guardianConsent: true });
    expect(ok.status).toBe(200);
    expect(ok.body.user.isMinor).toBe(true);
  });

  it('saves prefs and privacy, rejects unknown keys', async () => {
    expect((await api().patch('/api/v1/me/privacy').set(auth(a.token)).send({ showAge: false })).body.privacy.showAge).toBe(false);
    expect((await api().patch('/api/v1/me/prefs').set(auth(a.token)).send({ hack: true })).status).toBe(400);
    await api().patch('/api/v1/me/privacy').set(auth(a.token)).send({ showAge: true });
  });

  it('changes phone with an OTP', async () => {
    const m = await loginMember();
    const next = `97${String(Date.now()).slice(-8)}`;
    expect((await api().post('/api/v1/me/phone/send').set(auth(m.token)).send({ phone: next })).status).toBe(200);
    const v = await api().post('/api/v1/me/phone/verify').set(auth(m.token)).send({ phone: next, code: '123456' });
    expect(v.status).toBe(200);
    expect(v.body.user.phone).toBe(`+91${next}`);
  });
});

describe('uploads', () => {
  it('uploads avatar and gallery photos, blocks fake files', async () => {
    const av = await api().post('/api/v1/me/avatar').set(auth(a.token)).attach('file', JPG, { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(av.status).toBe(200);
    expect(av.body.avatarUrl).toMatch(/\/uploads\/avatars\/.+\.jpg$/);
    const p = await api().post('/api/v1/me/media/photo').set(auth(a.token)).field('caption', 'Headshot').attach('file', JPG, { filename: 'h.jpg', contentType: 'image/jpeg' });
    expect(p.status).toBe(201);
    const bad = await api().post('/api/v1/me/media/photo').set(auth(a.token)).attach('file', EXE, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(bad.status).toBe(400);
    const list = await api().get('/api/v1/me/media').set(auth(a.token));
    expect(list.body.items).toHaveLength(1);
    expect((await api().delete(`/api/v1/me/media/${p.body.item.id}`).set(auth(a.token))).status).toBe(200);
  });

  it('videos are Pro only', async () => {
    const r = await api().post('/api/v1/me/media/video').set(auth(a.token)).attach('file', MP4, { filename: 'v.mp4', contentType: 'video/mp4' });
    expect(r.status).toBe(402);
  });
});

describe('talent search, follow, block, views', () => {
  it('finds members by filters', async () => {
    const r = await api().get('/api/v1/talent?craft=Actor&city=Hyderabad&language=Telugu&ageMin=20&ageMax=35');
    expect(r.status).toBe(200);
    expect(r.body.items.some((u: { code: string }) => u.code === a.user.code)).toBe(true);
    expect(r.body.items[0].phone).toBeUndefined();
    const none = await api().get('/api/v1/talent?craft=Actor&city=Mumbai');
    expect(none.body.items.some((u: { code: string }) => u.code === a.user.code)).toBe(false);
  });

  it('hide from search works', async () => {
    await api().patch('/api/v1/me/privacy').set(auth(b.token)).send({ hideFromSearch: true });
    const r = await api().get('/api/v1/talent?q=Meera Test');
    expect(r.body.total).toBe(0);
    await api().patch('/api/v1/me/privacy').set(auth(b.token)).send({ hideFromSearch: false });
  });

  it('records a profile view once per day and Free sees only a count', async () => {
    await api().get(`/api/v1/talent/${a.user.code}`).set(auth(b.token));
    await api().get(`/api/v1/talent/${a.user.code}`).set(auth(b.token));
    const v = await api().get('/api/v1/me/views').set(auth(a.token));
    expect(v.body.last30Days).toBe(1);
    expect(v.body.locked).toBe(true);
    expect(v.body.items).toHaveLength(0);
  });

  it('follow and unfollow', async () => {
    expect((await api().post(`/api/v1/talent/${a.user.code}/follow`).set(auth(b.token))).body.following).toBe(true);
    const p = await api().get(`/api/v1/talent/${a.user.code}`).set(auth(b.token));
    expect(p.body.followers).toBe(1);
    expect(p.body.isFollowing).toBe(true);
    expect((await api().get(`/api/v1/talent/${a.user.code}/followers`)).body.items[0].code).toBe(b.user.code);
  });

  it('block hides profiles both ways and removes follows', async () => {
    await api().post(`/api/v1/talent/${b.user.code}/block`).set(auth(a.token));
    expect((await api().get(`/api/v1/talent/${a.user.code}`).set(auth(b.token))).status).toBe(404);
    const s = await api().get('/api/v1/talent?q=Ravi Teja Test').set(auth(b.token));
    expect(s.body.total).toBe(0);
    expect((await api().get(`/api/v1/talent/${a.user.code}`)).body.followers).toBe(0);
    expect((await api().get('/api/v1/me/blocks').set(auth(a.token))).body.items).toHaveLength(1);
    await api().delete(`/api/v1/talent/${b.user.code}/block`).set(auth(a.token));
    expect((await api().get(`/api/v1/talent/${a.user.code}`).set(auth(b.token))).status).toBe(200);
  });
});

describe('saved searches & referrals', () => {
  it('CRUD saved searches', async () => {
    const c = await api().post('/api/v1/me/saved-searches').set(auth(a.token)).send({ label: 'Telugu films', query: 'language=Telugu' });
    expect(c.status).toBe(201);
    expect((await api().patch(`/api/v1/me/saved-searches/${c.body.item.id}`).set(auth(a.token)).send({ alerts: false })).body.item.alerts).toBe(false);
    expect((await api().get('/api/v1/me/saved-searches').set(auth(a.token))).body.items).toHaveLength(1);
  });

  it('counts referrals', async () => {
    await loginMember(undefined, { referralCode: a.user.referralCode });
    const r = await api().get('/api/v1/me/referrals').set(auth(a.token));
    expect(r.body.joined).toBe(1);
    expect(r.body.link).toContain(a.user.referralCode);
  });
});

describe('verification', () => {
  it('member submits, admin approves, badge shows', async () => {
    const s = await api().post('/api/v1/me/verification').set(auth(a.token)).field('docType', 'Aadhaar')
      .attach('idFront', JPG, { filename: 'id.jpg', contentType: 'image/jpeg' })
      .attach('selfie', JPG, { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(s.status).toBe(201);
    expect(s.body.request.docs).toHaveLength(2);
    // ID files are private: the signed link works, the bare / tampered link does not
    const signed = new URL(s.body.request.docs[0].url);
    expect(signed.pathname).toContain('/uploads/kyc/');
    expect((await api().get(signed.pathname + signed.search)).status).toBe(200);
    expect((await api().get(signed.pathname)).status).toBe(403);
    expect((await api().get(signed.pathname + signed.search.replace(/sig=\w+/, 'sig=' + '0'.repeat(32)))).status).toBe(403);
    const adminView = await api().get(`/api/v1/admin/verification/${s.body.request.id}`).set(auth(admin.token));
    expect(adminView.body.request.docs[0].url).toContain('sig=');
    const again = await api().post('/api/v1/me/verification').set(auth(a.token)).field('docType', 'PAN').attach('idFront', PDF, { filename: 'id.pdf', contentType: 'application/pdf' }).attach('selfie', JPG, { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(again.status).toBe(409);
    const q = await api().get('/api/v1/admin/verification').set(auth(admin.token));
    expect(q.body.counts.pending).toBeGreaterThanOrEqual(1);
    const ok = await api().post(`/api/v1/admin/verification/${s.body.request.id}/approve`).set(auth(admin.token));
    expect(ok.status).toBe(200);
    expect((await api().get('/api/v1/me/verification').set(auth(a.token))).body.verified).toBe(true);
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, a.user.id));
    expect(n.some((x) => x.type === 'verification')).toBe(true);
  });

  it('reject needs a reason', async () => {
    const s = await api().post('/api/v1/me/verification').set(auth(b.token)).field('docType', 'PAN').attach('idFront', PDF, { filename: 'id.pdf', contentType: 'application/pdf' }).attach('selfie', JPG, { filename: 's.jpg', contentType: 'image/jpeg' });
    expect((await api().post(`/api/v1/admin/verification/${s.body.request.id}/reject`).set(auth(admin.token)).send({})).status).toBe(400);
    expect((await api().post(`/api/v1/admin/verification/${s.body.request.id}/reject`).set(auth(admin.token)).send({ reason: 'Photo of ID is blurry' })).body.request.status).toBe('REJECTED');
  });
});

describe('admin users', () => {
  it('lists with masked phones; reveal is audited', async () => {
    const l = await api().get(`/api/v1/admin/users?q=${a.user.code}`).set(auth(admin.token));
    expect(l.body.items[0].phoneMasked).toContain('•');
    const p = await api().get(`/api/v1/admin/users/${a.user.id}/phone`).set(auth(admin.token));
    expect(p.body.phone).toBe(a.user.phone);
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'Viewed phone number'));
    expect(logs.length).toBeGreaterThan(0);
  });

  it('gives Pro, then Pro sees who viewed', async () => {
    const r = await api().post(`/api/v1/admin/users/${a.user.id}/plan`).set(auth(admin.token)).send({ planId: 'pro', days: 30, note: 'Launch gift' });
    expect(r.body.user.plan.isPaid).toBe(true);
    const v = await api().get('/api/v1/me/views').set(auth(a.token));
    expect(v.body.locked).toBe(false);
    expect(v.body.items.some((x: { viewer: { code?: string } }) => x.viewer.code === b.user.code)).toBe(true);
  });

  it('suspend logs the member out and blocks access; reactivate restores', async () => {
    const m = await loginMember();
    expect((await api().post(`/api/v1/admin/users/${m.user.id}/suspend`).set(auth(admin.token)).send({ days: 3, reason: 'Spam messages' })).status).toBe(200);
    expect((await api().get('/api/v1/me').set(auth(m.token))).status).toBe(403);
    await api().post(`/api/v1/admin/users/${m.user.id}/reactivate`).set(auth(admin.token));
    expect((await api().get('/api/v1/me').set(auth(m.token))).status).toBe(200);
  });

  it('finds duplicates and can dismiss them', async () => {
    const d1 = await loginMember(); const d2 = await loginMember();
    await api().patch('/api/v1/me').set(auth(d1.token)).send({ name: 'Same Person' });
    await api().patch('/api/v1/me').set(auth(d2.token)).send({ name: 'same person ' });
    const g = await api().get('/api/v1/admin/users/duplicates').set(auth(admin.token));
    const grp = g.body.items.find((x: { key: string }) => x.key === 'name:same person');
    expect(grp.users).toHaveLength(2);
    await api().post('/api/v1/admin/users/duplicates/dismiss').set(auth(admin.token)).send({ key: grp.key });
    const g2 = await api().get('/api/v1/admin/users/duplicates').set(auth(admin.token));
    expect(g2.body.items.find((x: { key: string }) => x.key === 'name:same person')).toBeUndefined();
  });
});

describe('data requests', () => {
  it('export request → admin downloads JSON', async () => {
    const r = await api().post('/api/v1/me/data-requests').set(auth(a.token)).send({ type: 'export' });
    expect(r.status).toBe(201);
    const ex = await api().get(`/api/v1/admin/data-requests/${r.body.item.id}/export`).set(auth(admin.token));
    expect(ex.body.account.code).toBe(a.user.code);
    expect((await api().post(`/api/v1/admin/data-requests/${r.body.item.id}/complete`).set(auth(admin.token))).body.item.status).toBe('done');
  });

  it('member can download only after admin approves', async () => {
    const m = await loginMember();
    const r = await api().post('/api/v1/me/data-requests').set(auth(m.token)).send({ type: 'export' });
    const dl = `/api/v1/me/data-requests/${r.body.item.id}/download`;
    expect((await api().get(dl).set(auth(m.token))).status).toBe(403);
    expect((await api().post('/api/v1/me/data-requests').set(auth(m.token)).send({ type: 'export' })).status).toBe(409);
    await api().post(`/api/v1/admin/data-requests/${r.body.item.id}/complete`).set(auth(admin.token));
    const ok = await api().get(dl).set(auth(m.token));
    expect(ok.status).toBe(200);
    expect(ok.body.account.code).toBe(m.user.code);
    expect((await api().get(dl).set(auth(a.token))).status).toBe(404); // someone else's request
    expect((await api().post('/api/v1/me/data-requests').set(auth(m.token)).send({ type: 'export' })).status).toBe(409); // already ready
    await db.update(schema.dataRequests).set({ handledAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(schema.dataRequests.id, r.body.item.id));
    expect((await api().get(dl).set(auth(m.token))).status).toBe(403); // expired
    expect((await api().post('/api/v1/me/data-requests').set(auth(m.token)).send({ type: 'export' })).status).toBe(201);
  });

  it('delete request: logging in again cancels it', async () => {
    const m = await loginMember();
    await api().delete('/api/v1/me').set(auth(m.token));
    expect((await api().get('/api/v1/me').set(auth(m.token))).status).toBe(200); // access token still valid until expiry
    expect((await api().post('/api/v1/auth/login').send({ identifier: m.phone, password: TEST_PASSWORD })).status).toBe(200);
    const items = (await api().get('/api/v1/me/data-requests').set(auth(m.token))).body.items;
    expect(items[0].status).toBe('cancelled');
  });

  it('admin completes delete → personal data removed, login refused', async () => {
    const m = await loginMember();
    await api().patch('/api/v1/me').set(auth(m.token)).send({ name: 'To Be Deleted' });
    const r = await api().post('/api/v1/me/data-requests').set(auth(m.token)).send({ type: 'delete' });
    await api().post(`/api/v1/admin/data-requests/${r.body.item.id}/complete`).set(auth(admin.token));
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, m.user.id) });
    expect(u!.status).toBe('DELETED');
    expect(u!.name).toBe('Deleted member');
    expect((await api().get('/api/v1/me').set(auth(m.token))).status).toBe(401);
  });
});

describe('admin members extras', () => {
  it('list never sends full phone numbers; filters by language / age', async () => {
    const admin = await loginAdmin();
    const m = await loginMember();
    await api().patch('/api/v1/me').set(auth(m.token)).send({ name: 'Lang Tester', languages: ['Kannada'], dob: '2000-05-01', heightCm: 170 });
    const r = await api().get('/api/v1/admin/users').set(auth(admin.token)).query({ language: 'Kannada', ageMin: 20, ageMax: 30, heightMin: 160 });
    expect(r.status).toBe(200);
    expect(r.body.items.some((u: { id: string }) => u.id === m.user.id)).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(m.phone);
    expect(r.body.items[0].phone).toBeUndefined();
    const stats = await api().get('/api/v1/admin/users/stats').set(auth(admin.token));
    expect(stats.body).toHaveProperty('expiring');
    expect(stats.body).toHaveProperty('revenue');
  });

  it('talent lists, message, and delete account', async () => {
    const admin = await loginAdmin();
    const m = await loginMember();
    const l = await api().post('/api/v1/admin/users/lists').set(auth(admin.token)).send({ name: 'Mothers 40+', userIds: [m.user.id] });
    expect(l.status).toBe(201);
    const p = await api().patch(`/api/v1/admin/users/lists/${l.body.item.id}`).set(auth(admin.token)).send({ remove: [m.user.id] });
    expect(p.body.item.userIds).toEqual([]);
    expect((await api().delete(`/api/v1/admin/users/lists/${l.body.item.id}`).set(auth(admin.token))).status).toBe(200);
    expect((await api().post(`/api/v1/admin/users/${m.user.id}/message`).set(auth(admin.token)).send({ message: 'Please add photos' })).status).toBe(200);
    const d = await api().get(`/api/v1/admin/users/${m.user.id}`).set(auth(admin.token));
    expect(d.body).toHaveProperty('recentApplications');
    expect(d.body.activity.some((a: { action: string }) => a.action.startsWith('Sent a message'))).toBe(true);
    expect((await api().delete(`/api/v1/admin/users/${m.user.id}`).set(auth(admin.token))).status).toBe(200);
    expect((await api().get('/api/v1/me').set(auth(m.token))).status).toBe(401);
  });

  it('admin image upload', async () => {
    const admin = await loginAdmin();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5ff0000000049454e44ae426082', 'hex');
    const r = await api().post('/api/v1/admin/uploads/posters').set(auth(admin.token)).attach('file', png, { filename: 'p.png', contentType: 'image/png' });
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/\/uploads\/admin\/posters\/.+\.png$/);
    expect((await api().post('/api/v1/admin/uploads/other').set(auth(admin.token)).attach('file', png, 'p.png')).status).toBe(400);
  });
});

describe('home showcase', () => {
  it('shows newest adult members with a photo, never minors or hidden profiles', async () => {
    const adult = await loginMember(undefined, { name: 'Showcase Adult' });
    const minor = await loginMember(undefined, { name: 'Showcase Minor' });
    const hidden = await loginMember(undefined, { name: 'Showcase Hidden' });
    await db.update(schema.users).set({ avatarUrl: 'http://localhost:4000/uploads/avatars/a.jpg' }).where(eq(schema.users.id, adult.user.id));
    await db.update(schema.users).set({ avatarUrl: 'http://localhost:4000/uploads/avatars/b.jpg', isMinor: true }).where(eq(schema.users.id, minor.user.id));
    await db.update(schema.users).set({ avatarUrl: 'http://localhost:4000/uploads/avatars/c.jpg', privacy: { hideFromSearch: true } }).where(eq(schema.users.id, hidden.user.id));
    const r = await api().get('/api/v1/talent/showcase');
    expect(r.status).toBe(200);
    const codes = [r.body.shortlisted?.code, ...r.body.latest.map((u: { code: string }) => u.code)];
    expect(codes).toContain(adult.user.code);
    expect(codes).not.toContain(minor.user.code);
    expect(codes).not.toContain(hidden.user.code);
    expect(JSON.stringify(r.body)).not.toMatch(/phone|passwordHash/);
  });
});
