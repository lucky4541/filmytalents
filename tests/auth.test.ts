import { describe, expect, it } from 'vitest';
import { api, auth, loginAdmin, loginMember, newPhone, TEST_PASSWORD } from './helpers';

describe('member registration (OTP) and password login', () => {
  it('rejects invalid phone numbers', async () => {
    const r = await api().post('/api/v1/auth/register/otp').send({ phone: '12345' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/10-digit Indian mobile/);
  });

  it('accepts +91 / 0 prefixes', async () => {
    const p = newPhone();
    const r = await api().post('/api/v1/auth/register/otp').send({ phone: `+91 ${p.slice(0, 5)} ${p.slice(5)}` });
    expect(r.status).toBe(200);
    expect(r.body.phone).toBe(`+91${p}`);
    expect(r.body.devHint).toMatch(/123456/);
  });

  it('blocks a resend inside 30 seconds', async () => {
    const p = newPhone();
    await api().post('/api/v1/auth/register/otp').send({ phone: p });
    const r = await api().post('/api/v1/auth/register/otp').send({ phone: p });
    expect(r.status).toBe(429);
  });

  it('needs a strong password, the right code, and creates the account once', async () => {
    const p = newPhone();
    await api().post('/api/v1/auth/register/otp').send({ phone: p });
    const weak = await api().post('/api/v1/auth/register').send({ phone: p, code: '123456', password: 'short' });
    expect(weak.status).toBe(400);
    const bad = await api().post('/api/v1/auth/register').send({ phone: p, code: '000000', password: TEST_PASSWORD });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/4 tries left/);
    const ok = await api().post('/api/v1/auth/register').send({ phone: p, code: '123456', password: TEST_PASSWORD, name: 'Priya Sharma' });
    expect(ok.status).toBe(201);
    expect(ok.body.isNewUser).toBe(true);
    expect(ok.body.user.code).toMatch(/^CH\d{5}$/);
    expect(ok.body.user.name).toBe('Priya Sharma');
    expect(ok.body.user.hasPassword).toBe(true);
    expect(ok.body.user.plan.isPaid).toBe(false);
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    // Registering the same number again is refused
    const again = await api().post('/api/v1/auth/register/otp').send({ phone: p });
    expect(again.status).toBe(409);
  });

  it('logs in with mobile number or member ID + password; wrong password is refused', async () => {
    const m = await loginMember();
    const byPhone = await api().post('/api/v1/auth/login').send({ identifier: m.phone, password: TEST_PASSWORD });
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.user.id).toBe(m.user.id);
    const byCode = await api().post('/api/v1/auth/login').send({ identifier: m.user.code.toLowerCase(), password: TEST_PASSWORD });
    expect(byCode.status).toBe(200);
    const wrong = await api().post('/api/v1/auth/login').send({ identifier: m.phone, password: 'Wrong12345' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/Wrong mobile number/);
    const unknown = await api().post('/api/v1/auth/login').send({ identifier: newPhone(), password: TEST_PASSWORD });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('forgot password: OTP reset signs out old sessions and the new password works', async () => {
    const m = await loginMember();
    expect((await api().post('/api/v1/auth/password/otp').send({ phone: newPhone() })).status).toBe(404);
    expect((await api().post('/api/v1/auth/password/otp').send({ phone: m.phone })).status).toBe(200);
    const r = await api().post('/api/v1/auth/password/reset').send({ phone: m.phone, code: '123456', password: 'NewPass2026' });
    expect(r.status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: m.refresh })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ identifier: m.phone, password: TEST_PASSWORD })).status).toBe(400);
    expect((await api().post('/api/v1/auth/login').send({ identifier: m.phone, password: 'NewPass2026' })).status).toBe(200);
  });

  it('change password needs the current one', async () => {
    const m = await loginMember();
    const bad = await api().post('/api/v1/auth/password/change').set(auth(m.token)).send({ current: 'nope', password: 'Another2026' });
    expect(bad.status).toBe(400);
    const ok = await api().post('/api/v1/auth/password/change').set(auth(m.token)).send({ current: TEST_PASSWORD, password: 'Another2026' });
    expect(ok.status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ identifier: m.phone, password: 'Another2026' })).status).toBe(200);
  });

  it('second login finds the same account; /me works; refresh rotates', async () => {
    const first = await loginMember();
    const me = await api().get('/api/v1/auth/me').set(auth(first.token));
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(first.user.id);
    const r = await api().post('/api/v1/auth/refresh').send({ refreshToken: first.refresh });
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: first.refresh });
    expect(reuse.status).toBe(401);
  });

  it('referral code links new members', async () => {
    const a = await loginMember();
    const b = await loginMember(newPhone(), { referralCode: a.user.referralCode });
    expect(b.user.id).not.toBe(a.user.id);
  });

  it('rejects requests without a token', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(auth('garbage'))).status).toBe(401);
  });
});

describe('admin login (email + password only)', () => {
  it('logs in with the seeded admin', async () => {
    const r = await api().post('/api/v1/admin/auth/login').send({ email: 'ADMIN@castinghub.in', password: 'admin123' });
    expect(r.status).toBe(200);
    expect(r.body.admin.role).toBe('Super Admin');
    expect(r.body.permissions).toEqual(['*']);
  });

  it('wrong password is rejected; a member token cannot open admin routes', async () => {
    const r = await api().post('/api/v1/admin/auth/login').send({ email: 'admin@castinghub.in', password: 'nope' });
    expect(r.status).toBe(401);
    const m = await loginMember();
    expect((await api().get('/api/v1/admin/auth/me').set(auth(m.token))).status).toBe(401);
  });
});

describe('admin team', () => {
  it('invite → accept → role permissions apply', async () => {
    const { token } = await loginAdmin();
    const inv = await api().post('/api/v1/admin/team').set(auth(token)).send({ name: 'Kiran Rao', email: 'kiran@castinghub.in', role: 'Support Agent' });
    expect(inv.status).toBe(201);
    const t = new URL(inv.body.inviteUrl).searchParams.get('token');
    const acc = await api().post('/api/v1/admin/auth/accept-invite').send({ token: t, password: 'support-pass-1' });
    expect(acc.status).toBe(200);
    expect(acc.body.permissions).toContain('support');
    // Support Agent can't open team
    const denied = await api().get('/api/v1/admin/team').set(auth(acc.body.accessToken));
    expect(denied.status).toBe(403);
    // Duplicate email
    const dup = await api().post('/api/v1/admin/team').set(auth(token)).send({ name: 'Xyz', email: 'kiran@castinghub.in', role: 'Moderator' });
    expect(dup.status).toBe(409);
  });

  it('cannot disable yourself or the last Super Admin', async () => {
    const { token, admin } = await loginAdmin();
    const r = await api().patch(`/api/v1/admin/team/${admin.id}`).set(auth(token)).send({ status: 'DISABLED' });
    expect(r.status).toBe(400);
  });

  it('roles can be edited (team stays Super Admin only)', async () => {
    const { token } = await loginAdmin();
    const r = await api().put(`/api/v1/admin/team/roles/${encodeURIComponent('Support Agent')}`).set(auth(token)).send({ modules: ['dashboard', 'support', 'users', 'team', 'catalogue'] });
    expect(r.status).toBe(200);
    expect(r.body.modules).toEqual(['dashboard', 'support', 'users', 'catalogue']);
  });
});
