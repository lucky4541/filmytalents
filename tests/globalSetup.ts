import { execSync } from 'child_process';

/** Fresh test database for every run: drop everything, migrate, seed. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://castinghub:castinghub@localhost:5432/castinghub_test';
  const envs = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url };
  execSync(`psql "${url}" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;"`, { stdio: 'inherit', env: envs });
  execSync('npx tsx src/db/seed.ts', { stdio: 'inherit', env: envs });
}
