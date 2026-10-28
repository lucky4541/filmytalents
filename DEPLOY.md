# Casting Hub — going live

This guide puts the API, the member app and the admin panel on one Ubuntu server (Hostinger VPS, DigitalOcean, AWS Lightsail …). 2 GB RAM is enough to start.

Example domains used below — change them to yours:
- `castinghub.in` → member app (`D:\filmytrendz\User`)
- `admin.castinghub.in` → admin panel (`D:\filmytrendz\Admin`)
- `api.castinghub.in` → this backend

Point all three DNS **A records** to the server's IP first.

---
## 1. Server setup (once)
```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs postgresql nginx certbot python3-certbot-nginx git
sudo npm i -g pm2
```

## 2. Database
```bash
sudo -u postgres psql -c "CREATE USER castinghub WITH PASSWORD 'PUT-A-STRONG-PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE castinghub OWNER castinghub;"
```

## 3. API
Copy the `Backend` folder to `/var/www/castinghub/api` (git, or WinSCP/FileZilla — **don't copy** `node_modules`, `dist`, `uploads`, `.env`).
```bash
cd /var/www/castinghub/api
cp .env.example .env
nano .env
```
Set in `.env`:
| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://castinghub:PASSWORD@localhost:5432/castinghub` |
| `PUBLIC_API_URL` | `https://api.castinghub.in` |
| `PUBLIC_APP_URL` | `https://castinghub.in` |
| `CORS_ORIGINS` | `https://castinghub.in,https://admin.castinghub.in` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | run `openssl rand -hex 32` for each |
| `SECRETS_KEY` | `openssl rand -hex 32` — **keep a copy safe**; without it saved gateway keys can't be read |
| `OTP_PROVIDER` | `fast2sms` (after testing; see §6) |
| `FAST2SMS_API_KEY` | from Fast2SMS → Dev API (or save it in Admin → Settings → SMS) |
| `PAYMENTS_MOCK` | `false` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | your first admin login |

The API refuses to start in production with the sample secrets.

```bash
npm ci
npm run build
npm run db:migrate:prod
node dist/db/seed.js           # first time only (safe to re-run)
pm2 start dist/server.js --name castinghub-api
pm2 save && pm2 startup        # restart on reboot (run the command it prints)
curl http://localhost:4000/health
```

**Updating later:** copy the new files, then `npm ci && npm run build && npm run db:migrate:prod && pm2 restart castinghub-api`.

## 4. Front-ends
On your PC, in each project set the API address and build:
```bash
# D:\filmytrendz\User  and  D:\filmytrendz\Admin
echo VITE_API_URL=https://api.castinghub.in > .env.production
npm run build                  # creates the dist folder
```
Upload `User\dist\*` to `/var/www/castinghub/app` and `Admin\dist\*` to `/var/www/castinghub/admin`.

## 5. Nginx + HTTPS
`sudo nano /etc/nginx/sites-available/castinghub`:
```nginx
server {
  server_name api.castinghub.in;
  client_max_body_size 60m;                       # video uploads
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;       # live chat (Socket.IO)
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server {
  server_name castinghub.in www.castinghub.in;
  root /var/www/castinghub/app;
  location / { try_files $uri /index.html; }
}
server {
  server_name admin.castinghub.in;
  root /var/www/castinghub/admin;
  location / { try_files $uri /index.html; }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/castinghub /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d castinghub.in -d www.castinghub.in -d admin.castinghub.in -d api.castinghub.in
```

## 6. Switch on real services
**SMS (Fast2SMS)**
1. Recharge the Fast2SMS wallet. Admin → Settings → SMS: paste the API key → "Check balance".
2. "Send test SMS" to your own number.
3. Set provider to **fast2sms** (or `OTP_PROVIDER=fast2sms` in `.env` and `pm2 restart`). The `otp` route needs no DLT. For your own sender name, register on DLT and use route `dlt` with the sender ID + template ID.

**Payments**
1. Admin → Settings → Payments → Razorpay: Key ID + Key Secret (test first) → "Test connection".
2. Razorpay Dashboard → Webhooks → URL `https://api.castinghub.in/api/v1/webhooks/razorpay`, events `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, and a secret → paste the same secret as the Webhook secret in Admin.
3. Cashfree (backup): App ID + Secret Key → Test. Cashfree Dashboard → Developers → Webhooks → `https://api.castinghub.in/api/v1/webhooks/cashfree`.
4. Fill Business details (legal name, GSTIN, state, invoice prefix) — they print on every invoice.
5. Pay ₹1-ish in test mode end-to-end, then switch both gateways to **Live** keys.

## 7. Backups (do this!)
```bash
sudo mkdir -p /var/backups/castinghub && sudo chown $USER /var/backups/castinghub
crontab -e
# every night 2:30 AM: database + uploads, keep 14 days
30 2 * * * pg_dump postgresql://castinghub:PASSWORD@localhost/castinghub | gzip > /var/backups/castinghub/db-$(date +\%F).sql.gz && tar czf /var/backups/castinghub/uploads-$(date +\%F).tgz -C /var/www/castinghub/api uploads && find /var/backups/castinghub -mtime +14 -delete
```
Copy backups off the server weekly (Google Drive / S3). Also store `.env` (especially `SECRETS_KEY`) somewhere safe.

## 8. Checklist before announcing
- [ ] `https://api.castinghub.in/health` shows `"status":"ok"` and `"otpProvider":"fast2sms"`
- [ ] Changed the first admin password; invited the team with their own roles
- [ ] Login with a real number receives an SMS
- [ ] A test payment activates Pro and the invoice opens
- [ ] Webhooks show "delivered" in Razorpay / Cashfree dashboards
- [ ] Terms, Privacy, Refund and Child-safety text filled in Admin → Settings → Legal
- [ ] Nightly backup file appears in `/var/backups/castinghub`

## Background jobs
The API runs these every 10 minutes (Admin can also run them now from System):
publish scheduled castings · close castings past their last date · send scheduled campaigns · plan-expiring reminders (3 days before) · move ended plans to Free · lift ended suspensions · delete accounts 30 days after a delete request · clean old OTP codes and sessions.
