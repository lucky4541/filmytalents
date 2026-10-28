# Casting Hub API reference

Base URL: `http://localhost:4000/api/v1` (production: your domain + `/api/v1`).
All bodies are JSON. Errors look like `{ "error": { "code": "BAD_REQUEST", "message": "Friendly text" } }`.
Logged-in calls send `Authorization: Bearer <accessToken>`. Access tokens last 30 minutes — call **refresh** with the refresh token to get a new pair.

---
## 1. Member login (phone OTP)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/otp/send` | `{ phone }` — any format: `9876543210`, `+91 98765 43210`, `09876543210` | `{ sent, phone, isNewUser, expiresIn, resendIn, length, devHint? }` |
| POST | `/auth/otp/verify` | `{ phone, code, name?, referralCode? }` | `{ accessToken, refreshToken, expiresIn, isNewUser, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` | new `{ accessToken, refreshToken }` (old one stops working) |
| POST | `/auth/logout` | `{ refreshToken, all? }` | `{ ok }` |
| GET | `/auth/me` | — | `{ user }` |

Rules: one code every 30 s, 10 codes per number per day, 5 wrong tries per code, codes expire in 5 minutes.
**Dummy mode** (`OTP_PROVIDER=dummy`): no SMS; the code is `123456`. **Fast2SMS** (`OTP_PROVIDER=fast2sms` + `FAST2SMS_API_KEY`): real SMS via the OTP route (no DLT needed).

## 2. Admin login (email + password)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/admin/auth/login` | `{ email, password }` | `{ accessToken, refreshToken, admin, permissions }` |
| POST | `/admin/auth/refresh` | `{ refreshToken }` | new token pair |
| POST | `/admin/auth/logout` | `{ refreshToken }` | `{ ok }` |
| GET | `/admin/auth/me` | — | `{ admin, permissions }` (`["*"]` = Super Admin) |
| POST | `/admin/auth/change-password` | `{ current, next }` | `{ ok }` |
| POST | `/admin/auth/accept-invite` | `{ token, password, name? }` | logs the new admin in |

5 wrong passwords lock the email for 15 minutes. The IP allowlist in Settings → Security is enforced here.

## 3. Admin team & roles (Super Admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/team` | all admins |
| POST | `/admin/team` | `{ name, email, role, password? }` → `{ admin, inviteUrl }` |
| PATCH | `/admin/team/:id` | `{ role?, status?: ACTIVE\|DISABLED, name? }` — can't disable yourself or the last Super Admin |
| POST | `/admin/team/:id/resend-invite` | new 48-hour link |
| DELETE | `/admin/team/:id` | remove |
| GET | `/admin/team/roles` | roles, modules and who can open what |
| PUT | `/admin/team/roles/:role` | `{ modules: [...] }` |

Roles: Super Admin, Casting Manager, Moderator, Verification Officer, Support Agent, Content Manager, Finance.

---
## 4. My account (`/me`, member login required)

| Method | Path | Notes |
|---|---|---|
| GET | `/me` | `{ user, followers, following }` — `user.profileComplete` is a % |
| PATCH | `/me` | any of: name, email, gender, dob, city, state, bio, crafts[], languages[], skills[], experience, heightCm, instagram, youtube, guardianName, guardianRelation, guardianPhone, guardianConsent. **Under 18 → guardian name, relation, phone and consent are required.** |
| PATCH | `/me/prefs` | `{ castingAlerts, applicationUpdates, messages, offers, sms, whatsapp, email }` (booleans) |
| PATCH | `/me/privacy` | `{ showAge, showCity, hideFromSearch, allowMessages, showOnline }` |
| POST | `/me/avatar`, `/me/cover` | multipart, field `file` (JPG/PNG/WEBP, max 10 MB) |
| POST | `/me/phone/send` → `/me/phone/verify` | change mobile number with an OTP |
| GET | `/me/media` | my gallery |
| POST | `/me/media/photo` | multipart `file` + `caption` (max 30 photos) |
| POST | `/me/media/video` | **Pro only** — MP4/MOV/WEBM, max 50 MB, max 10 videos |
| PATCH / DELETE | `/me/media/:id` | edit caption / delete |
| PUT | `/me/media/order` | `{ ids: [...] }` |
| GET | `/me/views` | who viewed me. Free: `{ last30Days, locked: true }`. Pro: list of viewers |
| GET/POST/PATCH/DELETE | `/me/saved-searches[/:id]` | `{ label, query, alerts }` (max 10) |
| GET | `/me/blocks` | members I blocked |
| GET | `/me/referrals` | `{ code, link, joined, upgraded, bonusDays, items }` |
| GET | `/me/verification` | `{ verified, request }` |
| POST | `/me/verification` | multipart: `docType` + files `idFront`, `selfie` (required), `idBack`, `guardianId` (required under 18). JPG/PNG/WEBP/PDF |
| GET / POST | `/me/data-requests` | `{ type: "export" \| "delete" }` |
| DELETE | `/me/data-requests/:id` | cancel a pending request |
| DELETE | `/me` | close my account (deleted within 30 days; logging in again cancels) |

Uploaded files are checked by content (a renamed .exe is refused) and served from `/uploads/...`.

## 5. Talent (public; send a token to hide blocked members)

| Method | Path | Notes |
|---|---|---|
| GET | `/talent` | filters: `q, craft, city, language` (comma lists), `gender, ageMin, ageMax, heightMin, heightMax, experience, verified, pro, hasPhotos`, `sort=relevant\|new\|active\|views`, `page, limit`. Pro members are boosted in "relevant". Phone numbers are never returned. |
| GET | `/talent/:code` | profile + gallery + follower counts. Records a profile view (once a day per viewer). |
| POST / DELETE | `/talent/:code/follow` | follow / unfollow |
| GET | `/talent/:code/followers`, `/following` | lists |
| POST / DELETE | `/talent/:code/block` | block hides both profiles from each other and removes follows |

## 6. Admin → Members (`users` permission)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/users` | `q` (name/code/email/phone digits), `plan=free\|paid\|<id>`, `status, verified, minor, city, craft, joinedFrom, sort` |
| GET | `/admin/users/stats` | totals for the dashboard tiles |
| GET | `/admin/users/duplicates` | groups: same name / email / guardian phone |
| POST | `/admin/users/duplicates/dismiss` | `{ key }` |
| GET | `/admin/users/:id` | member + gallery, counts, payments, verification history |
| GET | `/admin/users/:id/phone` | full phone — **written to the audit log** |
| PATCH | `/admin/users/:id` | edit profile fields |
| POST | `/:id/warn` `{reason}` · `/:id/suspend` `{days, reason}` · `/:id/ban` `{reason}` · `/:id/reactivate` · `/:id/mute` `{hours}` · `/:id/verified` `{verified}` · `/:id/plan` `{planId, days, note}` · `/:id/viewed` | actions (all audited; suspend/ban log the member out) |
| DELETE | `/:id/media/:mediaId`, `/:id/avatar` | remove content |

## 7. Admin → Verification (`verification` permission)

`GET /admin/verification?status=PENDING|APPROVED|REJECTED|MORE_INFO|all` (oldest first, with counts) · `GET /:id` · `POST /:id/approve` · `POST /:id/reject {reason}` · `POST /:id/more-info {reason}`. The member gets a notification each time.

## 8. Admin → Data requests (`users` permission)

`GET /admin/data-requests?status=pending|done|declined|cancelled|all` (each has `dueAt` = 30 days) · `GET /:id/export` (JSON download) · `POST /:id/complete` (for **delete** this removes photos, documents and personal details; payment rows are kept for GST records) · `POST /:id/decline {reason}`.

---
## 9. Castings (public)

| Method | Path | Notes |
|---|---|---|
| GET | `/castings` | live castings. Filters: `q, city, projectType, language` (comma lists), `gender, age, mode, proOnly, featured, includeClosed`, `forMe=true` (matches my gender & age), `sort=new\|deadline\|popular`. Free members/visitors don't see castings during the Pro early-access window. Each item has `applied` when logged in. |
| GET | `/castings/:code` | `{ casting, myApplication, isOwner, applicationsThisMonth: { used, max } }` |
| POST | `/castings/:code/apply` | JSON `{ roleId, note?, tapeUrl? }` or multipart with a `tape` video (Pro). Errors: **402** Pro-only / early access, **429** monthly limit reached (Free = 5), **409** already applied, **400** closed / wrong gender / own casting |

## 10. My applications (member)

| Method | Path | Notes |
|---|---|---|
| GET | `/applications?status=` | my applications with casting, role, round-2 invite and booked slot |
| DELETE | `/applications/:id` | withdraw (only before the team acts) |
| GET | `/applications/:id/slots` | round-2 audition days and free slots |
| POST | `/applications/:id/book` | `{ slotId }` — book or move my slot (409 if someone took it) |
| DELETE | `/applications/:id/book` | give up my slot |

## 11. My castings — Pro members post and manage (`/my-castings`)

| Method | Path | Notes |
|---|---|---|
| GET | `/my-castings` | my castings with status, review note and applicant counts |
| POST | `/my-castings` | **Pro only.** `{ title, production, showProductionAs, projectType, description, location, mode, venue, languages, budget, deadline, roles: [{ name, gender, ageMin, ageMax, positions, ... }] }` → status **PENDING** (admin review). Money words ("registration fee", "pay first", GPay …) and phone numbers/emails are refused. Max 10 open. |
| GET / PATCH / DELETE | `/my-castings/:id` | edit sends it back to review. A LIVE casting can only change `deadline`, `venue`, `positions`. Delete only before it goes live. |
| POST | `/my-castings/:id/close` | stop applications |
| GET | `/my-castings/:id/applicants` | `role, status (comma list), q, minRating, sort` + `counts` per status |
| GET | `/my-castings/:id/applicants/:appId` | opening marks "Viewed"; includes gallery |
| PATCH | `/my-castings/:id/applicants/:appId` | `{ status: VIEWED\|SHORTLISTED\|SELECTED\|REJECTED, rating: 0-5 }`. **`phone` is filled only once the applicant is SELECTED** (guardian's number for under-18s). |
| POST | `/my-castings/:id/applicants/bulk` | `{ ids, status }` |
| POST | `/my-castings/:id/applicants/:appId/notes` | `{ text }` private notes |
| POST | `/my-castings/:id/round2` | `{ ids, date, venue, bring, channels }` — invites + notifies |
| GET | `/my-castings/:id/applicants.csv` | Excel-friendly export |

## 12. Admin → Castings (`castings` permission)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/castings` | `status` (comma list or all), `source=all\|admin\|member`, `q, projectType, city, clientId, sort` + `tabs` counts (pending, live, draft, closed) |
| POST | `/admin/castings` | casting fields + `visibility: ALL\|PRO, proEarlyAccessHours, featured, urgent, sendAlert, clientId, status: DRAFT\|SCHEDULED\|LIVE, publishAt`. Going live sends the "New casting matches profile" alert to matching members → `alerted` |
| GET / PATCH / DELETE | `/admin/castings/:id` | delete only without applicants |
| POST | `/:id/publish` · `/:id/close` · `/:id/archive` · `/:id/unpublish` · `/:id/duplicate` | |
| POST | `/:id/approve` `{featured?, urgent?, sendAlert?}` · `/:id/request-changes {note}` · `/:id/reject {note}` | **member casting review queue**; the poster is notified |
| — | `/:id/applicants…`, `/:id/round2`, `/:id/applicants.csv` | same as section 11; admins see phones masked (reveal from Members) and see all notes |
| GET / POST | `/:id/days` | audition days: `{ title, date: YYYY-MM-DD, start, end, slotMins, breakStart?, breakEnd?, mode, venue, bring }` → slots auto-created. GET also lists round-2 applicants without a slot |
| PATCH / DELETE | `/:id/days/:dayId` | delete notifies booked talent |
| PATCH | `/:id/days/:dayId/slots/:slotId` | `{ applicationId \| null, status: OPEN\|BOOKED\|CHECKED_IN\|NO_SHOW\|DONE, note }` |
| POST | `/:id/days/:dayId/remind` | reminder to everyone booked |
| GET / POST | `/:id/shares` | client shortlist links: `{ clientId, title, message, applicationIds, showVideos, showMeasurements, allowDownload, passcode?, expiresInDays }` → `url` |
| PATCH | `/:id/shares/:shareId` | `{ extendDays?, revoke?, reopen?, addApplicationIds? }` |
| GET/POST/PATCH/DELETE | `/admin/clients[/:id]` | production houses / brands |

## 13. Client shortlist page (no login)

`GET /share/:token` (header `x-share-passcode` if set) → casting, talents with photos/tapes. **No phone numbers.**
`POST /share/:token/feedback` `{ items: [{ applicationId, pick: yes|maybe|no|null, comment }], submit }`.

---
## 14. Plans & payments (member)

All amounts are in **paise** (₹99 = 9900). GST 18%: CGST 9% + SGST 9% when the billing state equals the business state in Settings, otherwise IGST 18%.

| Method | Path | Notes |
|---|---|---|
| GET | `/plans` | public: plans with enabled prices, `gateways` available (primary first), payment `methods`, my `current` plan |
| POST | `/payments/quote` | `{ planId, cycle: MONTHLY\|QUARTERLY\|HALFYEARLY\|YEARLY, coupon?, state? }` → `{ base, discount, taxable, gst, gstSplit, amount, coupon, couponError }` |
| POST | `/payments/order` | `{ planId, cycle, coupon?, gateway?, billing: { name, email, state, gstin? } }` → `{ paymentId, gateway, amount, checkout, fallback }` |
| POST | `/payments/verify` | Razorpay: `{ paymentId, razorpay_order_id, razorpay_payment_id, razorpay_signature }`. Cashfree: `{ paymentId }` (server asks Cashfree). Mock: `{ paymentId, mock: "success"\|"fail" }` → `{ status: SUCCESS\|FAILED\|PENDING }` |
| POST | `/payments/:id/failed` | `{ reason }` → `{ tryInstead: "cashfree" }` when a backup gateway is on |
| GET | `/payments` | my payment history |
| GET | `/payments/:id/invoice` | printable GST invoice (HTML → Save as PDF) |
| POST | `/payments/auto-renew` | `{ on }` |

**Opening checkout in the app**
- Razorpay: load `https://checkout.razorpay.com/v1/checkout.js`, then `new Razorpay({ key: checkout.keyId, order_id: checkout.orderId, amount, currency: 'INR', prefill: checkout.prefill, handler: (r) => verify({ paymentId, ...r }) }).open()`.
- Cashfree: load `https://sdk.cashfree.com/js/v3/cashfree.js`, then `Cashfree({ mode: checkout.mode }).checkout({ paymentSessionId: checkout.paymentSessionId, redirectTarget: '_self' })`. Cashfree returns to `/checkout/return?order_id=…` → call verify.
- `checkout.mock === true` (PAYMENTS_MOCK) → show a fake "Pay" button and call verify with `mock`.

Paying activates the plan (renewals extend from the current end date), uses up the coupon, adds any referral bonus days, sends the receipt message and gives the inviter 7 Pro days on a referred member's first payment.

## 15. Webhooks (set these URLs in the gateway dashboards)

- `POST /webhooks/razorpay` — signature header `X-Razorpay-Signature` (HMAC with the webhook secret). Events: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`.
- `POST /webhooks/cashfree` — headers `x-webhook-signature`, `x-webhook-timestamp` (HMAC with the secret key). Events: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `REFUND_STATUS_WEBHOOK`.
Both are safe to receive more than once.

## 16. Admin → Payments (`payments`), Plans & coupons (`plans`), Gateway keys (`settings`)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/payments` | `status, gateway, planId, q (invoice / order / payment id / member), from, to` |
| GET | `/admin/payments/stats` | today, month, allTime, refunded, net, gstMonth, success rate, per gateway, paid members, last 30 days |
| GET | `/admin/payments/export.csv` | same filters, for the accountant |
| GET | `/admin/payments/:id`, `/:id/invoice` | |
| POST | `/admin/payments/:id/sync` | re-check with the gateway (missed webhook) |
| POST | `/admin/payments/:id/refund` | `{ amount?, reason, keepPlan? }` — partial or full; full refund moves the member to Free unless `keepPlan` |
| GET / POST | `/admin/plans` | plans with prices and member counts |
| PATCH | `/admin/plans/:id` | `{ name, tagline, features, limits, active, popular, prices: [{ cycle, price, enabled }] }` |
| GET/POST/PATCH/DELETE | `/admin/coupons[/:id]` | `{ code, percent \| amountOff, planIds, cycles, maxUses, validFrom, validTo, active, note }` |
| GET | `/admin/settings/payments` | primary/backup gateway, mode, key IDs, **secret hints only**, webhook URLs |
| PUT | `/admin/settings/payments` | `{ primary, fallback, razorpay: { enabled, mode, methods, test: { keyId, secret, webhookSecret }, live: {…} }, cashfree: {…}, business: { legalName, gstin, invoicePrefix, address, sac, state } }`. Secrets are encrypted (AES-256-GCM) and never returned or logged. |
| POST | `/admin/settings/payments/:gateway/test` | test the keys |

---
## 17. Notifications (member)

`GET /notifications?before=` (with `unread`) · `GET /notifications/unread-count` · `POST /notifications/read { ids } | { all: true }` · `POST /notifications/:id/click` (marks read, counts campaign clicks, returns `link`) · `DELETE /notifications/:id`.

**Live updates (Socket.IO):** `io(API_URL, { auth: { token: accessToken } })`. Events: `notification`, `message` `{ conversationId, id, text, from, createdAt }`, `read` `{ conversationId }`, `typing`. Emit `typing` `{ to: userId, conversationId }`.

**SMS:** every Auto-message rule with the `sms` channel on also sends a text through Fast2SMS (Quick SMS route) to members who haven't turned SMS off. With `OTP_PROVIDER=dummy` texts are only written to the log.

## 18. Help & support (member)

`GET /support/categories` · `GET /support/tickets` · `POST /support/tickets { subject, category, text }` (scam reports = urgent, payments = high) · `GET /support/tickets/:id` · `POST /support/tickets/:id/reply { text }` · `POST /support/tickets/:id/close`.

## 19. Chat (Pro)

| Method | Path | Notes |
|---|---|---|
| GET | `/chat` | my chats: other member, last message, unread, `canSend` |
| GET | `/chat/unread-count` | |
| POST | `/chat/start` | `{ code }` — **Pro only**. Not allowed: blocked members, members under 18, members who turned messages off |
| GET | `/chat/:id/messages?before=` | |
| POST | `/chat/:id/messages` | `{ text }` — Pro only (Free members can read, then "Upgrade to reply"). Phone numbers/emails refused; blocked words flagged to moderators (`warning` returned); daily limit and chat mute enforced |
| POST | `/chat/:id/read` | |
| POST | `/chat/:id/report` | `{ reason, messageIds?, block? }` |

## 20. Community posts & reports (member)

| Method | Path | Notes |
|---|---|---|
| GET | `/posts?following=true&user=<code>&type=PHOTO\|VIDEO\|POST&before=` | feed (blocked members hidden) |
| POST | `/posts` | JSON `{ text }` or multipart `file` + `text`; `?kind=video` for video (**Pro only**). Max 20 a day |
| GET / DELETE | `/posts/:id` | with comments / delete my post |
| POST | `/posts/:id/comments` `{ text }` · `/posts/:id/like` · `DELETE /posts/:id/like` | |
| POST | `/reports` | `{ targetType: user\|post\|comment\|casting, targetId (id or code), reason, details }`. Scam & child-safety = urgent. 3 reports hide a post until reviewed |

## 21. Admin → Engage (`engage`)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/engage/campaigns` | also sends scheduled campaigns that are due |
| POST | `/admin/engage/campaigns/audience` | `{ plan: all\|free\|paid\|<id>, craft, city, inactiveDays }` → `{ audience, smsReachable }` |
| POST | `/admin/engage/campaigns` | `{ title, message, channels: [push, sms], segment, link?, scheduledAt?, send? }` |
| PATCH / DELETE | `/admin/engage/campaigns/:id` · POST `/:id/send` | drafts & scheduled only |
| GET / PATCH | `/admin/engage/rules[/:key]` | Auto messages: `{ enabled, template, channels }`. Placeholders like `{role}`, `{casting}`, `{date}` |
| GET / PUT | `/admin/engage/home` | hero, announcement bar, banners (audience all/free/paid/visitors), sections, featured castings/talent, SEO |

## 22. Admin → Support (`support`)

`GET /admin/support/tickets?status=open,pending&priority&category&assignee=me|none|<id>&q` (+ `stats`: open, pending, urgent, unassigned, avg first response) · `GET /:id` (member, messages incl. internal notes, other tickets) · `POST /:id/reply { text, internal?, status? }` (`{name}` = member's first name; first reply sets response time and assigns to you) · `PATCH /:id { status, priority, assigneeId, category }` · canned replies `GET/POST/PATCH/DELETE /admin/support/canned[/:id]`.

## 23. Admin → Moderation (`moderation`)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/moderation/stats` | open/urgent reports, hidden & flagged posts, chat reports, flagged messages (7 days) |
| GET | `/admin/moderation/reports?status=OPEN\|RESOLVED\|DISMISSED\|all&type&priority` | urgent first, with `timesReported` |
| GET | `/admin/moderation/reports/:id` | target + the member's report history |
| POST | `/admin/moderation/reports/:id/resolve` | `{ action: none\|warn\|remove\|suspend\|ban, note, days? }` — closes every open report on that item and tells the reporters |
| GET | `/admin/moderation/content?status&type&flagged=true&reported=true` | |
| POST | `/admin/moderation/content/:id` | `{ action: hide\|restore\|remove\|approve, reason, userAction: none\|warn\|suspend\|ban, days }` |
| GET | `/admin/moderation/chat-reports[/:id]` | opening a chat is audited |
| POST | `/admin/moderation/chat-reports/:id/resolve` | `{ action: none\|warn\|mute\|suspend\|ban, note, days }` |
| GET | `/admin/moderation/flagged-messages` | caught by the blocked-words filter |

---
## 24. Site config (public)

`GET /site` → `{ general, features, maintenance, legal, uploads, catalogue: { crafts, languages, cities, projectTypes, reportReasons, rejectReasons, … }, home: { hero, announcement, banners (only those for this viewer: visitors / free / paid, within dates), sections, featuredCastings, featuredTalent, latestCastings, seo }, viewer }`. Load this once when the app starts.
`GET /site/catalogue` · `GET /site/legal/:key` (terms, privacy, refund, childSafety).

**Maintenance mode** (Admin → Settings): every member API answers **503** `{ code: "MAINTENANCE", message }`; `/site`, `/share`, webhooks and the admin panel keep working.

## 25. Admin → Settings (`settings`)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/settings` | all groups + `secrets.fast2smsApiKey` hint |
| PUT | `/admin/settings/:group` | groups: `general, uploads, features, chat, maintenance, legal, security, sms`. `sms`: `{ provider: dummy\|fast2sms, route: otp\|dlt\|q, senderId, templateId }` (dummy is refused in production). `security.ipAllowlist` must include your own IP |
| PUT | `/admin/settings/secrets/fast2sms` | `{ apiKey }` (write-only) → `{ hint, balance }` |
| GET | `/admin/settings/sms/balance` | Fast2SMS wallet |
| POST | `/admin/settings/sms/test` | `{ phone }` sends a test SMS |
| POST | `/admin/system/jobs/run` | run background jobs now |
| GET | `/admin/system/info` | Node / Postgres version, uptime, memory, SMS mode |

## 26. Admin → Catalogue (`catalogue`)

`GET /admin/catalogue` (all lists incl. hidden) · `POST { list, name }` · `PATCH /:id { name, active }` · `PUT /:list/order { ids }` · `DELETE /:id`.

## 27. Admin → Audit log (`audit`)

`GET /admin/audit?module&adminId&q&from&to` (+ `modules`) · `GET /admin/audit/export.csv`. Every admin change, phone reveal, refund and settings change is recorded (never secret values).

## 28. Admin → Dashboard & analytics (`dashboard`)

`GET /admin/dashboard` → members (total, new today/7d, Pro, active today, verified), money (today, month, refunds — paise), work queues (live castings, casting approvals, verification, reports, chat reports, tickets, data requests, applications today, closing soon), 14-day trend (signups, applications, revenue), top live castings.
`GET /admin/dashboard/analytics?days=30` → signups and revenue by day, Free→Pro conversion, revenue by plan/cycle, top cities and crafts, applicant funnel, castings by source, avg applicants per casting, coupon usage, gateway success, 30-day retention.

## Permissions per area
| Permission | Areas |
|---|---|
| dashboard | dashboard, analytics |
| castings | castings, applicants, audition days, clients, share links |
| users | members, duplicates, data requests |
| verification | ID verification queue |
| moderation | reports, content, chat reports, flagged messages |
| payments | payments, refunds |
| plans | plans, coupons |
| engage | campaigns, auto messages, home page |
| support | support desk, canned replies |
| catalogue | lists |
| team | admins & roles |
| settings | settings, payment gateways, SMS, jobs |
| audit | audit log |
