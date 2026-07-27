import { Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Parse a JSON string, returning undefined instead of throwing on bad input. */
function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** One callable tool the agent can invoke. `parameters` is a JSON Schema object.
 *  Local tools read ReachPilot data; Apify MCP tools (Phase 3) implement the
 *  same shape, so the agent loop never needs to know where a tool came from. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any, ctx: AgentContext) => Promise<unknown>;
}

export interface AgentContext {
  workspaceId: string;
  userId?: string;
}

/** A chat turn as the frontend sends it. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool call + its result, persisted with the assistant turn and re-rendered
 *  as a collapsible card in the UI. */
export interface ToolTrace {
  name: string;
  args?: unknown;
  ok?: boolean;
  result?: unknown;
}

/** Streamed agent events (SSE). The UI renders each as it arrives. */
export type AgentEvent =
  | { type: 'conversation'; id: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; result: unknown }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

const SYSTEM_PREAMBLE = [
  'You are ReachPilot Assistant, an AI teammate inside a B2B LinkedIn + email',
  'outreach tool. You help the user find leads, review their pipeline, draft',
  'outreach, and answer questions about their account. Use the provided tools to',
  'look up real data before answering — never invent lead names, counts, or',
  'account status. Keep replies concise and action-oriented. When you take an',
  'action or show data, briefly say what you did.',
].join(' ');

/**
 * Agentic chat over Google Gemini with function-calling. Runs the tool loop:
 * user turn → model (may emit functionCalls) → execute tools → feed results back
 * → repeat until the model returns a final text answer. Events are pushed to the
 * caller as they happen so the UI can show tool calls live (Claude-style).
 *
 * The tool set is injectable: today it's local ReachPilot lookups; Phase 3 adds
 * Apify MCP tools to the same list with zero loop changes.
 */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  isConfigured(): boolean {
    return !!getEnv().GEMINI_API_KEY;
  }

  /** The built-in ReachPilot tools. Apify MCP tools get appended in Phase 3. */
  localTools(): AgentTool[] {
    return [
      {
        name: 'search_leads',
        description:
          'Search the workspace\'s leads by name, company, title, or status. Returns up to 20 matches with their key fields.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free text to match against name/company/title. Empty = most recent.' },
            status: { type: 'string', description: 'Optional lead status filter, e.g. new, invited, accepted, replied.' },
          },
        },
        execute: async (args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            let q = db
              .selectFrom('leads')
              .select(['full_name', 'company', 'title', 'status', 'linkedin_url', 'email'])
              .where('workspace_id', '=', ctx.workspaceId)
              .limit(20);
            const text = (args?.query || '').trim();
            if (text) {
              q = q.where((eb) =>
                eb.or([
                  eb('full_name', 'ilike', `%${text}%`),
                  eb('company', 'ilike', `%${text}%`),
                  eb('title', 'ilike', `%${text}%`),
                ]),
              );
            }
            if (args?.status) q = q.where('status', '=', String(args.status));
            const rows = await q.orderBy('created_at', 'desc').execute();
            return { count: rows.length, leads: rows };
          }),
      },
      {
        name: 'get_account_status',
        description:
          'Get the connected LinkedIn account status and warm-up state (daily limit, day, connection status).',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const acct = await db
              .selectFrom('linkedin_accounts')
              .select(['email', 'status', 'warmup_daily_limit', 'warmup_target', 'weekly_invite_cap', 'connected_at'])
              .where('workspace_id', '=', ctx.workspaceId)
              .orderBy('connected_at', 'desc')
              .limit(1)
              .executeTakeFirst();
            return acct || { connected: false };
          }),
      },
      {
        name: 'list_campaigns',
        description: 'List the workspace\'s campaigns with their status and lead counts.',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const rows = await db
              .selectFrom('campaigns')
              .select(['name', 'status', 'created_at'])
              .where('workspace_id', '=', ctx.workspaceId)
              .orderBy('created_at', 'desc')
              .limit(25)
              .execute();
            return { count: rows.length, campaigns: rows };
          }),
      },
      {
        name: 'get_connections',
        description:
          'LinkedIn connection-request outcomes: counts by status (sent, queued, scheduled, failed) plus the 10 most recent with names.',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const byStatus = await db
              .selectFrom('jobs')
              .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
              .where('workspace_id', '=', ctx.workspaceId)
              .where('kind', '=', 'linkedin')
              .groupBy('status')
              .execute();
            const recentRows = await db
              .selectFrom('jobs')
              .select(['status', 'sent_at', 'payload'])
              .where('workspace_id', '=', ctx.workspaceId)
              .where('kind', '=', 'linkedin')
              .orderBy('created_at', 'desc')
              .limit(10)
              .execute();
            const recent = recentRows.map((r) => {
              const p = typeof r.payload === 'string' ? safeJson(r.payload) : (r.payload as any);
              return { status: r.status, sent_at: r.sent_at, name: p?.name };
            });
            return { byStatus, recent };
          }),
      },
      {
        name: 'get_stats',
        description: 'Aggregate outreach stats for the workspace: total invites sent, accepted, replies, and emails sent.',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const row = await db
              .selectFrom('daily_stats')
              .select((eb) => [
                eb.fn.sum<number>('invites_sent').as('invites_sent'),
                eb.fn.sum<number>('accepted').as('accepted'),
                eb.fn.sum<number>('replies').as('replies'),
                eb.fn.sum<number>('emails_sent').as('emails_sent'),
              ])
              .where('workspace_id', '=', ctx.workspaceId)
              .executeTakeFirst();
            return row || { invites_sent: 0, accepted: 0, replies: 0, emails_sent: 0 };
          }),
      },
      {
        name: 'get_inbox',
        description: 'Recent inbox threads (LinkedIn + email conversations) with unread flags and last-activity time.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'How many threads (max 25).' } },
        },
        execute: async (args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const threads = await db
              .selectFrom('threads')
              .select(['id', 'channel', 'unread', 'last_message_at', 'lead_id'])
              .where('workspace_id', '=', ctx.workspaceId)
              .orderBy('last_message_at', 'desc')
              .limit(Math.min(Number(args?.limit) || 10, 25))
              .execute();
            return { count: threads.length, threads };
          }),
      },
      {
        name: 'list_email_accounts',
        description: 'Connected email mailboxes used for sending and the email warm-up loop, with status.',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const rows = await db
              .selectFrom('email_accounts')
              .select(['email', 'provider', 'status', 'connected_at'])
              .where('workspace_id', '=', ctx.workspaceId)
              .execute();
            return { count: rows.length, mailboxes: rows };
          }),
      },
      {
        name: 'get_recent_activity',
        description: 'Recent workspace activity feed — sends, connects, and system events, newest first.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'How many entries (max 30).' } },
        },
        execute: async (args, ctx) =>
          withWorkspace(ctx.workspaceId, async (db) => {
            const rows = await db
              .selectFrom('activity')
              .select(['text', 'tone', 'created_at'])
              .where('workspace_id', '=', ctx.workspaceId)
              .orderBy('created_at', 'desc')
              .limit(Math.min(Number(args?.limit) || 15, 30))
              .execute();
            return { count: rows.length, activity: rows };
          }),
      },
    ];
  }

  /**
   * Run the agent for one user turn. `history` is the prior conversation; `tools`
   * defaults to the local set. `emit` is called for every event. Returns when the
   * model produces a final answer (or the tool-call budget is exhausted).
   */
  async run(
    history: ChatMessage[],
    ctx: AgentContext,
    emit: (e: AgentEvent) => void,
    tools: AgentTool[] = this.localTools(),
  ): Promise<void> {
    if (!this.isConfigured()) {
      emit({ type: 'error', message: 'AI is not configured (GEMINI_API_KEY missing).' });
      emit({ type: 'done' });
      return;
    }

    const byName = new Map(tools.map((t) => [t.name, t]));
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Seed Gemini contents from the chat history (assistant → "model").
    const contents: any[] = history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const MAX_STEPS = 6; // tool-call rounds before we force a text answer
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const data = await this.generate(contents, functionDeclarations);
        const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
        const callParts = parts.filter((p) => p.functionCall);
        const calls = callParts.map((p) => p.functionCall);

        if (calls.length === 0) {
          const text = parts.map((p) => p?.text || '').join('').trim();
          if (text) emit({ type: 'text', text });
          emit({ type: 'done' });
          return;
        }

        // Echo the model's function-call turn back VERBATIM — the original parts
        // carry a `thoughtSignature` (Gemini 3+) that must be preserved, or the
        // next call is rejected. Reconstructing `{functionCall}` drops it.
        contents.push({ role: 'model', parts: callParts });
        const responseParts: any[] = [];
        for (const call of calls) {
          emit({ type: 'tool_call', name: call.name, args: call.args || {} });
          const tool = byName.get(call.name);
          let result: unknown;
          let ok = true;
          try {
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);
            result = await tool.execute(call.args || {}, ctx);
          } catch (e: any) {
            ok = false;
            result = { error: String(e?.message || e) };
          }
          emit({ type: 'tool_result', name: call.name, ok, result });
          responseParts.push({ functionResponse: { name: call.name, response: this.wrap(result) } });
        }
        // Function responses go in a USER turn. (Older Gemini docs show role
        // "function", but the current models reject it — valid roles are
        // USER/MODEL/etc. — so the functionResponse parts ride a user turn.)
        contents.push({ role: 'user', parts: responseParts });
      }
      // Budget exhausted — ask for a plain summary with tools disabled.
      const finalData = await this.generate(contents, undefined);
      const text =
        (finalData?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || '').join('').trim();
      emit({ type: 'text', text: text || 'I ran out of steps before finishing. Please refine the request.' });
      emit({ type: 'done' });
    } catch (e: any) {
      this.logger.warn({ err: String(e?.message || e) }, 'Agent run failed');
      emit({ type: 'error', message: String(e?.message || e) });
      emit({ type: 'done' });
    }
  }

  /** Gemini functionResponse.response must be a JSON object — wrap primitives/arrays. */
  private wrap(result: unknown): Record<string, unknown> {
    if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
    return { result };
  }

  private async generate(contents: any[], functionDeclarations?: any[]): Promise<any> {
    const env = getEnv();
    const url = `${GEMINI_BASE}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`;
    const body: any = {
      systemInstruction: { parts: [{ text: SYSTEM_PREAMBLE }] },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    };
    if (functionDeclarations?.length) body.tools = [{ functionDeclarations }];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
