# Casting Hub — Backend API

Node.js + Express + TypeScript + PostgreSQL (Drizzle ORM). Serves the member app (`D:\filmytrendz\User`) and the admin panel (`D:\filmytrendz\Admin`).

## 1. Install (Windows)
1. Install **Node.js 20 or newer** — https://nodejs.org
2. Install **PostgreSQL 16** — https://www.postgresql.org/download/windows/ (remember the password you set for `postgres`).
3. Open **pgAdmin** or the SQL Shell and run:
   ```sql
   CREATE USER castinghub WITH PASSWORD 'castinghub' CREATEDB;
   CREATE DATABASE castinghub OWNER castinghub;
   ```
4. In this folder:
   ```bash
   copy .env.example .env      # then edit .env if needed
   npm install
   npm run db:migrate          # creates all tables
   npm run db:seed             # plans, roles, lists, settings, first admin
   npm run dev                 # API on http://localhost:4000
   ```
5. Check http://localhost:4000/health → `{"status":"ok"}`

First admin login: `admin@castinghub.in` / `admin123` (change it after logging in).

## 2. Phone OTP login
- `OTP_PROVIDER=dummy` (default): enter any real Indian mobile number; no SMS is sent; the code is **123456** (`DUMMY_OTP_CODE`).
- `OTP_PROVIDER=fast2sms`: real SMS. Add `FAST2SMS_API_KEY` from https://www.fast2sms.com → Dev API. The `otp` route works without DLT.

## 3. Scripts
| Command | What it does |
|---|---|
| `npm run dev` | Start API with auto-reload |
| `npm run build` / `npm start` | Production build / run |
| `npm run db:generate` | Create a new migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Default data (safe to re-run) |
| `npm test` | Run all API tests (uses database `castinghub_test`) |

## 4. Folder layout
```
src/
  config/env.ts      settings from .env (validated)
  db/                schema, migrations runner, seed, defaults
  lib/               shared helpers (errors, crypto, jwt, sms, storage, settings…)
  middleware/        auth (member/admin/role), rate limits, errors
  modules/<name>/    one folder per feature: routes + service
drizzle/             SQL migrations
tests/               API tests
```
API reference: see `API.md`. Going live: see `DEPLOY.md`.

## 5. Modules
| # | Module | What it covers |
|---|---|---|
| 1 | Core | config, database (42 tables), errors, logging, security headers, rate limits |
| 2 | Auth | phone OTP login (dummy / Fast2SMS), admin email + password, tokens, team & roles |
| 3 | Members | profiles, uploads, talent search, follow/block, profile views, verification, data requests, admin member tools |
| 4 | Castings | admin castings, Pro member castings with approval, applying, applicant pipeline, round 2 slots, client share links |
| 5 | Payments | Razorpay + Cashfree, coupons, GST invoices, refunds, webhooks, plans |
| 6 | Engage & moderation | notifications + SMS, campaigns, auto messages, home page, support desk, Pro chat (live), community, reports |
| 7 | System | site config, settings (SMS key, maintenance, features), catalogue, audit log, dashboard & analytics, background jobs |

## 6. Live updates
Socket.IO runs on the same port. Connect from the app with `io(API_URL, { auth: { token } })` and listen for `notification`, `message`, `read`, `typing`.
