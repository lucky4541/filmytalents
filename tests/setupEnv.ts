process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://castinghub:castinghub@localhost:5432/castinghub_test';
process.env.OTP_PROVIDER = 'dummy';
process.env.PAYMENTS_MOCK = 'true';
process.env.UPLOAD_DIR = 'uploads-test';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_123';
process.env.CASHFREE_SECRET_KEY = 'cfsk_test_secret_123456';
