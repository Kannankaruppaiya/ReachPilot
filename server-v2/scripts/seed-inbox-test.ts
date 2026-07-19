import { withWorkspace } from '../src/db/rls';

// Dev workspace (AUTH_BYPASS user's workspace).
const WS = '00000000-0000-0000-0000-000000000010';

async function run() {
  await withWorkspace(WS, async (db) => {
    // A lead we've "emailed" — email points to the connected mailbox so the
    // reply we send in the test lands somewhere safe.
    const lead = await db
      .insertInto('leads')
      .values({
        workspace_id: WS,
        full_name: 'Priya Sharma',
        first_name: 'Priya',
        title: 'Head of Talent Acquisition',
        company: 'Zylker Technologies',
        email: 'honeykannan27@gmail.com',
        location: 'Bengaluru, India',
        status: 'replied',
        tags: ['Hot', 'Recruiting'],
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow();

    const thread = await db
      .insertInto('threads')
      .values({
        workspace_id: WS,
        lead_id: lead.id,
        channel: 'email',
        unread: true,
        last_message_at: new Date().toISOString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Our outbound + their inbound reply.
    await db
      .insertInto('messages')
      .values([
        {
          thread_id: thread.id,
          direction: 'me',
          channel: 'email',
          subject: 'Scaling outbound at Zylker',
          body: "Hi Priya, loved Zylker's latest hiring push — we help talent teams automate outreach safely. Open to connecting?",
          sent_at: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          thread_id: thread.id,
          direction: 'them',
          channel: 'email',
          subject: 'Re: Scaling outbound at Zylker',
          body: 'Thanks for reaching out! Happy to chat next week — send me a few slots.',
          external_id: 'seed_' + Math.random().toString(36).slice(2),
          sent_at: new Date().toISOString(),
        },
      ] as any)
      .execute();

    console.log('Seeded thread', thread.id, 'for lead', lead.id);
  });
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
