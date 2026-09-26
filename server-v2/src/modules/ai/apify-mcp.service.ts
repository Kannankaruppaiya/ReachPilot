import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import type { AgentTool } from './ai-agent.service';

/** A connected Apify tool set plus a disposer to close the MCP session. */
export interface ApifyToolSet {
  tools: AgentTool[];
  dispose: () => Promise<void>;
}

/** JSON Schema keys Gemini accepts; everything else is dropped from MCP schemas. */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'properties',
  'items',
  'required',
  'enum',
  'format',
  'nullable',
  'minimum',
  'maximum',
]);

function cleanSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { type: 'string' };
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // JSON Schema allows `type: ["string","null"]`; Gemini wants one type + nullable.
  let type = src.type;
  if (Array.isArray(type)) {
    const nonNull = type.find((t) => t !== 'null');
    if (type.includes('null')) out.nullable = true;
    type = nonNull ?? 'string';
  }
  if (typeof type === 'string') out.type = type;

  for (const [k, v] of Object.entries(src)) {
    if (k === 'type' || !ALLOWED_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, cleanSchema(pv)]),
      );
    } else if (k === 'items') {
      out.items = cleanSchema(v);
    } else {
      out[k] = v;
    }
  }
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Gemini function names allow only letters, digits, _ . -; mapped back on call. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 63);
}

/**
 * Exposes the hosted Apify MCP server's tools to the agent as {@link AgentTool}s,
 * using the workspace's own encrypted Apify token. No token, no tools.
 */
@Injectable()
export class ApifyMcpService {
  private readonly logger = new Logger(ApifyMcpService.name);

  constructor(private readonly secrets: SecretsService) {}

  /** Open an MCP session against Apify with the given token + enabled tool set. */
  private async connect(token: string, enabledTools: string): Promise<Client> {
    const url = new URL(getEnv().APIFY_MCP_URL);
    if (enabledTools.trim()) url.searchParams.set('tools', enabledTools.trim());

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'reachpilot-assistant', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  /** Validate a token by listing tools; throws a readable error on failure. */
  async verifyToken(token: string, enabledTools: string): Promise<{ toolCount: number }> {
    let client: Client | undefined;
    try {
      client = await this.connect(token, enabledTools);
      const { tools } = await client.listTools();
      return { toolCount: tools.length };
    } catch (e: any) {
      throw new Error(`Couldn't reach Apify with that token: ${String(e?.message || e).slice(0, 200)}`);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  /**
   * The workspace's Apify tools, sharing one MCP session (call `dispose()` when the
   * run ends). Empty set when Apify isn't connected or unreachable.
   */
  async toolsFor(workspaceId: string): Promise<ApifyToolSet> {
    const empty: ApifyToolSet = { tools: [], dispose: async () => undefined };

    const row = await withWorkspace(workspaceId, async (db) =>
      db
        .selectFrom('integrations')
        .select(['credentials_secret_id', 'config', 'active'])
        // Explicit workspace scope: never decrypt another tenant's token.
        .where('workspace_id', '=', workspaceId)
        .where('provider', '=', 'apify')
        .where('active', '=', true)
        .executeTakeFirst(),
    );
    if (!row?.credentials_secret_id) return empty;

    const config = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as
      | { enabledTools?: string }
      | null;
    const enabledTools = config?.enabledTools || getEnv().APIFY_MCP_DEFAULT_TOOLS;

    let token: string;
    try {
      token = await this.secrets.decrypt(row.credentials_secret_id, { workspaceId });
    } catch (e: any) {
      this.logger.warn(`Apify token decrypt failed for ${workspaceId}: ${String(e?.message || e)}`);
      return empty;
    }

    let client: Client;
    try {
      client = await this.connect(token, enabledTools);
    } catch (e: any) {
      this.logger.warn(`Apify MCP connect failed for ${workspaceId}: ${String(e?.message || e)}`);
      return empty;
    }

    let mcpTools;
    try {
      ({ tools: mcpTools } = await client.listTools());
    } catch (e: any) {
      this.logger.warn(`Apify listTools failed for ${workspaceId}: ${String(e?.message || e)}`);
      await client.close().catch(() => undefined);
      return empty;
    }

    const tools: AgentTool[] = mcpTools.map((t) => {
      const realName = t.name;
      return {
        name: sanitizeName(realName),
        description: `[Apify] ${t.description || realName}`.slice(0, 1024),
        parameters: cleanSchema(t.inputSchema),
        execute: async (args: any) => {
          const res: any = await client.callTool({ name: realName, arguments: args || {} });
          return this.flatten(res);
        },
      };
    });

    this.logger.log(`Apify MCP: ${tools.length} tools available for workspace ${workspaceId}`);
    return { tools, dispose: async () => void client.close().catch(() => undefined) };
  }

  /** Reduce an MCP tool result to something small and JSON-friendly for the model. */
  private flatten(res: any): unknown {
    const parts: string[] = [];
    for (const c of res?.content || []) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
    const text = parts.join('\n').trim();
    const payload = text ? this.tryJson(text) : res?.structuredContent ?? res;
    return { isError: !!res?.isError, result: payload };
  }

  private tryJson(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return s.length > 6000 ? s.slice(0, 6000) + '…(truncated)' : s;
    }
  }
}
