import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { api, auth, loginAdmin, loginMember } from './helpers';
import { db, schema } from '../src/db';

let admin: Awaited<ReturnType<typeof loginAdmin>>;
let pro: Awaited<ReturnType<typeof loginMember>>;
let free1: Awaited<ReturnType<typeof loginMember>>;
let free2: Awaited<ReturnType<typeof loginMember>>;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const base = {
  title: 'Lead actor for Telugu feature film',
  production: 'Arclight Productions',
  projectType: 'Feature Film',
  description: 'A coming-of-age drama shot in Hyderabad over 30 days. Looking for fresh faces.',
  location: 'Hyderabad',
  languages: ['Telugu'],
  budget: '₹10,000 / day',
  deadline: inDays(10),
  roles: [{ name: 'Raghav (lead)', gender: 'Male', ageMin: 20, ageMax: 30 }, { name: 'Meera', gender: 'Female', ageMin: 18, ageMax: 28 }],
};

async function profile(token: string, p: Record<string, unknown>) {
  const r = await api().patch('/api/v1/me').set(auth(token)).send(p);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
}

beforeAll(async () => {
  admin = await loginAdmin();
  pro = await loginMember();
  free1 = await loginMember();
  free2 = await loginMember();
  await profile(pro.token, { name: 'Pro Poster', city: 'Hyderabad', gender: 'Male', dob: '1990-01-01' });
  await profile(free1.token, { name: 'Free Actor One', city: 'Hyderabad', gender: 'Male', dob: '1999-01-01' });
  await profile(free2.token, { name: 'Free Actress', city: 'Hyderabad', gender: 'Female', dob: '2002-01-01' });
  await api().post(`/api/v1/admin/users/${pro.user.id}/plan`).set(auth(admin.token)).send({ planId: 'pro', days: 30 });
});

describe('admin castings', () => {
  let id = '';
  let code = '';

  it('creates live casting with roles and alerts matching members', async () => {
    const r = await api().post('/api/v1/admin/castings').set(auth(admin.token)).send({ ...base, status: 'LIVE' });
    expect(r.status).toBe(201);
    expect(r.body.casting.code).toMatch(/^CH-\d+/);
    expect(r.body.casting.roles).toHaveLength(2);
    expect(r.body.alerted).toBeGreaterThanOrEqual(2);
    id = r.body.casting.id; code = r.body.casting.code;
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, free1.user.id));
    expect(n.some((x) => x.type === 'casting_match')).toBe(true);
  });

  it('blocks castings asking for money', async () => {
    const r = await api().post('/api/v1/admin/castings').set(auth(admin.token)).send({ ...base, description: 'Selected candidates must pay a registration fee of ₹2,000 to confirm.' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/registration fee/);
  });

  it('public list & detail, filters by gender/age', async () => {
    const l = await api().get('/api/v1/castings?city=Hyderabad');
    expect(l.body.items.some((c: { code: string }) => c.code === code)).toBe(true);
    const old = await api().get('/api/v1/castings?gender=Male&age=50');
    expect(old.body.items.some((c: { code: string }) => c.code === code)).toBe(false);
    const d = await api().get(`/api/v1/castings/${code}`).set(auth(free1.token));
    expect(d.body.casting.roles).toHaveLength(2);
    expect(d.body.applicationsThisMonth.max).toBe(5);
  });

  it('member applies, duplicate refused, wrong gender refused', async () => {
    const roles = (await api().get(`/api/v1/castings/${code}`)).body.casting.roles;
    const ok = await api().post(`/api/v1/castings/${code}/apply`).set(auth(free1.token)).send({ roleId: roles[0].id, note: 'I did theatre for 3 years', tapeUrl: 'https://youtu.be/abc' });
    expect(ok.status).toBe(201);
    expect((await api().post(`/api/v1/castings/${code}/apply`).set(auth(free1.token)).send({ roleId: roles[0].id })).status).toBe(409);
    expect((await api().post(`/api/v1/castings/${code}/apply`).set(auth(free2.token)).send({ roleId: roles[0].id })).status).toBe(400);
    expect((await api().post(`/api/v1/castings/${code}/apply`).set(auth(free2.token)).send({ roleId: roles[1].id })).status).toBe(201);
    const mine = await api().get('/api/v1/applications').set(auth(free1.token));
    expect(mine.body.items[0].casting.code).toBe(code);
    expect(mine.body.applicationsThisMonth.used).toBe(1);
  });

  it('pipeline: view marks VIEWED, shortlist notifies, phones masked for admin', async () => {
    const l = await api().get(`/api/v1/admin/castings/${id}/applicants`).set(auth(admin.token));
    expect(l.body.total).toBe(2);
    expect(l.body.items[0].phone).toBeNull();
    expect(l.body.items[0].phoneMasked).toContain('•');
    const appId = l.body.items.find((a: { talent: { code: string } }) => a.talent.code === free1.user.code).id;
    const one = await api().get(`/api/v1/admin/castings/${id}/applicants/${appId}`).set(auth(admin.token));
    expect(one.body.applicant.status).toBe('VIEWED');
    const s = await api().patch(`/api/v1/admin/castings/${id}/applicants/${appId}`).set(auth(admin.token)).send({ status: 'SHORTLISTED', rating: 4 });
    expect(s.body.applicant.status).toBe('SHORTLISTED');
    expect(s.body.applicant.rating).toBe(4);
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, free1.user.id));
    expect(n.some((x) => x.type === 'shortlisted')).toBe(true);
    expect((await api().post(`/api/v1/admin/castings/${id}/applicants/${appId}/notes`).set(auth(admin.token)).send({ text: 'Strong screen presence' })).status).toBe(201);
  });

  it('round 2: invite, audition day, member books a slot', async () => {
    const l = await api().get(`/api/v1/admin/castings/${id}/applicants?status=SHORTLISTED`).set(auth(admin.token));
    const appId = l.body.items[0].id;
    expect((await api().post(`/api/v1/admin/castings/${id}/round2`).set(auth(admin.token)).send({ ids: [appId], date: inDays(3), venue: 'Studio 5, Jubilee Hills' })).body.invited).toBe(1);
    const day = await api().post(`/api/v1/admin/castings/${id}/days`).set(auth(admin.token)).send({ title: 'Round 2', date: inDays(3).slice(0, 10), start: '10:00', end: '12:00', slotMins: 20, breakStart: '11:00', breakEnd: '11:20', venue: 'Studio 5' });
    expect(day.status).toBe(201);
    expect(day.body.slots).toBe(5);
    const slots = await api().get(`/api/v1/applications/${appId}/slots`).set(auth(free1.token));
    const first = slots.body.days[0].slots[0];
    expect(first.free).toBe(true);
    const b = await api().post(`/api/v1/applications/${appId}/book`).set(auth(free1.token)).send({ slotId: first.id });
    expect(b.status).toBe(200);
    const days = await api().get(`/api/v1/admin/castings/${id}/days`).set(auth(admin.token));
    expect(days.body.days[0].slots[0].talent.code).toBe(free1.user.code);
    expect((await api().post(`/api/v1/admin/castings/${id}/days/${days.body.days[0].id}/remind`).set(auth(admin.token))).body.sent).toBe(1);
  });

  it('a booked slot is locked: no switching or cancelling; change request → team releases → rebook', async () => {
    const l = await api().get(`/api/v1/admin/castings/${id}/applicants?status=ROUND2`).set(auth(admin.token));
    const appId = l.body.items[0].id;
    const slots = (await api().get(`/api/v1/applications/${appId}/slots`).set(auth(free1.token))).body.days[0].slots;
    const other = slots.find((x: { free: boolean }) => x.free);
    const sw = await api().post(`/api/v1/applications/${appId}/book`).set(auth(free1.token)).send({ slotId: other.id });
    expect(sw.status).toBe(409);
    expect(sw.body.error.message).toMatch(/already confirmed/);
    expect((await api().delete(`/api/v1/applications/${appId}/book`).set(auth(free1.token))).status).toBe(403);
    expect((await api().post(`/api/v1/applications/${appId}/slot-change`).set(auth(free1.token)).send({ reason: 'no' })).status).toBe(400);
    expect((await api().post(`/api/v1/applications/${appId}/slot-change`).set(auth(free1.token)).send({ reason: 'Exam on that morning' })).status).toBe(200);
    expect((await api().post(`/api/v1/applications/${appId}/slot-change`).set(auth(free1.token)).send({ reason: 'Asking again please' })).status).toBe(409);
    const days = (await api().get(`/api/v1/admin/castings/${id}/days`).set(auth(admin.token))).body;
    expect(days.changeRequests).toBe(1);
    const mineSlot = days.days[0].slots.find((x: { applicationId: string | null }) => x.applicationId === appId);
    expect(mineSlot.changeRequest).toBe('Exam on that morning');
    // Team releases it → applicant is told and can book again
    await api().patch(`/api/v1/admin/castings/${id}/days/${days.days[0].id}/slots/${mineSlot.id}`).set(auth(admin.token)).send({ applicationId: null });
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, free1.user.id));
    expect(n.some((x) => /change request was accepted/.test(x.body))).toBe(true);
    expect((await api().post(`/api/v1/applications/${appId}/book`).set(auth(free1.token)).send({ slotId: other.id })).status).toBe(200);
  });

  it('client share link with passcode and feedback', async () => {
    const cl = await api().post('/api/v1/admin/clients').set(auth(admin.token)).send({ company: 'Arclight Productions', contactName: 'Vikram Rao', email: 'vikram@arclight.in' });
    expect(cl.status).toBe(201);
    const apps = (await api().get(`/api/v1/admin/castings/${id}/applicants`).set(auth(admin.token))).body.items;
    const sh = await api().post(`/api/v1/admin/castings/${id}/shares`).set(auth(admin.token)).send({ clientId: cl.body.item.id, title: 'Round 1 picks', applicationIds: apps.map((a: { id: string }) => a.id), passcode: '4321' });
    expect(sh.status).toBe(201);
    const token = sh.body.share.token;
    expect((await api().get(`/api/v1/share/${token}`)).status).toBe(401);
    const v = await api().get(`/api/v1/share/${token}`).set('x-share-passcode', '4321');
    expect(v.body.talents).toHaveLength(2);
    expect(JSON.stringify(v.body)).not.toContain('+91');
    const f = await api().post(`/api/v1/share/${token}/feedback`).set('x-share-passcode', '4321').send({ items: [{ applicationId: apps[0].id, pick: 'yes', comment: 'Lock him' }], submit: true });
    expect(f.body.submitted).toBe(true);
    const list = await api().get(`/api/v1/admin/castings/${id}/shares`).set(auth(admin.token));
    expect(list.body.items[0].picks.yes).toBe(1);
    await api().patch(`/api/v1/admin/castings/${id}/shares/${sh.body.share.id}`).set(auth(admin.token)).send({ revoke: true });
    expect((await api().get(`/api/v1/share/${token}`).set('x-share-passcode', '4321')).status).toBe(403);
  });

  it('schedule across castings, all share links, invite to apply', async () => {
    const days = await api().get('/api/v1/admin/castings/schedule/days').set(auth(admin.token));
    expect(days.status).toBe(200);
    const d = days.body.items.find((x: { castingId: string }) => x.castingId === id);
    expect(d.casting.code).toBe(code);
    expect(d.slots).toBeGreaterThan(0);
    expect(d.booked).toBe(1);
    const shares = await api().get('/api/v1/admin/castings/shares/all').set(auth(admin.token));
    expect(shares.status).toBe(200);
    const s = shares.body.items.find((x: { castingId: string }) => x.castingId === id);
    expect(s.talents.length).toBeGreaterThan(0);
    expect(s.passcodeHash).toBeUndefined();
    expect(JSON.stringify(s.talents)).not.toContain(free1.phone);
    const extra = await loginMember();
    const inv = await api().post(`/api/v1/admin/castings/${id}/invite`).set(auth(admin.token)).send({ userIds: [extra.user.id, free1.user.id] });
    expect(inv.body).toEqual({ invited: 1, skipped: 1 });
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, extra.user.id));
    expect(n.some((x) => x.type === 'casting_invite' && x.link === `/casting-calls/${code}`)).toBe(true);
  });

  it('list tabs count each status', async () => {
    const r = await api().get('/api/v1/admin/castings').set(auth(admin.token)).query({ status: 'LIVE', visibility: 'ALL' });
    expect(r.body.tabs.live).toBeGreaterThan(0);
    expect(r.body.tabs).toHaveProperty('scheduled');
    expect(r.body.tabs).toHaveProperty('archived');
    expect(r.body.items.every((c: { status: string; visibility: string }) => c.status === 'LIVE' && c.visibility === 'ALL')).toBe(true);
  });

  it('CSV export', async () => {
    const r = await api().get(`/api/v1/admin/castings/${id}/applicants.csv`).set(auth(admin.token));
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('Free Actor One');
  });
});

describe('Pro member castings', () => {
  let mcId = '';
  let mcCode = '';

  it('Free members cannot post', async () => {
    expect((await api().post('/api/v1/my-castings').set(auth(free1.token)).send(base)).status).toBe(402);
  });

  it('blocks phone numbers and money words in member posts', async () => {
    expect((await api().post('/api/v1/my-castings').set(auth(pro.token)).send({ ...base, description: 'Call me on 98765 43210 for details about the shoot please.' })).status).toBe(400);
    expect((await api().post('/api/v1/my-castings').set(auth(pro.token)).send({ ...base, budget: 'Pay first ₹500' })).status).toBe(400);
  });

  it('Pro posts → PENDING, hidden from public until approved', async () => {
    const r = await api().post('/api/v1/my-castings').set(auth(pro.token)).send({ ...base, title: 'Dancers for indie music video', projectType: 'Music Video' });
    expect(r.status).toBe(201);
    expect(r.body.casting.status).toBe('PENDING');
    expect(r.body.casting.code).toMatch(/^MC-/);
    mcId = r.body.casting.id; mcCode = r.body.casting.code;
    expect((await api().get(`/api/v1/castings/${mcCode}`)).status).toBe(404);
    expect((await api().get(`/api/v1/my-castings/${mcId}/applicants`).set(auth(pro.token))).status).toBe(400);
    const q = await api().get('/api/v1/admin/castings?status=PENDING&source=member').set(auth(admin.token));
    expect(q.body.items.some((c: { id: string }) => c.id === mcId)).toBe(true);
  });

  it('admin asks for changes, member edits and resubmits, admin approves', async () => {
    await api().post(`/api/v1/admin/castings/${mcId}/request-changes`).set(auth(admin.token)).send({ note: 'Add the shoot date' });
    const m = await api().get(`/api/v1/my-castings/${mcId}`).set(auth(pro.token));
    expect(m.body.casting.status).toBe('CHANGES');
    expect(m.body.casting.reviewNote).toBe('Add the shoot date');
    const e = await api().patch(`/api/v1/my-castings/${mcId}`).set(auth(pro.token)).send({ ...base, title: 'Dancers for indie music video', projectType: 'Music Video', description: `${base.description} Shoot on 15 November.` });
    expect(e.body.casting.status).toBe('PENDING');
    const a = await api().post(`/api/v1/admin/castings/${mcId}/approve`).set(auth(admin.token)).send({});
    expect(a.body.casting.status).toBe('LIVE');
    expect((await api().get(`/api/v1/castings/${mcCode}`)).body.casting.postedBy).toBe('member');
  });

  it('poster cannot apply to own casting; others can', async () => {
    const roles = (await api().get(`/api/v1/castings/${mcCode}`)).body.casting.roles;
    expect((await api().post(`/api/v1/castings/${mcCode}/apply`).set(auth(pro.token)).send({ roleId: roles[0].id })).status).toBe(400);
    expect((await api().post(`/api/v1/castings/${mcCode}/apply`).set(auth(free1.token)).send({ roleId: roles[0].id })).status).toBe(201);
  });

  it('poster sees phone only after selecting', async () => {
    const l = await api().get(`/api/v1/my-castings/${mcId}/applicants`).set(auth(pro.token));
    const app = l.body.items[0];
    expect(app.phone).toBeNull();
    const s = await api().patch(`/api/v1/my-castings/${mcId}/applicants/${app.id}`).set(auth(pro.token)).send({ status: 'SELECTED' });
    expect(s.body.applicant.phone).toBe(free1.user.phone);
    // Admin notes never reach member posters.
    await api().post(`/api/v1/admin/castings/${mcId}/applicants/${app.id}/notes`).set(auth(admin.token)).send({ text: 'internal only' });
    const one = await api().get(`/api/v1/my-castings/${mcId}/applicants/${app.id}`).set(auth(pro.token));
    expect(one.body.notes.some((n: { text: string }) => n.text === 'internal only')).toBe(false);
  });

  it('another member cannot manage this casting', async () => {
    expect((await api().get(`/api/v1/my-castings/${mcId}/applicants`).set(auth(free2.token))).status).toBe(404);
  });

  it('Pro poster schedules time slots for their own casting; applicant books; poster gets change requests', async () => {
    const day = await api().post(`/api/v1/my-castings/${mcId}/days`).set(auth(pro.token)).send({ title: 'Dance round', date: inDays(4).slice(0, 10), start: '15:00', end: '16:00', slotMins: 15, venue: 'Studio 9, Madhapur' });
    expect(day.status).toBe(201);
    expect(day.body.slots).toBe(4);
    expect((await api().get(`/api/v1/my-castings/${mcId}/days`).set(auth(free2.token))).status).toBe(404);
    const roles = (await api().get(`/api/v1/castings/${mcCode}`)).body.casting.roles;
    await profile(free2.token, { name: 'Second Dancer', gender: 'Male', dob: '1999-02-02' });
    const ap = await api().post(`/api/v1/castings/${mcCode}/apply`).set(auth(free2.token)).send({ roleId: roles[0].id });
    expect(ap.status).toBe(201);
    const app = { id: ap.body.application.id as string };
    const r2 = await api().post(`/api/v1/my-castings/${mcId}/round2`).set(auth(pro.token)).send({ ids: [app.id], date: inDays(4), venue: 'Studio 9, Madhapur' });
    expect(r2.body.invited, JSON.stringify(r2.body)).toBe(1);
    const slots = (await api().get(`/api/v1/applications/${app.id}/slots`).set(auth(free2.token))).body.days[0].slots;
    expect((await api().post(`/api/v1/applications/${app.id}/book`).set(auth(free2.token)).send({ slotId: slots[1].id })).status).toBe(200);
    expect((await api().post(`/api/v1/applications/${app.id}/slot-change`).set(auth(free2.token)).send({ reason: 'Travelling that day' })).status).toBe(200);
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, pro.user.id));
    expect(n.some((x) => /Slot change request/.test(x.title))).toBe(true);
    const d = (await api().get(`/api/v1/my-castings/${mcId}/days`).set(auth(pro.token))).body;
    expect(d.changeRequests).toBe(1);
    // Poster moves them to another time: applicant is told the new slot
    await api().patch(`/api/v1/my-castings/${mcId}/days/${d.days[0].id}/slots/${slots[3].id}`).set(auth(pro.token)).send({ applicationId: app.id });
    const mine = (await api().get('/api/v1/applications').set(auth(free2.token))).body.items.find((x: { id: string }) => x.id === app.id);
    expect(mine.slot.time).toBe('15:45');
    expect(mine.slot.changeRequest).toBeNull();
  });

  it('live casting only allows deadline/venue/positions edits', async () => {
    expect((await api().patch(`/api/v1/my-castings/${mcId}`).set(auth(pro.token)).send({ title: 'Something else entirely' })).status).toBe(400);
    expect((await api().patch(`/api/v1/my-castings/${mcId}`).set(auth(pro.token)).send({ deadline: inDays(20) })).status).toBe(200);
  });
});

describe('limits', () => {
  it('Free members are stopped after 5 applications a month', async () => {
    const m = await loginMember();
    await profile(m.token, { name: 'Busy Applicant', gender: 'Female', dob: '2000-01-01' });
    for (let i = 0; i < 6; i++) {
      const c = await api().post('/api/v1/admin/castings').set(auth(admin.token)).send({ ...base, title: `Limit test casting number ${i}`, status: 'LIVE', sendAlert: false });
      const r = await api().post(`/api/v1/castings/${c.body.casting.code}/apply`).set(auth(m.token)).send({ roleId: c.body.casting.roles[1].id });
      expect(r.status).toBe(i < 5 ? 201 : 429);
    }
  });

  it('Pro-only castings and early access', async () => {
    const c = await api().post('/api/v1/admin/castings').set(auth(admin.token)).send({ ...base, title: 'Pro only premium web series', visibility: 'PRO', status: 'LIVE', sendAlert: false });
    const role = c.body.casting.roles[1].id;
    expect((await api().post(`/api/v1/castings/${c.body.casting.code}/apply`).set(auth(free2.token)).send({ roleId: role })).status).toBe(402);
    const e = await api().post('/api/v1/admin/castings').set(auth(admin.token)).send({ ...base, title: 'Early access ad film casting', proEarlyAccessHours: 24, status: 'LIVE', sendAlert: false });
    const hidden = await api().get('/api/v1/castings?q=Early access ad film').set(auth(free2.token));
    expect(hidden.body.total).toBe(0);
    const shown = await api().get('/api/v1/castings?q=Early access ad film').set(auth(pro.token));
    expect(shown.body.total).toBe(1);
    expect(e.status).toBe(201);
  });

  it('scheduled castings go live at publish time', async () => {
    const c = await api().post('/api/v1/admin/castings').set(auth(admin.token)).send({ ...base, title: 'Scheduled TV serial casting', status: 'SCHEDULED', publishAt: new Date(Date.now() + 60_000).toISOString() });
    expect(c.body.casting.status).toBe('SCHEDULED');
    await db.update(schema.castings).set({ publishAt: new Date(Date.now() - 1000) }).where(eq(schema.castings.id, c.body.casting.id));
    expect((await api().get(`/api/v1/castings/${c.body.casting.code}`)).status).toBe(200);
  });
});
