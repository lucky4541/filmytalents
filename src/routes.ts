import type { Express } from 'express';
import memberAuth from './modules/auth/member.routes';
import adminAuth from './modules/auth/admin.routes';
import team from './modules/team/routes';
import me from './modules/members/me.routes';
import talent from './modules/members/talent.routes';
import adminUsers from './modules/members/admin.routes';
import { dataRequests, verification } from './modules/members/review.routes';
import { myApplications, publicCastings } from './modules/castings/public.routes';
import posterCastings from './modules/castings/poster.routes';
import adminCastings, { clientsRouter } from './modules/castings/admin.routes';
import share from './modules/castings/share.routes';
import memberPayments, { plansRouter } from './modules/payments/member.routes';
import webhooks from './modules/payments/webhooks';
import { adminCoupons, adminGateways, adminPayments, adminPlans } from './modules/payments/admin.routes';
import notifications from './modules/engage/notifications.routes';
import { engage } from './modules/engage/admin.routes';
import { adminSupport, memberSupport } from './modules/engage/support.routes';
import chat from './modules/engage/chat.routes';
import postsRouter from './modules/moderation/posts.routes';
import { memberReports, moderation } from './modules/moderation/reports.routes';
import { site } from './modules/system/site.routes';
import { adminAudit, adminCatalogue, adminSettings, adminSystem } from './modules/system/admin.routes';
import { dashboard } from './modules/system/dashboard.routes';
import { adminUploads } from './modules/system/upload.routes';

/** Every module adds its routes here. Member routes: /api/v1/…  Admin routes: /api/v1/admin/… */
export function registerRoutes(app: Express) {
  app.use('/api/v1/auth', memberAuth);
  app.use('/api/v1/admin/auth', adminAuth);
  app.use('/api/v1/admin/team', team);

  // Module 3: members
  app.use('/api/v1/me', me);
  app.use('/api/v1/talent', talent);
  app.use('/api/v1/admin/users', adminUsers);
  app.use('/api/v1/admin/verification', verification);
  app.use('/api/v1/admin/data-requests', dataRequests);

  // Module 4: castings
  app.use('/api/v1/castings', publicCastings);
  app.use('/api/v1/applications', myApplications);
  app.use('/api/v1/my-castings', posterCastings);
  app.use('/api/v1/admin/castings', adminCastings);
  app.use('/api/v1/admin/clients', clientsRouter);
  app.use('/api/v1/share', share);

  // Module 5: payments
  app.use('/api/v1/plans', plansRouter);
  app.use('/api/v1/payments', memberPayments);
  app.use('/api/v1/webhooks', webhooks);
  app.use('/api/v1/admin/payments', adminPayments);
  app.use('/api/v1/admin/plans', adminPlans);
  app.use('/api/v1/admin/coupons', adminCoupons);
  app.use('/api/v1/admin/settings/payments', adminGateways);

  // Module 6: engage & moderation
  app.use('/api/v1/notifications', notifications);
  app.use('/api/v1/support', memberSupport);
  app.use('/api/v1/chat', chat);
  app.use('/api/v1/posts', postsRouter);
  app.use('/api/v1/reports', memberReports);
  app.use('/api/v1/admin/engage', engage);
  app.use('/api/v1/admin/support', adminSupport);
  app.use('/api/v1/admin/moderation', moderation);

  // Module 7: system
  app.use('/api/v1/site', site);
  app.use('/api/v1/admin/settings', adminSettings);
  app.use('/api/v1/admin/catalogue', adminCatalogue);
  app.use('/api/v1/admin/audit', adminAudit);
  app.use('/api/v1/admin/system', adminSystem);
  app.use('/api/v1/admin/dashboard', dashboard);
  app.use('/api/v1/admin/uploads', adminUploads);
}
