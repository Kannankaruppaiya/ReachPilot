import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { getEnv } from '../src/config/env';

const SEED_XLSX = path.resolve(__dirname, '../../public/sample.xlsx');

function pickSheetRows(wb: XLSX.WorkBook) {
  let best = null;
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[name], { defval: '' });
    if (!rows.length) continue;
    const hdrs = Object.keys(rows[0]).map((h) => h.toLowerCase());
    const score =
      (hdrs.some((h) => h.includes('linkedin')) ? 2 : 0) +
      (hdrs.some((h) => h === 'name' || h.includes('name')) ? 1 : 0);
    if (!best || score > best.score) best = { rows, score };
  }
  return best && best.score >= 2 ? best.rows : [];
}

async function run() {
  const env = getEnv();
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    const defaultUserId = '00000000-0000-0000-0000-000000000001';
    const defaultWorkspaceId = '00000000-0000-0000-0000-000000000010';

    console.log('Seeding default workspace and memberships...');

    // Ensure default user & workspace exist (for dev bypass)
    await client.query(`
      INSERT INTO users (id, email, full_name)
      VALUES ($1, 'dev@reachpilot.dev', 'Dev User')
      ON CONFLICT (id) DO NOTHING;
    `, [defaultUserId]);

    await client.query(`
      INSERT INTO workspaces (id, name, goal, onboarding_step)
      VALUES ($1, 'Default Workspace', 'Sales', 6)
      ON CONFLICT (id) DO NOTHING;
    `, [defaultWorkspaceId]);

    await client.query(`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner')
      ON CONFLICT (workspace_id, user_id) DO NOTHING;
    `, [defaultWorkspaceId, defaultUserId]);

    console.log('Seeding default templates...');
    const templates = [
      {
        name: 'Warm intro — mutual interest',
        channel: 'linkedin',
        body: "Hi {{firstName|there}},saw your work at {{company}} — impressive. I help teams like {{company}} automate outreach without risking their accounts. Open to connecting?",
      },
      {
        name: 'Recruiter outreach',
        channel: 'linkedin',
        body: "Hi {{firstName|there}}, we're helping teams like {{company}} hire faster. Would love to connect and share notes.",
      },
      {
        name: 'Email — first touch',
        channel: 'email',
        subject: 'Scaling outbound at {{company}}',
        body: "Hi {{firstName|there}},\n\nI came across your profile at {{company}} and wanted to reach out about an opportunity that fits your experience as {{title}}.\n\nOpen to a quick chat this week?",
      },
    ];

    for (const t of templates) {
      await client.query(`
        INSERT INTO templates (workspace_id, name, channel, subject, body)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING;
      `, [defaultWorkspaceId, t.name, t.channel, t.subject || null, t.body]);
    }

    console.log('Parsing and seeding leads from sample.xlsx...');
    let leads: any[] = [];
    if (fs.existsSync(SEED_XLSX)) {
      try {
        const wb = XLSX.read(fs.readFileSync(SEED_XLSX), { type: 'buffer' });
        const rows = pickSheetRows(wb);
        const get = (row: any, ...keys: string[]) => {
          for (const k of Object.keys(row)) {
            const lk = k.toLowerCase();
            if (keys.some((want) => lk.includes(want))) return String(row[k]).trim();
          }
          return '';
        };

        leads = rows
          .map((row: any) => {
            const name = get(row, 'name');
            const url = get(row, 'linkedin');
            if (!name || !url) return null;
            const rawEmail = get(row, 'email');
            const email = /@/.test(rawEmail) ? rawEmail : '';
            const tier = get(row, 'tier');
            return {
              name,
              firstName: name.split(' ')[0],
              title: get(row, 'role', 'title', 'designation'),
              company: get(row, 'company', 'organi'),
              location: get(row, 'location'),
              linkedinUrl: url,
              email,
              emailVerified: Boolean(email),
              status: 'new',
              source: 'Candidate Excel import',
              tags: tier ? [tier] : [],
              lastActivity: 'Imported',
            };
          })
          .filter(Boolean);
      } catch (e: any) {
        console.warn('Excel parse failed:', e.message);
      }
    }

    if (leads.length === 0) {
      console.log('No excel data parsed. Seeding default fallback leads...');
      leads = [
        {
          name: 'Priya Sharma',
          firstName: 'Priya',
          title: 'Head of Talent Acquisition',
          company: 'Zylker Technologies',
          location: 'Bengaluru, India',
          linkedinUrl: 'https://www.linkedin.com/in/priyasharma-mock',
          email: 'priya.sharma@zylker.com',
          emailVerified: true,
          status: 'replied',
          source: 'Initial seed',
          tags: ['Hot', 'Recruiting'],
          lastActivity: 'Replied 2h ago',
        },
        {
          name: 'Marcus Chen',
          firstName: 'Marcus',
          title: 'VP of Sales',
          company: 'Northwind Analytics',
          location: 'Austin, TX',
          linkedinUrl: 'https://www.linkedin.com/in/marcuschen-mock',
          email: 'm.chen@northwind.io',
          emailVerified: false,
          status: 'invited',
          source: 'Initial seed',
          tags: ['SaaS'],
          lastActivity: 'Invite sent yesterday',
        },
      ];
    }

    for (const l of leads) {
      await client.query(`
        INSERT INTO leads (workspace_id, full_name, first_name, title, company, location, linkedin_url, email, email_verified, status, source, tags, last_activity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT DO NOTHING;
      `, [
        defaultWorkspaceId,
        l.name,
        l.firstName,
        l.title,
        l.company,
        l.location,
        l.linkedinUrl,
        l.email || null,
        l.emailVerified,
        l.status,
        l.source,
        l.tags,
        l.lastActivity,
      ]);
    }

    console.log(`Seeded ${leads.length} leads successfully.`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
