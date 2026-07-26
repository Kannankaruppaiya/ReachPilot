// Thin client for the ReachPilot backend. Every call returns parsed JSON or
// throws an Error whose message is safe to show the user.

import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from "@/constants"
import type {
  CampaignRow,
  ConnectionsData,
  DailyStat,
  DashboardData,
  HourlyStat,
  IntegrationsState,
  InboxThread,
  LeadRow,
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

async function tryRefresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
  if (!refreshToken) return false
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.accessToken) return false
    auth.set(data.accessToken, data.refreshToken)
    return true
  } catch {
    return false
  }
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

  // Access token expired → refresh once and retry.
  if (res.status === 401 && !retried && localStorage.getItem(REFRESH_TOKEN_KEY)) {
    if (await tryRefresh()) return req<T>(url, body, true, method)
    auth.clear()
    throw new Error("Session expired. Please log in again.")
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data as T
}

/** PATCH helper (the backend exposes PATCH for campaigns/leads/notifications). */
const patch = <T>(url: string, body: unknown) => req<T>(url, body, false, "PATCH")

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
  getLeads: () => req<LeadRow[]>("/api/leads"),
  getCampaigns: () => req<CampaignRow[]>("/api/campaigns"),
  getTemplates: () => req<TemplateRow[]>("/api/templates"),
  updateCampaign: (id: string, body: { status?: string; dailyCap?: number }) =>
    patch<CampaignRow>(`/api/campaigns/${id}`, body),
  createCampaign: (body: { name: string; dailyCap: number }) => req<CampaignRow>("/api/campaigns", body),

  // Inbox
  getThreads: () => req<InboxThread[]>("/api/threads"),
  sendThreadMessage: (id: string, text: string) =>
    req<InboxThread>(`/api/threads/${id}/messages`, { text }),

  // Integrations
  getIntegrations: () => req<IntegrationsState>("/api/integrations"),
  googleConnectUrl: () => req<{ url: string }>("/api/integrations/google/connect"),
  disconnectGoogle: () => req<{ ok: true }>("/api/integrations/google/disconnect", {}),
}
