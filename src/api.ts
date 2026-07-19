// Thin client for the ReachPilot backend. Every call returns parsed JSON or
// throws an Error whose message is safe to show the user.

export type OnboardingState = {
  workspace: { name: string; goal: string } | null
  linkedin: { email: string; country: string; dedicatedIp: string } | null
  twofa: { status: "not_set" | "verified" | "skipped" }
  gmail: { email: string; dailyLimit: number } | null
  warmup: { dailyLimit: number; hoursStart: string; hoursEnd: string; weekends: boolean } | null
  leadCount: number
  leadSource: string | null
  completedStep: number
  onboardingDone: boolean
}

// ── Auth tokens (persisted so a refresh keeps you logged in) ──────────
const ACCESS_KEY = "rp_access"
const REFRESH_KEY = "rp_refresh"

export const auth = {
  isAuthed: () => !!localStorage.getItem(ACCESS_KEY),
  set(access: string, refresh?: string) {
    localStorage.setItem(ACCESS_KEY, access)
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh)
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
  },
}

async function tryRefresh(): Promise<boolean> {
  const rt = localStorage.getItem(REFRESH_KEY)
  if (!rt) return false
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
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
  const token = localStorage.getItem(ACCESS_KEY)
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
  if (res.status === 401 && !retried && localStorage.getItem(REFRESH_KEY)) {
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
    const rt = localStorage.getItem("rp_refresh")
    auth.clear()
    if (rt)
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
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
  saveLinkedinLimits: (dailyLimit: number, weeklyInviteCap: number) =>
    patch<LinkedInAccountState>("/api/linkedin/limits", { dailyLimit, weeklyInviteCap }),
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

export type InboxMessage = {
  from: "me" | "them"
  channel: "linkedin" | "email"
  subject?: string
  text: string
  time: string
}

export type InboxThread = {
  id: string
  leadId: string
  channel: "linkedin" | "email"
  unread: boolean
  preview?: string
  time?: string
  leadName?: string
  leadFirstName?: string
  leadTitle?: string
  leadCompany?: string
  leadEmail?: string
  leadLocation?: string
  leadStatus?: string
  leadTags?: string[]
  campaign?: string | null
  messages: InboxMessage[]
}

export type Me = {
  id: string
  email: string
  fullName: string
  workspaceId: string
  workspaceName: string
  onboardingDone: boolean
}

export type LinkedInAccountState = {
  connected: boolean
  loggedIn: boolean
  status: "none" | "connecting" | "warming_up" | "active" | "checkpoint" | "paused" | "disconnected"
  email: string | null
  dailyLimit: number | null
  weeklyInviteCap: number | null
  warmup: { todayLimit: number; target: number; progressPct: number; daysToFull: number } | null
}

export type NotificationItem = {
  id: string
  kind: string
  text: string
  read_at: string | null
  created_at: string
}

export type DashboardData = {
  invitesSent: number
  emailsSent: number
  acceptanceRate: number
  replies: number
  meetings: number
  totalLeads: number
  queuedToday: number
  scheduled: number
  sentToday: number
  account: {
    status: string
    loggedIn: boolean
    warmup: { todayLimit: number; target: number; progressPct: number; daysToFull: number } | null
    country: string | null
    dedicatedIp: string | null
  } | null
  activity: { id: string; text: string; tone: string; time: string }[]
}

export type DailyStat = { day: string; invites: number; accepted: number; replies: number }

export type HourlyStat = { day: string; hour: number; sends: number; replies: number }

export type LeadRow = {
  id: string
  name: string
  firstName: string
  title: string
  company: string
  location: string
  linkedinUrl: string
  email: string
  emailVerified: boolean
  status: string
  source: string | null
  tags: string[]
  lastActivity: string | null
  createdAt: string
}

export type CampaignRow = {
  id: string
  name: string
  status: string
  leads: number
  sent: number
  acceptedPct: number
  repliedPct: number
  trend: number[]
}

export type TemplateRow = {
  id: string
  name: string
  channel: string
  subject?: string
  body: string
  used: number
  acceptPct: number
}

export type SendJob = {
  id: string
  batchId: string
  kind: string
  name: string
  target: string
  status: "queued" | "scheduled" | "running" | "sent" | "failed" | "canceled"
  day: number
  scheduledFor: string
  sentAt: string | null
}

export type ConnectionDelivery = "scheduled" | "queued" | "running" | "sent" | "failed" | "canceled"
export type ConnectionOutcome = "in_queue" | "pending" | "accepted" | "replied" | "failed"

export type ConnectionRow = {
  id: string
  batchId: string | null
  name: string
  linkedinUrl: string
  company: string
  role: string
  message: string
  delivery: ConnectionDelivery
  outcome: ConnectionOutcome
  leadStatus: string | null
  lastActivity: string | null
  sentAt: string | null
  scheduledFor: string
  error: string | null
  createdAt: string
}

export type ConnectionsData = {
  summary: {
    total: number
    sent: number
    accepted: number
    replied: number
    pending: number
    inQueue: number
    failed: number
    acceptanceRate: number
  }
  rows: ConnectionRow[]
}

export type IntegrationsState = {
  gmail:
    | { connected: true; email: string; dailyLimit: number; status: string; connectedAt: string | null }
    | { connected: false }
  integrations: { provider: string; active: boolean; created_at: string }[]
}
