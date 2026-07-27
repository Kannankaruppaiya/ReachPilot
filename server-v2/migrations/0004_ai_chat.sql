-- ============================================================================
-- 0004: AI Assistant chat history
--
-- Persists the in-app Assistant's conversations so they survive refresh and
-- follow the user across devices (previously chat lived only in React state).
--   * ai_conversations — one row per chat thread (title auto-derived from the
--     first user message)
--   * ai_messages      — the turns; assistant turns also store their tool-call
--     trace as JSONB so the UI can re-render the collapsible tool cards
--
-- Both are workspace-scoped and follow the same RLS model as the rest of the
-- schema (ENABLE + FORCE + tenant_isolation via current_workspace_id()).
-- ============================================================================

CREATE TABLE ai_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  title         text NOT NULL DEFAULT 'New chat',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_conversations_ws_updated_idx
  ON ai_conversations (workspace_id, updated_at DESC);

CREATE TABLE ai_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role             text NOT NULL,
  content          text NOT NULL DEFAULT '',
  tools            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_messages_conversation_idx
  ON ai_messages (conversation_id, created_at);

-- RLS: tenant isolation, forced even for the superuser connection (see 0003).
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_conversations
  USING (workspace_id = current_workspace_id());

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_messages
  USING (workspace_id = current_workspace_id());
