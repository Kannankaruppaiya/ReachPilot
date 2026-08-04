// Shared API/domain types. Kept separate from the client so screens can import
// types without pulling in the fetch layer.

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
  hoursStart: string | null
  hoursEnd: string | null
  timezone: string | null
  sendWeekends: boolean | null
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
  fitScore: number | null
  lastActivity: string | null
  scrapeJobId: string | null
  createdAt: string
}

export type ScrapeJob = {
  id: string
  titles: string[]
  location: string | null
  maxResults: number
  status: "queued" | "running" | "done" | "blocked" | "failed" | string
  stage: string | null
  counts: { raw?: number; valid?: number; imported?: number }
  reason: string | null
  createdAt: string
  updatedAt: string
}

export type CampaignRow = {
  id: string
  name: string
  status: string
  leads: number
  sent: number
  acceptedPct: number
  repliedPct: number
  dailyCap?: number
  trend: number[]
  createdAt?: string
}

/** One builder node the client sends when creating a campaign sequence. */
export type CampaignBuilderNode = {
  kind: "invite" | "message" | "email" | "view" | "follow" | "wait" | "branch"
  days?: number
  body?: string
  subject?: string
  condition?: string
  elseAction?: { kind: "email" | "message"; body?: string; subject?: string }
}

/** A persisted step as returned in the campaign detail. */
export type CampaignStep = {
  id: string
  kind: "action" | "condition"
  action: string | null
  condition: string | null
  delayHours: number
  body: string
  subject: string
}

export type CampaignEnrollment = {
  enrollmentId: string
  enrollmentStatus: string
  leadId: string
  name: string
  title: string
  company: string
  leadStatus: string
  nextRunAt: string | null
}

export type CampaignDetailData = CampaignRow & {
  steps: CampaignStep[]
  builderNodes: CampaignBuilderNode[]
  enrollments: CampaignEnrollment[]
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
  /** Every Gmail mailbox (the email warm-up loop pairs ≥2 of them). */
  gmailAccounts?: { email: string; connected: boolean; status: string; connectedAt: string | null }[]
  /** Apify MCP connection — powers the AI assistant's web-scraping/actor tools. */
  apify?:
    | { connected: true; enabledTools: string; connectedAt: string | null }
    | { connected: false }
  integrations: { provider: string; active: boolean; created_at: string }[]
}
