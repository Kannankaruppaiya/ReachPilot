import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { getEnv } from '../src/config/env';

async function run() {
  const env = getEnv();
  console.log(`Connecting to database: ${env.DATABASE_URL.replace(/:[^:]+@/, ':****@')}`);

  const client = new Client({
    connectionString: env.DATABASE_URL,
  });

  await client.connect();

  try {
    // Check if we need to create migrations metadata table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.resolve(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir).sort();

    for (const file of files) {
      if (!file.endsWith('.sql')) continue;

      const check = await client.query('SELECT 1 FROM migrations_log WHERE name = $1', [file]);
      if (check.rowCount && check.rowCount > 0) {
        console.log(`Migration ${file} already applied.`);
        continue;
      }

      console.log(`Applying migration ${file}...`);
      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        await client.query('INSERT INTO migrations_log (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Migration ${file} applied successfully.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error applying migration ${file}:`, err);
        throw err;
      }
    }

    console.log('All migrations completed successfully.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Migration script failed:', err);
  process.exit(1);
});
