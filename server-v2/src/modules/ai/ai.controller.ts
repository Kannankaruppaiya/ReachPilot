import { Body, Controller, Delete, Get, Param, Post, Req, Res, BadRequestException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AiService, LeadContext, CampaignVoice } from './ai.service';
import { AiAgentService, ChatMessage, AgentEvent, ToolTrace } from './ai-agent.service';
import { ApifyMcpService } from './apify-mcp.service';
import { AiChatStoreService } from './ai-chat-store.service';
import { JwtPayload } from '@/common';

interface PreviewNoteBody {
  lead?: Partial<LeadContext>;
  voice?: CampaignVoice;
}

interface ChatBody {
  messages?: ChatMessage[];
  conversationId?: string;
}

/**
 * AI personalization endpoints. Protected by the global AuthGuard.
 *
 * `preview-note` is the tuning surface: send a prospect + campaign voice, get a
 * generated note back so you can eyeball tone/length before wiring generation
 * into the campaign enrollment flow. It never sends anything to LinkedIn.
 */
@Controller('api/ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly agent: AiAgentService,
    private readonly apify: ApifyMcpService,
    private readonly store: AiChatStoreService,
  ) {}

  /** Whether a Gemini key is configured (UI can show "AI on/off"). */
  @Get('status')
  status() {
    return { configured: this.ai.isConfigured() };
  }

  /** List the workspace's saved conversations (sidebar). */
  @Get('conversations')
  async conversations(@Req() req: Request) {
    const workspaceId = this.wsOf(req);
    return this.store.listConversations(workspaceId);
  }

  /** Load one conversation's messages. */
  @Get('conversations/:id')
  async conversation(@Param('id') id: string, @Req() req: Request) {
    const workspaceId = this.wsOf(req);
    return { id, messages: await this.store.getMessages(workspaceId, id) };
  }

  /** Delete a conversation. */
  @Delete('conversations/:id')
  async deleteConversation(@Param('id') id: string, @Req() req: Request) {
    const workspaceId = this.wsOf(req);
    await this.store.deleteConversation(workspaceId, id);
    return { ok: true };
  }

  private wsOf(req: Request): string {
    const user = (req as any).user as JwtPayload;
    return (req as any).workspaceId || user?.workspaceId;
  }

  /**
   * Agentic chat (Server-Sent Events). The body carries the full conversation;
   * we stream back the assistant's tool calls, tool results, and final text as
   * they happen so the UI can render them live (Claude-style). The workspace is
   * taken from the auth context — tools only ever see this tenant's data.
   */
  @Post('chat')
  async chat(@Body() body: ChatBody, @Req() req: Request, @Res() res: Response) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user?.workspaceId;
    const messages = (body?.messages || []).filter((m) => m?.content?.trim());
    if (!messages.length) throw new BadRequestException('messages is required.');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (e: AgentEvent) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      // @ts-expect-error flush exists when compression middleware is present
      res.flush?.();
    };

    // Resolve (or create) the conversation this turn belongs to, then persist the
    // user's message. A new conversation is titled from the first message; its id
    // is streamed to the client so follow-up turns land in the same thread.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';
    let conversationId = body?.conversationId;
    try {
      if (!conversationId) {
        conversationId = await this.store.createConversation(workspaceId, user?.sub, lastUser);
      }
      send({ type: 'conversation', id: conversationId });
      if (lastUser) await this.store.appendMessage(workspaceId, conversationId, 'user', lastUser);
    } catch {
      conversationId = undefined; // persistence is best-effort — chat still works
    }

    // Accumulate the assistant's reply (text + tool traces) as it streams so we
    // can persist the final turn once the run completes.
    let answer = '';
    const traces: ToolTrace[] = [];
    const capture = (e: AgentEvent) => {
      if (e.type === 'text') answer += (answer ? '\n' : '') + e.text;
      else if (e.type === 'tool_call') traces.push({ name: e.name, args: e.args });
      else if (e.type === 'tool_result') {
        for (let i = traces.length - 1; i >= 0; i--) {
          if (traces[i].name === e.name && traces[i].ok === undefined) {
            traces[i] = { ...traces[i], ok: e.ok, result: e.result };
            break;
          }
        }
      }
      send(e);
    };

    // Pull in this workspace's Apify MCP tools (empty if Apify isn't connected),
    // append them to the local tool set, and make sure the MCP session is closed
    // when the run finishes.
    const apifySet = await this.apify.toolsFor(workspaceId).catch(() => ({
      tools: [],
      dispose: async () => undefined,
    }));
    const tools = [...this.agent.localTools(), ...apifySet.tools];

    try {
      await this.agent.run(messages, { workspaceId, userId: user?.sub }, capture, tools);
    } catch (e: any) {
      send({ type: 'error', message: String(e?.message || e) });
      send({ type: 'done' });
    } finally {
      await apifySet.dispose().catch(() => undefined);
      if (conversationId && (answer || traces.length)) {
        await this.store
          .appendMessage(workspaceId, conversationId, 'assistant', answer, traces)
          .catch(() => undefined);
      }
      res.end();
    }
  }

  @Post('preview-note')
  async previewNote(@Body() body: PreviewNoteBody) {
    const lead = body?.lead;
    if (!lead?.firstName || !lead.firstName.trim()) {
      throw new BadRequestException('lead.firstName is required to generate a note.');
    }
    const result = await this.ai.generateConnectionNote(
      {
        firstName: lead.firstName.trim(),
        fullName: lead.fullName,
        title: lead.title,
        company: lead.company,
        location: lead.location,
      },
      body.voice || {},
    );
    return { ...result, chars: result.note.length };
  }
}
