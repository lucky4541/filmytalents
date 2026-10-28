import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();
export const api = () => request(app);

let phoneSeq = 0;
/** A fresh valid Indian mobile number per call. */
export const newPhone = () => `98${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq).padStart(2, '0')}`.slice(0, 10);

export const TEST_PASSWORD = 'Casting2026';

/** Registers a member (dummy OTP + password) and returns token + user. */
export async function loginMember(phone = newPhone(), extra: Record<string, unknown> = {}) {
  const s = await api().post('/api/v1/auth/register/otp').send({ phone });
  if (s.status !== 200) throw new Error(`register otp failed ${s.status} ${JSON.stringify(s.body)}`);
  const v = await api().post('/api/v1/auth/register').send({ phone, code: '123456', password: TEST_PASSWORD, ...extra });
  if (v.status !== 201) throw new Error(`register failed ${v.status} ${JSON.stringify(v.body)}`);
  return { token: v.body.accessToken as string, refresh: v.body.refreshToken as string, user: v.body.user, phone };
}

export async function loginAdmin(email = 'admin@castinghub.in', password = 'admin123') {
  const r = await api().post('/api/v1/admin/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error(`admin login failed ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.accessToken as string, refresh: r.body.refreshToken as string, admin: r.body.admin };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
