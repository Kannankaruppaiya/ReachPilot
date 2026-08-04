// Thin client for the ReachPilot backend. Every call returns parsed JSON or
// throws an Error whose message is safe to show the user.

import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from "@/constants"
import type {
  CampaignRow,
  CampaignBuilderNode,
  CampaignDetailData,
  ConnectionsData,
  DailyStat,
  DashboardData,
  HourlyStat,
  IntegrationsState,
  InboxThread,
  LeadRow,
  ScrapeJob,
  LinkedInAccountState,
  Me,
  NotificationItem,
  OnboardingState,
  SendJob,
  TemplateRow,
} from "@/types"

// ── Auth tokens (persisted so a refresh keeps you logged in) ──────────
export const auth = {
  isAuthed: () => !!localStorage.getItem(ACCESS_TOKEN_KEY),
  set(access: string, refresh?: string) {
    localStorage.setItem(ACCESS_TOKEN_KEY, access)
    if (refresh) localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
  },
  clear() {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
  },
}

// Refresh outcome — tri-state so callers don't conflate "session is dead"
// with "server was briefly unreachable":
//   ok          → new tokens stored, retry the original request
//   rejected    → definitive 401/403 → clear tokens, route to login
//   unavailable → network error / 5xx → keep tokens, surface transient error
type RefreshResult = "ok" | "rejected" | "unavailable"

async function tryRefresh(): Promise<RefreshResult> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
  if (!refreshToken) return "rejected"
  let res: Response
  try {
    res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
  } catch {
    // Network error — don't log the user out over a blip.
    return "unavailable"
  }
  if (res.status === 401 || res.status === 403) return "rejected"
  if (!res.ok) return "unavailable" // 5xx / anything transient
  const data = await res.json().catch(() => ({}))
  if (!data.accessToken) return "unavailable"
  auth.set(data.accessToken, data.refreshToken)
  return "ok"
}

// Single-flight: when a burst of requests all 401 at once (poller + a screen
// mount firing together), only ONE /auth/refresh runs. The rest await the same
// promise and reuse its result, so the rotating refresh token is spent exactly
// once per burst instead of once per request (the second-onward used the now
// revoked token → 401 → logout, which was the bug).
let refreshInFlight: Promise<RefreshResult> | null = null

function refreshOnce(): Promise<RefreshResult> {
  if (!refreshInFlight) {
    refreshInFlight = tryRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function req<T>(url: string, body?: unknown, retried = false, method?: string): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const token = localStorage.getItem(ACCESS_TOKEN_KEY)
  if (token) headers["Authorization"] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error("Can't reach the server. Is the API running on port 4000?")
  }

  // Access token expired → refresh once (shared across a concurrent burst) and retry.
  if (res.status === 401 && !retried && localStorage.getItem(REFRESH_TOKEN_KEY)) {
    const result = await refreshOnce()
    if (result === "ok") return req<T>(url, body, true, method)
    if (result === "rejected") {
      auth.clear()
      throw new Error("Session expired. Please log in again.")
    }
    // "unavailable" — keep tokens; the next action retries once the API is back.
    throw new Error("Can't reach the server. Is the API running on port 4000?")
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data as T
}

/** PATCH helper (the backend exposes PATCH for campaigns/leads/notifications). */
const patch = <T>(url: string, body: unknown) => req<T>(url, body, false, "PATCH")

/** DELETE helper. */
const del = <T>(url: string) => req<T>(url, undefined, false, "DELETE")

export const api = {
  // Auth
  signup: async (email: string, password: string, fullName: string) => {
    const r = await req<{ accessToken: string; refreshToken: string; workspaceId: string }>(
      "/api/auth/signup",
      { email, password, fullName },
    )
    auth.set(r.accessToken, r.refreshToken)
    return r
  },
  login: async (email: string, password: string) => {
    const r = await req<{ accessToken: string; refreshToken: string; workspaceId: string }>(
      "/api/auth/login",
      { email, password },
    )
    auth.set(r.accessToken, r.refreshToken)
    return r
  },
  me: () => req<Me>("/api/auth/me"),
  logout: async () => {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
    auth.clear()
    if (refreshToken)
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {})
  },

  getOnboarding: () => req<OnboardingState>("/api/onboarding"),
  saveWorkspace: (name: string, goal: string) =>
    req<{ ok: true }>("/api/workspace", { name, goal }),
  connectLinkedin: (email: string, password: string, country: string) =>
    req<{ dedicatedIp: string; country: string }>("/api/linkedin/connect", {
      email,
      password,
      country,
    }),
  verify2fa: (secret: string) =>
    req<{ status: string }>("/api/linkedin/2fa/verify", { secret }),
  skip2fa: () => req<{ status: string }>("/api/linkedin/2fa/skip", {}),
  connectGmail: (dailyLimit: number) =>
    req<{ gmail: { dailyLimit: number } }>("/api/gmail/connect", { dailyLimit }),
  saveWarmup: (payload: {
    dailyLimit: number
    hoursStart: string
    hoursEnd: string
    weekends: boolean
  }) => req<{ ok: true }>("/api/warmup", payload),
  importLeads: (payload: { source: string; url?: string; rows?: unknown[] }) =>
    req<{ count: number; source: string }>("/api/leads/import", payload),
  complete: () => req<{ message: string }>("/api/onboarding/complete", {}),
  reset: () => req<{ ok: true }>("/api/onboarding/reset", {}),

  // Auto Connect / Auto Mail — real send batch
  createSend: (payload: {
    kind: "linkedin" | "email"
    cap: number
    rows: { name: string; target: string; company: string; role: string }[]
    template: string
    subject?: string
    useAi?: boolean
    useApify?: boolean
    aiGuidance?: string
  }) => req<{ batchId: string; total: number; today: number; queuedDays: number }>("/api/send/create", payload),
  listJobs: (batchId: string) => req<SendJob[]>(`/api/send/jobs?batchId=${batchId}`),
  // Cancel one not-yet-sent job (queue "close" button).
  cancelJob: (id: string) => req<{ ok: true; canceled: boolean }>(`/api/send/jobs/${id}/cancel`, {}),
  // Delete one job (queue "delete" button).
  deleteJob: (id: string) => req<{ deleted: number }>(`/api/send/jobs/${id}`, undefined, false, "DELETE"),
  // Bulk-delete jobs — clear the queue (statuses) or wipe LinkedIn history for a fresh test.
  clearJobs: (statuses?: string[], kind?: string) =>
    req<{ deleted: number }>("/api/send/jobs/clear", { statuses, kind }),
  // Every LinkedIn connection request sent, with delivery + acceptance outcome.
  getConnections: () => req<ConnectionsData>("/api/send/connections"),

  // Account shell state (status + real warm-up numbers)
  linkedinAccount: () => req<LinkedInAccountState>("/api/linkedin"),
  // Settings → LinkedIn limits — the ONE place limits are saved. Returns the
  // refreshed account state so the UI reflects exactly what the engine enforces.
  saveLinkedinLimits: (payload: {
    dailyLimit: number
    weeklyInviteCap: number
    warmupTarget?: number
    hoursStart?: string
    hoursEnd?: string
    timezone?: string
    sendWeekends?: boolean
  }) => patch<LinkedInAccountState>("/api/linkedin/limits", payload),
  notifications: () => req<NotificationItem[]>("/api/notifications"),

  // Real data for the app screens
  getDashboard: () => req<DashboardData>("/api/dashboard"),
  getAnalyticsDaily: () => req<DailyStat[]>("/api/analytics/daily"),
  getAnalyticsHourly: () => req<HourlyStat[]>("/api/analytics/hourly"),
  getChannels: () => req<{ channel: string; replies: number }[]>("/api/analytics/channels"),
  // No args → every lead (Campaigns needs the full list). With params → one
  // filtered/sorted page (the Leads screen paginates large sets this way).
  getLeads: (params?: {
    limit?: number
    offset?: number
    q?: string
    status?: string
    source?: string
    sort?: "recent" | "score"
    scrapeJobId?: string
  }) => {
    const entries = Object.entries(params ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    )
    const qs = entries.length
      ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
      : ""
    return req<LeadRow[]>(`/api/leads${qs}`)
  },
  // Free local scrape: Google → LinkedIn profiles by title + location. Enqueues
  // a worker job; scraped leads appear in the table shortly after. startFresh
  // re-sweeps a search from page 0 instead of continuing the rerun cursor.
  scrapeLeads: (payload: {
    titles: string[]
    location?: string
    maxResults?: number
    startFresh?: boolean
  }) =>
    req<{ ok: true; queued: boolean; scrapeJobId: string; titles: string[]; location?: string; maxResults: number }>(
      "/api/leads/scrape",
      payload,
    ),
  // Scrape-run history + live status (powers the Leads history panel + progress).
  getScrapeJobs: () => req<ScrapeJob[]>("/api/leads/scrape-jobs"),
  getScrapeJob: (id: string) => req<ScrapeJob | null>(`/api/leads/scrape-jobs/${id}`),
  getCampaigns: () => req<CampaignRow[]>("/api/campaigns"),
  getCampaign: (id: string) => req<CampaignDetailData>(`/api/campaigns/${id}`),
  getTemplates: () => req<TemplateRow[]>("/api/templates"),
  updateCampaign: (
    id: string,
    body: { status?: string; dailyCap?: number; name?: string; steps?: CampaignBuilderNode[] },
  ) => patch<CampaignRow>(`/api/campaigns/${id}`, body),
  deleteCampaign: (id: string) => del<{ deleted: boolean }>(`/api/campaigns/${id}`),
  setEnrollment: (id: string, enrollmentId: string, action: "pause" | "resume") =>
    patch<{ ok: true }>(`/api/campaigns/${id}/enrollments/${enrollmentId}`, { action }),
  removeEnrollment: (id: string, enrollmentId: string) =>
    del<{ removed: boolean }>(`/api/campaigns/${id}/enrollments/${enrollmentId}`),
  createCampaign: (body: {
    name: string
    dailyCap: number
    steps?: CampaignBuilderNode[]
    leadIds?: string[]
    launch?: boolean
  }) => req<CampaignRow>("/api/campaigns", body),
  enrollLeads: (id: string, leadIds: string[]) =>
    req<{ enrolled: number }>(`/api/campaigns/${id}/enroll`, { leadIds }),
  launchCampaign: (id: string) => req<CampaignDetailData>(`/api/campaigns/${id}/launch`, {}),

  // Inbox
  getThreads: () => req<InboxThread[]>("/api/threads"),
  sendThreadMessage: (id: string, text: string) =>
    req<InboxThread>(`/api/threads/${id}/messages`, { text }),

  // Integrations
  getIntegrations: () => req<IntegrationsState>("/api/integrations"),
  googleConnectUrl: () => req<{ url: string }>("/api/integrations/google/connect"),
  disconnectGoogle: () => req<{ ok: true }>("/api/integrations/google/disconnect", {}),
  connectApify: (token: string, enabledTools?: string) =>
    req<{ connected: true; toolCount: number; enabledTools: string }>(
      "/api/integrations/apify/connect",
      { token, enabledTools },
    ),
  disconnectApify: () => req<{ ok: true }>("/api/integrations/apify/disconnect", {}),

  // AI assistant
  aiStatus: () => req<{ configured: boolean }>("/api/ai/status"),
  aiChat,
  aiConversations: () => req<ConversationSummary[]>("/api/ai/conversations"),
  aiConversation: (id: string) =>
    req<{ id: string; messages: StoredMessage[] }>(`/api/ai/conversations/${id}`),
  aiDeleteConversation: (id: string) =>
    req<{ ok: true }>(`/api/ai/conversations/${id}`, undefined, false, "DELETE"),
}

/** A saved conversation as the sidebar lists it. */
export interface ConversationSummary {
  id: string
  title: string
  updatedAt: string
}

/** A tool call + result, persisted with an assistant turn. */
export interface ToolTrace {
  name: string
  args?: unknown
  ok?: boolean
  result?: unknown
}

/** A persisted message loaded from history. */
export interface StoredMessage {
  role: "user" | "assistant"
  content: string
  tools?: ToolTrace[]
}

/** Agent chat event mirrored from the backend AgentEvent union. */
export type AgentEvent =
  | { type: "conversation"; id: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; ok: boolean; result: unknown }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "done" }

/**
 * Streaming agent chat over SSE. EventSource can't send an Authorization header
 * or a POST body, so we read the fetch stream manually and dispatch each
 * `data:` line as a parsed AgentEvent. Returns when the stream ends.
 */
async function aiChat(
  messages: { role: "user" | "assistant"; content: string }[],
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
  conversationId?: string,
): Promise<void> {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY)
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages, conversationId }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`AI chat failed (${res.status}). Is the API running?`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE events are separated by a blank line; each has a `data:` payload.
    let idx: number
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = chunk.split("\n").find((l) => l.startsWith("data:"))
      if (!line) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent)
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
