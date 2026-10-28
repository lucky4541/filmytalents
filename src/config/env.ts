import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  SECRETS_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'SECRETS_KEY must be 64 hex characters'),
  ACCESS_TOKEN_MINUTES: z.coerce.number().default(30),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  OTP_PROVIDER: z.enum(['dummy', 'fast2sms']).default('dummy'),
  DUMMY_OTP_CODE: z.string().regex(/^\d{4,6}$/).default('123456'),
  OTP_LENGTH: z.coerce.number().min(4).max(6).default(6),
  OTP_EXPIRY_MINUTES: z.coerce.number().default(5),
  OTP_RESEND_SECONDS: z.coerce.number().default(30),
  OTP_MAX_PER_DAY: z.coerce.number().default(10),
  FAST2SMS_API_KEY: z.string().default(''),
  FAST2SMS_ROUTE: z.enum(['otp', 'dlt', 'q']).default('otp'),
  FAST2SMS_SENDER_ID: z.string().default(''),
  FAST2SMS_DLT_TEMPLATE_ID: z.string().default(''),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  CASHFREE_APP_ID: z.string().default(''),
  CASHFREE_SECRET_KEY: z.string().default(''),
  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PAYMENTS_MOCK: bool.default('true'),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_PHOTO_MB: z.coerce.number().default(10),
  MAX_VIDEO_MB: z.coerce.number().default(50),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@castinghub.in'),
  SEED_ADMIN_PASSWORD: z.string().min(6).default('admin123'),
  SEED_ADMIN_NAME: z.string().default('Admin'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd) {
  const weak = [env.JWT_ACCESS_SECRET.startsWith('change-me') && 'JWT_ACCESS_SECRET', env.JWT_REFRESH_SECRET.startsWith('change-me') && 'JWT_REFRESH_SECRET', /^0+$/.test(env.SECRETS_KEY) && 'SECRETS_KEY'].filter(Boolean);
  if (weak.length) {
    console.error(`❌ Set real values for ${weak.join(', ')} before running in production (see DEPLOY.md).`);
    process.exit(1);
  }
  if (env.PAYMENTS_MOCK) console.warn('⚠️  PAYMENTS_MOCK=true in production: checkout will not take real payments.');
}

if (isProd && env.OTP_PROVIDER === 'dummy') {
  console.warn('⚠️  OTP_PROVIDER=dummy in production: anyone can log in with the dummy code. Switch to fast2sms before launch.');
}
