/**
 * FilmyTalents database schema (PostgreSQL, Drizzle ORM).
 * Money is stored in paise (₹1 = 100) to avoid rounding errors.
 */
import { randomUUID } from 'crypto';
import { relations, sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date());
const strArr = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

/* ============================== Enums ============================== */
export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED']);
export const billingCycle = pgEnum('billing_cycle', ['MONTHLY', 'QUARTERLY', 'HALFYEARLY', 'YEARLY']);
export const mediaType = pgEnum('media_type', ['PHOTO', 'VIDEO']);
export const otpPurpose = pgEnum('otp_purpose', ['LOGIN', 'CHANGE_PHONE', 'REGISTER', 'RESET_PASSWORD']);
export const adminStatus = pgEnum('admin_status', ['ACTIVE', 'INVITED', 'DISABLED']);
export const castingStatus = pgEnum('casting_status', ['DRAFT', 'SCHEDULED', 'PENDING', 'CHANGES', 'REJECTED', 'LIVE', 'CLOSED', 'ARCHIVED']);
export const visibility = pgEnum('visibility', ['ALL', 'PRO']);
export const applicationStatus = pgEnum('application_status', ['APPLIED', 'VIEWED', 'SHORTLISTED', 'ROUND2', 'SELECTED', 'REJECTED']);
export const slotStatus = pgEnum('slot_status', ['OPEN', 'BOOKED', 'CHECKED_IN', 'NO_SHOW', 'DONE']);
export const gateway = pgEnum('gateway', ['RAZORPAY', 'CASHFREE']);
export const paymentStatus = pgEnum('payment_status', ['CREATED', 'SUCCESS', 'FAILED', 'REFUNDED', 'PARTIAL_REFUND']);
export const verifyStatus = pgEnum('verify_status', ['PENDING', 'APPROVED', 'REJECTED', 'MORE_INFO']);
export const caseStatus = pgEnum('case_status', ['OPEN', 'RESOLVED', 'DISMISSED']);
export const postType = pgEnum('post_type', ['PHOTO', 'VIDEO', 'POST', 'COMMENT']);
export const postStatus = pgEnum('post_status', ['VISIBLE', 'HIDDEN', 'REMOVED']);

/* ============================== Plans ============================== */
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull().default(''),
  isFree: boolean('is_free').notNull().default(false),
  active: boolean('active').notNull().default(true),
  popular: boolean('popular').notNull().default(false),
  color: text('color').notNull().default('gold'),
  order: integer('order').notNull().default(0),
  trialDays: integer('trial_days').notNull().default(0),
  features: strArr('features'),
  limits: jsonb('limits').$type<PlanLimits>().notNull().default({} as PlanLimits),
});
export interface PlanLimits { applicationsPerMonth: number | null; chat: boolean; postCastings: boolean; videoPosts: boolean; earlyAccess: boolean; whoViewed: boolean; boost: boolean }

export const planPrices = pgTable('plan_prices', {
  planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  cycle: billingCycle('cycle').notNull(),
  price: integer('price').notNull(),
  enabled: boolean('enabled').notNull().default(true),
}, (t) => [primaryKey({ columns: [t.planId, t.cycle] })]);

/* ============================== Members ============================== */
export const users = pgTable('users', {
  id: id(),
  code: text('code').notNull().unique(),
  phone: text('phone').notNull().unique(),
  phoneVerifiedAt: ts('phone_verified_at'),
  /** bcrypt hash. Null for accounts made before passwords existed; they set one with "Forgot password". */
  passwordHash: text('password_hash'),
  passwordSetAt: ts('password_set_at'),
  name: text('name').notNull().default(''),
  email: text('email'),
  gender: text('gender'),
  dob: ts('dob'),
  city: text('city'),
  state: text('state'),
  bio: text('bio').notNull().default(''),
  crafts: strArr('crafts'),
  languages: strArr('languages'),
  skills: strArr('skills'),
  experience: text('experience'),
  heightCm: integer('height_cm'),
  avatarUrl: text('avatar_url'),
  coverUrl: text('cover_url'),
  instagram: text('instagram'),
  youtube: text('youtube'),
  isMinor: boolean('is_minor').notNull().default(false),
  guardianName: text('guardian_name'),
  guardianRelation: text('guardian_relation'),
  guardianPhone: text('guardian_phone'),
  guardianConsentAt: ts('guardian_consent_at'),
  verified: boolean('verified').notNull().default(false),
  status: userStatus('status').notNull().default('ACTIVE'),
  suspendedUntil: ts('suspended_until'),
  chatMutedUntil: ts('chat_muted_until'),
  warnings: integer('warnings').notNull().default(0),
  planId: text('plan_id').notNull().default('free').references(() => plans.id),
  planCycle: billingCycle('plan_cycle'),
  planUntil: ts('plan_until'),
  autoRenew: boolean('auto_renew').notNull().default(true),
  applicationsMonth: text('applications_month').notNull().default(''),
  applicationsCount: integer('applications_count').notNull().default(0),
  referralCode: text('referral_code').notNull().unique(),
  referredById: text('referred_by_id'),
  bonusDays: integer('bonus_days').notNull().default(0),
  prefs: jsonb('prefs').$type<Record<string, boolean>>().notNull().default({}),
  privacy: jsonb('privacy').$type<Record<string, boolean>>().notNull().default({}),
  profileViews: integer('profile_views').notNull().default(0),
  lastActiveAt: ts('last_active_at').notNull().defaultNow(),
  deletionRequestedAt: ts('deletion_requested_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('users_status_idx').on(t.status), index('users_plan_idx').on(t.planId), index('users_city_idx').on(t.city)]);

export const media = pgTable('media', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: mediaType('type').notNull(),
  url: text('url').notNull(),
  thumbUrl: text('thumb_url'),
  caption: text('caption').notNull().default(''),
  order: integer('order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('media_user_idx').on(t.userId)]);

export const follows = pgTable('follows', {
  followerId: text('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  followingId: text('following_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.followerId, t.followingId] })]);

export const blocks = pgTable('blocks', {
  blockerId: text('blocker_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedId: text('blocked_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]);

export const profileViews = pgTable('profile_views', {
  id: id(),
  viewedId: text('viewed_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  viewerId: text('viewer_id').references(() => users.id, { onDelete: 'set null' }),
  byAdmin: boolean('by_admin').notNull().default(false),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
}, (t) => [index('pv_viewed_idx').on(t.viewedId, t.createdAt)]);

export const savedSearches = pgTable('saved_searches', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  query: text('query').notNull(),
  alerts: boolean('alerts').notNull().default(true),
  createdAt: createdAt(),
});

/* ============================== Auth ============================== */
export const otpCodes = pgTable('otp_codes', {
  id: id(),
  phone: text('phone').notNull(),
  purpose: otpPurpose('purpose').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
  ip: text('ip'),
  provider: text('provider').notNull().default('dummy'),
  createdAt: createdAt(),
}, (t) => [index('otp_phone_idx').on(t.phone, t.createdAt)]);

export const admins = pgTable('admins', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  role: text('role').notNull(),
  status: adminStatus('status').notNull().default('INVITED'),
  inviteToken: text('invite_token').unique(),
  inviteExpiry: ts('invite_expiry'),
  lastActiveAt: ts('last_active_at'),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  adminId: text('admin_id').references(() => admins.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  userAgent: text('user_agent'),
  ip: text('ip'),
  createdAt: createdAt(),
});

export const rolePermissions = pgTable('role_permissions', {
  role: text('role').primaryKey(),
  modules: strArr('modules'),
});

/* ============================== Castings ============================== */
export const clients = pgTable('clients', {
  id: id(),
  company: text('company').notNull(),
  contactName: text('contact_name').notNull(),
  email: text('email').notNull().default(''),
  phone: text('phone').notNull().default(''),
  city: text('city').notNull().default(''),
  notes: text('notes').notNull().default(''),
  createdAt: createdAt(),
});

export const castings = pgTable('castings', {
  id: id(),
  code: text('code').notNull().unique(),
  title: text('title').notNull(),
  production: text('production').notNull(),
  showProductionAs: text('show_production_as').notNull().default('name'),
  projectType: text('project_type').notNull(),
  posterUrl: text('poster_url'),
  description: text('description').notNull(),
  location: text('location').notNull(),
  mode: text('mode').notNull().default('In person'),
  venue: text('venue').notNull().default(''),
  languages: strArr('languages'),
  budget: text('budget').notNull().default(''),
  deadline: ts('deadline').notNull(),
  visibility: visibility('visibility').notNull().default('ALL'),
  proEarlyAccessHours: integer('pro_early_access_hours').notNull().default(0),
  status: castingStatus('status').notNull().default('DRAFT'),
  publishAt: ts('publish_at'),
  publishedAt: ts('published_at'),
  featured: boolean('featured').notNull().default(false),
  urgent: boolean('urgent').notNull().default(false),
  sendAlert: boolean('send_alert').notNull().default(true),
  views: integer('views').notNull().default(0),
  reviewNote: text('review_note').notNull().default(''),
  postedByUserId: text('posted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdByAdminId: text('created_by_admin_id').references(() => admins.id, { onDelete: 'set null' }),
  clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('castings_status_idx').on(t.status, t.deadline), index('castings_poster_idx').on(t.postedByUserId)]);

export const castingRoles = pgTable('casting_roles', {
  id: id(),
  castingId: text('casting_id').notNull().references(() => castings.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  gender: text('gender').notNull().default('Any'),
  ageMin: integer('age_min').notNull().default(18),
  ageMax: integer('age_max').notNull().default(60),
  positions: integer('positions').notNull().default(1),
  heightNote: text('height_note').notNull().default(''),
  skills: strArr('skills'),
  experience: text('experience').notNull().default('Any'),
});

export const applications = pgTable('applications', {
  id: id(),
  castingId: text('casting_id').notNull().references(() => castings.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => castingRoles.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: applicationStatus('status').notNull().default('APPLIED'),
  tapeUrl: text('tape_url'),
  note: text('note').notNull().default(''),
  rating: integer('rating').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('app_casting_user_uq').on(t.castingId, t.userId), index('app_casting_status_idx').on(t.castingId, t.status)]);

export const applicationNotes = pgTable('application_notes', {
  id: id(),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  authorName: text('author_name').notNull(),
  byAdmin: boolean('by_admin').notNull().default(true),
  text: text('text').notNull(),
  createdAt: createdAt(),
});

export const round2Invites = pgTable('round2_invites', {
  applicationId: text('application_id').primaryKey().references(() => applications.id, { onDelete: 'cascade' }),
  date: ts('date').notNull(),
  venue: text('venue').notNull(),
  bring: text('bring').notNull().default(''),
  channels: strArr('channels'),
  sentAt: ts('sent_at').notNull().defaultNow(),
});

export const auditionDays = pgTable('audition_days', {
  id: id(),
  castingId: text('casting_id').notNull().references(() => castings.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  date: text('date').notNull(),
  start: text('start').notNull(),
  end: text('end').notNull(),
  slotMins: integer('slot_mins').notNull(),
  mode: text('mode').notNull().default('In person'),
  venue: text('venue').notNull(),
  bring: text('bring').notNull().default(''),
  remindersSentAt: ts('reminders_sent_at'),
  createdAt: createdAt(),
});

export const auditionSlots = pgTable('audition_slots', {
  id: id(),
  dayId: text('day_id').notNull().references(() => auditionDays.id, { onDelete: 'cascade' }),
  time: text('time').notNull(),
  applicationId: text('application_id').unique().references(() => applications.id, { onDelete: 'set null' }),
  status: slotStatus('status').notNull().default('OPEN'),
  note: text('note').notNull().default(''),
  /** A booked slot is confirmed and locked; the applicant can only ask the casting team to change it. */
  changeRequest: text('change_request'),
  changeRequestedAt: ts('change_requested_at'),
}, (t) => [uniqueIndex('slot_day_time_uq').on(t.dayId, t.time)]);

export const shortlistShares = pgTable('shortlist_shares', {
  id: id(),
  token: text('token').notNull().unique(),
  castingId: text('casting_id').notNull().references(() => castings.id, { onDelete: 'cascade' }),
  roleId: text('role_id'),
  clientId: text('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  message: text('message').notNull().default(''),
  showVideos: boolean('show_videos').notNull().default(true),
  showMeasurements: boolean('show_measurements').notNull().default(true),
  allowDownload: boolean('allow_download').notNull().default(false),
  passcodeHash: text('passcode_hash'),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  views: integer('views').notNull().default(0),
  lastViewedAt: ts('last_viewed_at'),
  submittedAt: ts('submitted_at'),
  createdByName: text('created_by_name').notNull(),
  createdAt: createdAt(),
});

export const shareItems = pgTable('share_items', {
  shareId: text('share_id').notNull().references(() => shortlistShares.id, { onDelete: 'cascade' }),
  applicationId: text('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  pick: text('pick'),
  comment: text('comment').notNull().default(''),
  pickedAt: ts('picked_at'),
}, (t) => [primaryKey({ columns: [t.shareId, t.applicationId] })]);

/* ============================== Payments ============================== */
export const coupons = pgTable('coupons', {
  id: id(),
  code: text('code').notNull().unique(),
  percent: integer('percent'),
  amountOff: integer('amount_off'),
  planIds: strArr('plan_ids'),
  cycles: billingCycle('cycles').array().notNull().default(sql`'{}'::billing_cycle[]`),
  maxUses: integer('max_uses'),
  used: integer('used').notNull().default(0),
  validFrom: ts('valid_from'),
  validTo: ts('valid_to'),
  active: boolean('active').notNull().default(true),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
});

export const payments = pgTable('payments', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  planId: text('plan_id').notNull(),
  cycle: billingCycle('cycle').notNull(),
  base: integer('base').notNull(),
  discount: integer('discount').notNull().default(0),
  gst: integer('gst').notNull(),
  amount: integer('amount').notNull(),
  gateway: gateway('gateway').notNull(),
  gatewayOrderId: text('gateway_order_id').notNull().unique(),
  gatewayPaymentId: text('gateway_payment_id'),
  status: paymentStatus('status').notNull().default('CREATED'),
  method: text('method'),
  couponCode: text('coupon_code'),
  refundAmount: integer('refund_amount').notNull().default(0),
  refundReason: text('refund_reason').notNull().default(''),
  refundId: text('refund_id'),
  refundedAt: ts('refunded_at'),
  failureReason: text('failure_reason'),
  invoiceNo: text('invoice_no').unique(),
  billing: jsonb('billing').$type<{ name?: string; email?: string; phone?: string; state?: string; gstin?: string }>().notNull().default({}),
  createdAt: createdAt(),
  paidAt: ts('paid_at'),
}, (t) => [index('payments_user_idx').on(t.userId), index('payments_status_idx').on(t.status, t.createdAt)]);

/* ============================== Trust & safety ============================== */
export const verificationRequests = pgTable('verification_requests', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  docType: text('doc_type').notNull(),
  docs: jsonb('docs').$type<{ label: string; url: string }[]>().notNull(),
  status: verifyStatus('status').notNull().default('PENDING'),
  reason: text('reason').notNull().default(''),
  reviewedBy: text('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  submittedAt: ts('submitted_at').notNull().defaultNow(),
}, (t) => [index('verif_status_idx').on(t.status)]);

export const reports = pgTable('reports', {
  id: id(),
  reporterId: text('reporter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reportedUserId: text('reported_user_id').references(() => users.id, { onDelete: 'set null' }),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  targetLabel: text('target_label').notNull(),
  reason: text('reason').notNull(),
  details: text('details').notNull().default(''),
  priority: text('priority').notNull().default('normal'),
  status: caseStatus('status').notNull().default('OPEN'),
  resolution: text('resolution').notNull().default(''),
  action: text('action').notNull().default(''),
  resolvedBy: text('resolved_by'),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
}, (t) => [index('reports_status_idx').on(t.status, t.priority)]);

export const posts = pgTable('posts', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: postType('type').notNull(),
  text: text('text').notNull().default(''),
  mediaUrl: text('media_url'),
  parentId: text('parent_id'),
  status: postStatus('status').notNull().default('VISIBLE'),
  flag: text('flag'),
  reportsCount: integer('reports_count').notNull().default(0),
  likesCount: integer('likes_count').notNull().default(0),
  removeReason: text('remove_reason').notNull().default(''),
  reviewedBy: text('reviewed_by'),
  createdAt: createdAt(),
}, (t) => [index('posts_status_idx').on(t.status, t.createdAt)]);

export const likes = pgTable('likes', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.postId] })]);

export const conversations = pgTable('conversations', {
  id: id(),
  aId: text('a_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bId: text('b_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastMessageAt: ts('last_message_at').notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('conv_pair_uq').on(t.aId, t.bId)]);

export const messages = pgTable('messages', {
  id: id(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  flagged: text('flagged'),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('msg_conv_idx').on(t.conversationId, t.createdAt)]);

export const chatReports = pgTable('chat_reports', {
  id: id(),
  reporterId: text('reporter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reportedId: text('reported_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  messageIds: strArr('message_ids'),
  status: caseStatus('status').notNull().default('OPEN'),
  resolution: text('resolution').notNull().default(''),
  action: text('action').notNull().default(''),
  resolvedBy: text('resolved_by'),
  createdAt: createdAt(),
});

export const dataRequests = pgTable('data_requests', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  requestedAt: ts('requested_at').notNull().defaultNow(),
  handledBy: text('handled_by'),
  handledAt: ts('handled_at'),
});

/* ============================== Engage ============================== */
export const notifications = pgTable('notifications', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  link: text('link'),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('notif_user_idx').on(t.userId, t.createdAt)]);

export const campaigns = pgTable('campaigns', {
  id: id(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  channels: strArr('channels'),
  segment: jsonb('segment').$type<{ plan: string; craft: string; city: string; inactiveDays: number }>().notNull(),
  link: text('link'),
  audience: integer('audience').notNull().default(0),
  status: text('status').notNull().default('draft'),
  scheduledAt: ts('scheduled_at'),
  sentAt: ts('sent_at'),
  delivered: integer('delivered').notNull().default(0),
  opened: integer('opened').notNull().default(0),
  clicked: integer('clicked').notNull().default(0),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
});

export const autoRules = pgTable('auto_rules', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  group: text('group').notNull(),
  channels: strArr('channels'),
  enabled: boolean('enabled').notNull().default(true),
  template: text('template').notNull(),
  sent7d: integer('sent_7d').notNull().default(0),
});

export const tickets = pgTable('tickets', {
  id: id(),
  number: serial('number').notNull().unique(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  category: text('category').notNull(),
  status: text('status').notNull().default('open'),
  priority: text('priority').notNull().default('normal'),
  assigneeId: text('assignee_id').references(() => admins.id, { onDelete: 'set null' }),
  channel: text('channel').notNull().default('app'),
  firstResponseMins: integer('first_response_mins'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('tickets_status_idx').on(t.status)]);

export const ticketMessages = pgTable('ticket_messages', {
  id: id(),
  ticketId: text('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  fromAdmin: boolean('from_admin').notNull(),
  name: text('name').notNull(),
  text: text('text').notNull(),
  internal: boolean('internal').notNull().default(false),
  createdAt: createdAt(),
});

export const cannedReplies = pgTable('canned_replies', {
  id: id(),
  title: text('title').notNull(),
  text: text('text').notNull(),
});

/* ============================== System ============================== */
export const catalogueItems = pgTable('catalogue_items', {
  id: id(),
  list: text('list').notNull(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  order: integer('order').notNull().default(0),
}, (t) => [uniqueIndex('catalogue_list_name_uq').on(t.list, t.name)]);

/** Plain settings (general, features, uploads, home page …). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
});

/** Secrets (gateway keys, SMS keys). AES-256-GCM encrypted; only the last 4 characters are ever returned. */
export const secretSettings = pgTable('secret_settings', {
  key: text('key').primaryKey(),
  cipher: text('cipher').notNull(),
  hint: text('hint').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
});

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  adminId: text('admin_id').references(() => admins.id, { onDelete: 'set null' }),
  actorName: text('actor_name').notNull(),
  module: text('module').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull().default(''),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('audit_created_idx').on(t.createdAt), index('audit_module_idx').on(t.module)]);

/* ============================== Relations (for db.query) ============================== */
export const usersRelations = relations(users, ({ one, many }) => ({
  plan: one(plans, { fields: [users.planId], references: [plans.id] }),
  media: many(media),
}));
export const mediaRelations = relations(media, ({ one }) => ({ user: one(users, { fields: [media.userId], references: [users.id] }) }));
export const plansRelations = relations(plans, ({ many }) => ({ prices: many(planPrices) }));
export const planPricesRelations = relations(planPrices, ({ one }) => ({ plan: one(plans, { fields: [planPrices.planId], references: [plans.id] }) }));
export const castingsRelations = relations(castings, ({ one, many }) => ({
  roles: many(castingRoles),
  applications: many(applications),
  postedBy: one(users, { fields: [castings.postedByUserId], references: [users.id] }),
  client: one(clients, { fields: [castings.clientId], references: [clients.id] }),
}));
export const castingRolesRelations = relations(castingRoles, ({ one }) => ({ casting: one(castings, { fields: [castingRoles.castingId], references: [castings.id] }) }));
export const applicationsRelations = relations(applications, ({ one, many }) => ({
  casting: one(castings, { fields: [applications.castingId], references: [castings.id] }),
  role: one(castingRoles, { fields: [applications.roleId], references: [castingRoles.id] }),
  user: one(users, { fields: [applications.userId], references: [users.id] }),
  notes: many(applicationNotes),
  round2: one(round2Invites, { fields: [applications.id], references: [round2Invites.applicationId] }),
}));
export const applicationNotesRelations = relations(applicationNotes, ({ one }) => ({ application: one(applications, { fields: [applicationNotes.applicationId], references: [applications.id] }) }));
export const round2Relations = relations(round2Invites, ({ one }) => ({ application: one(applications, { fields: [round2Invites.applicationId], references: [applications.id] }) }));
export const auditionDaysRelations = relations(auditionDays, ({ many, one }) => ({ slots: many(auditionSlots), casting: one(castings, { fields: [auditionDays.castingId], references: [castings.id] }) }));
export const auditionSlotsRelations = relations(auditionSlots, ({ one }) => ({ day: one(auditionDays, { fields: [auditionSlots.dayId], references: [auditionDays.id] }) }));
export const sharesRelations = relations(shortlistShares, ({ many, one }) => ({ items: many(shareItems), client: one(clients, { fields: [shortlistShares.clientId], references: [clients.id] }), casting: one(castings, { fields: [shortlistShares.castingId], references: [castings.id] }) }));
export const shareItemsRelations = relations(shareItems, ({ one }) => ({ share: one(shortlistShares, { fields: [shareItems.shareId], references: [shortlistShares.id] }), application: one(applications, { fields: [shareItems.applicationId], references: [applications.id] }) }));
export const ticketsRelations = relations(tickets, ({ many, one }) => ({ messages: many(ticketMessages), user: one(users, { fields: [tickets.userId], references: [users.id] }) }));
export const ticketMessagesRelations = relations(ticketMessages, ({ one }) => ({ ticket: one(tickets, { fields: [ticketMessages.ticketId], references: [tickets.id] }) }));

export type User = typeof users.$inferSelect;
export type Admin = typeof admins.$inferSelect;
export type Casting = typeof castings.$inferSelect;
export type CastingRole = typeof castingRoles.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type AuditionDay = typeof auditionDays.$inferSelect;
export type AuditionSlot = typeof auditionSlots.$inferSelect;
