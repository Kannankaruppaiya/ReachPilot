import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import type { ToolTrace } from './ai-agent.service';

/** A conversation as the sidebar lists it. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** A persisted turn as the UI re-renders it (assistant turns carry tool traces). */
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolTrace[];
}

/** Longest a conversation title derived from the first message may be. */
const TITLE_MAX = 60;

/**
 * Persistence for the AI Assistant's chat history. Conversations + their
 * messages are workspace-scoped (RLS-enforced via {@link withWorkspace}); the
 * agent generation itself stays stateless — this just records what was said so
 * it survives refresh and follows the user across devices.
 */
@Injectable()
export class AiChatStoreService {
  /** Conversations for the workspace, most-recently-updated first. */
  async listConversations(workspaceId: string): Promise<ConversationSummary[]> {
    return withWorkspace(workspaceId, async (db) => {
      const rows = await db
        .selectFrom('ai_conversations')
        .select(['id', 'title', 'updated_at'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('updated_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: String(r.updated_at) }));
    });
  }

  /** All messages in a conversation, oldest first. Empty if it doesn't exist. */
  async getMessages(workspaceId: string, conversationId: string): Promise<StoredMessage[]> {
    return withWorkspace(workspaceId, async (db) => {
      const owns = await db
        .selectFrom('ai_conversations')
        .select('id')
        .where('id', '=', conversationId)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!owns) return [];

      const rows = await db
        .selectFrom('ai_messages')
        .select(['role', 'content', 'tools'])
        .where('conversation_id', '=', conversationId)
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map((r) => ({
        role: r.role === 'assistant' ? 'assistant' : 'user',
        content: r.content,
        tools: (r.tools as ToolTrace[] | null) || undefined,
      }));
    });
  }

  /** Create a conversation, titling it from the first user message. */
  async createConversation(workspaceId: string, userId: string | undefined, firstMessage: string): Promise<string> {
    const title = firstMessage.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) || 'New chat';
    return withWorkspace(workspaceId, async (db) => {
      const row = await db
        .insertInto('ai_conversations')
        .values({ workspace_id: workspaceId, user_id: userId ?? null, title })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  /** Append a message and bump the conversation's updated_at. */
  async appendMessage(
    workspaceId: string,
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    tools?: ToolTrace[],
  ): Promise<void> {
    await withWorkspace(workspaceId, async (db) => {
      await db
        .insertInto('ai_messages')
        .values({
          conversation_id: conversationId,
          workspace_id: workspaceId,
          role,
          content,
          tools: tools && tools.length ? JSON.stringify(tools) : null,
        })
        .execute();
      await db
        .updateTable('ai_conversations')
        .set({ updated_at: new Date().toISOString() })
        .where('id', '=', conversationId)
        .where('workspace_id', '=', workspaceId)
        .execute();
    });
  }

  /** Delete a conversation (its messages cascade). */
  async deleteConversation(workspaceId: string, conversationId: string): Promise<void> {
    await withWorkspace(workspaceId, async (db) => {
      await db
        .deleteFrom('ai_conversations')
        .where('id', '=', conversationId)
        .where('workspace_id', '=', workspaceId)
        .execute();
    });
  }
}
