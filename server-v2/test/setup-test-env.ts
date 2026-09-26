/**
 * Jest setupFile: loads .env.test (local Postgres + Redis) before
 * src/config/env.ts reads .env, which points at PRODUCTION (whose scheduler
 * would claim test jobs). dotenv never overwrites existing values, so these win.
 * Local services: see CLAUDE.md. Without .env.test, DB suites skip themselves.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.test') });
