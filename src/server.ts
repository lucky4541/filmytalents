import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { pool } from './db';
import { attachRealtime } from './realtime';
import { startJobs, stopJobs } from './jobs';
import { runMigrations } from './db/migrate';

const app = createApp();
const server = http.createServer(app);
attachRealtime(server);

// Bring the database up to date before taking requests, so new code never runs against old tables.
runMigrations()
  .then(() => {
    logger.info('Database is up to date');
    startJobs();
    server.listen(env.PORT, () => logger.info(`🎬 FilmyTalents API on http://localhost:${env.PORT} (OTP: ${env.OTP_PROVIDER})`));
  })
  .catch((err) => {
    logger.error({ err }, 'Database update failed. Fix the error above, or run "npm run db:migrate" to see details.');
    process.exit(1);
  });

const shutdown = async () => {
  logger.info('Shutting down…');
  stopJobs();
  server.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
