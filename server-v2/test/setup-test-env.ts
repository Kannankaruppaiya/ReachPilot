/**
 * Jest setupFile — runs BEFORE any test module (and therefore before
 * src/config/env.ts calls dotenv on the real .env).
 *
 * WHY: the main .env points DATABASE_URL at the PRODUCTION Supabase database.
 * The live worker on the Oracle box runs a scheduler tick every 30s that
 * enumerates EVERY workspace in that database — including any workspace a test
 * creates. That was observed for real: a test batch's jobs were claimed and
 * enqueued by the production scheduler mid-test, which both corrupted the test
 * and put fake jobs in front of the live worker.
 *
 * So tests load .env.test (local Postgres + local Redis) first. dotenv does not
 * overwrite variables already present in process.env, so these values win.
 *
 * Bring the local services up with:
 *   docker run -d --name rp-test-redis -p 6379:6379 redis:7-alpine
 *   docker run -d --name rp-test-pg -p 55432:5432 \
 *     -e POSTGRES_USER=reachpilot -e POSTGRES_PASSWORD=reachpilot \
 *     -e POSTGRES_DB=reachpilot postgres:15-alpine
 *   DATABASE_URL=postgresql://reachpilot:reachpilot@127.0.0.1:55432/reachpilot \
 *     npx ts-node -r tsconfig-paths/register scripts/migrate.ts
 *
 * If .env.test is absent nothing is overridden — suites that require a local
 * database detect that themselves and skip rather than touching production.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.test') });
