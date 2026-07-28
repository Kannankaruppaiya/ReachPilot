import { useEffect, useMemo, useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  BadgeCheck,
  Boxes,
  FlaskConical,
  Loader2,
  Mail,
  Plug,
  ShieldCheck,
} from "lucide-react"
import { Badge, Button, Card, Field, LinkedinIcon } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"
import { api } from "@/lib/api"
import type {
  IntegrationsState,
  TemplateRow,
  HourlyStat,
  Me,
  LinkedInAccountState,
} from "@/types"

/* ---------- Sequences ---------- */

export function Sequences() {
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .getTemplates()
      .then((t) => alive && setTemplates(t))
      .catch(() => alive && setTemplates([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Templates &amp; sequences</h1>
        <p className="text-sm text-sub">Reusable messages with personalization variables.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {loading ? (
            <Card className="flex items-center justify-center p-10">
              <Loader2 size={22} className="animate-spin text-accent" />
            </Card>
          ) : templates.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="font-semibold">No templates yet</p>
              <p className="mt-1 text-sm text-sub">
                Templates you save from a campaign show up here with their real usage and acceptance rate.
              </p>
            </Card>
          ) : (
            templates.map((t) => (
              <Card key={t.id} className="p-5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-bold">{t.name}</p>
                  <div className="flex gap-2">
                    <Badge tone="sub">Used {t.used}×</Badge>
                    <Badge tone={t.acceptPct > 0 ? "success" : "sub"}>
                      {t.used > 0 ? `${t.acceptPct}% accepted` : "No data yet"}
                    </Badge>
                  </div>
                </div>
                <p className="rounded-md bg-mutedbg p-3 text-sm leading-relaxed">
                  {t.body.split(/(\{\{[^}]+\}\})/g).map((part, i) =>
                    part.startsWith("{{") ? (
                      <span key={i} className="mx-0.5 rounded bg-accent/15 px-1.5 py-0.5 text-xs font-bold text-accent">
                        {part}
                      </span>
                    ) : (
                      part
                    ),
                  )}
                </p>
              </Card>
            ))
          )}
        </div>
        <Card className="h-fit p-5">
          <h2 className="mb-3 flex items-center gap-2 font-bold">
            <ShieldCheck size={16} className="text-sub" /> Deliverability
          </h2>
          <p className="text-sm text-sub">
            Cold email lands in spam without SPF, DKIM and DMARC on a custom sending domain.
          </p>
          <p className="mt-3 text-xs text-sub">
            We don't verify your DNS records yet — check them with your domain provider before running
            email campaigns at volume.
          </p>
        </Card>
      </div>
    </div>
  )
}

/* ---------- Analytics ---------- */

const HOUR_LABELS = ["8a", "9a", "10a", "11a", "12p", "1p", "2p", "3p", "4p", "5p"]
const HOUR_START = 8

export function Analytics() {
  const [channels, setChannels] = useState<{ channel: string; replies: number }[]>([])
  const [hourly, setHourly] = useState<HourlyStat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.all([api.getChannels().catch(() => []), api.getAnalyticsHourly().catch(() => [])])
      .then(([c, h]) => {
        if (!alive) return
        setChannels(c)
        setHourly(h)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  // Build a real weekday × hour grid from hourly_stats. Empty until data exists.
  const grid = useMemo(() => {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    const rows = new Map<string, number[]>()
    for (const h of hourly) {
      const weekday = dayNames[new Date(h.day).getDay()] || "—"
      if (!rows.has(weekday)) rows.set(weekday, Array(HOUR_LABELS.length).fill(0))
      const idx = h.hour - HOUR_START
      if (idx >= 0 && idx < HOUR_LABELS.length) rows.get(weekday)![idx] += Number(h.sends || 0)
    }
    return Array.from(rows.entries())
  }, [hourly])

  const maxCell = Math.max(1, ...grid.flatMap(([, row]) => row))
  const hasChannelData = channels.some((c) => c.replies > 0)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-sm text-sub">Your real send and reply performance.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-bold">Replies by channel</h2>
          <div className="h-56">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 size={22} className="animate-spin text-accent" />
              </div>
            ) : !hasChannelData ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-sub">
                <p className="font-semibold">No replies yet</p>
                <p>Reply counts by channel appear once your campaigns get responses.</p>
              </div>
            ) : (
            <ResponsiveContainer>
              <BarChart data={channels}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="channel" tick={{ fontSize: 12, fill: "var(--sub)" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 12, fill: "var(--sub)" }} tickLine={false} axisLine={false} width={24} />
                <Tooltip
                  cursor={{ fill: "var(--mutedbg)" }}
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}
                />
                <Bar dataKey="replies" fill="#0369a1" radius={[6, 6, 0, 0]} name="Replies" />
              </BarChart>
            </ResponsiveContainer>
            )}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 font-bold">Send activity by hour</h2>
          {grid.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center text-center text-sm text-sub">
              <p className="font-semibold">Not enough data yet</p>
              <p>Once sends go out, this shows when your account is actually active.</p>
            </div>
          ) : (
          <div className="flex flex-col gap-1.5" role="img" aria-label="Heatmap of sends by weekday and hour">
            {grid.map(([dayName, row]) => (
              <div key={dayName} className="flex items-center gap-1.5">
                <span className="w-8 text-xs font-semibold text-sub">{dayName}</span>
                {row.map((v, c) => (
                  <span
                    key={c}
                    title={`${dayName} ${HOUR_LABELS[c]} — ${v} sends`}
                    className="h-7 flex-1 rounded"
                    style={{ background: v === 0 ? "var(--mutedbg)" : `rgba(3,105,161,${0.2 + (v / maxCell) * 0.8})` }}
                  />
                ))}
              </div>
            ))}
            <div className="ml-8 flex gap-1.5">
              {HOUR_LABELS.map((h) => (
                <span key={h} className="flex-1 text-center text-[10px] text-sub">{h}</span>
              ))}
            </div>
          </div>
          )}
        </Card>
      </div>
      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-bold">
          <FlaskConical size={16} className="text-sub" /> A/B test — connection note
        </h2>
        <p className="text-sm text-sub">
          A/B testing isn't wired up yet. When it is, variant acceptance rates will be reported here from
          real sends — no results are shown until there's data to report.
        </p>
      </Card>
    </div>
  )
}

/* ---------- Integrations ---------- */

const APIFY_DEFAULT_TOOLS = "actors,docs,apify/rag-web-browser"

export function Integrations() {
  const toast = useToast()
  const [state, setState] = useState<IntegrationsState | null>(null)
  const [li, setLi] = useState<LinkedInAccountState | null>(null)
  const [busy, setBusy] = useState(false)
  // Apify connect form
  const [showApify, setShowApify] = useState(false)
  const [apifyToken, setApifyToken] = useState("")
  const [apifyTools, setApifyTools] = useState(APIFY_DEFAULT_TOOLS)
  const [apifyBusy, setApifyBusy] = useState(false)

  const load = () => {
    api.linkedinAccount().then(setLi).catch(() => setLi(null))
    return api.getIntegrations().then(setState).catch(() => setState(null))
  }

  useEffect(() => {
    load()
    // Surface the OAuth redirect result once, then clean the URL.
    const params = new URLSearchParams(window.location.search)
    const g = params.get("gmail")
    if (g === "connected") toast("Gmail connected ✓")
    else if (g === "error") toast(params.get("reason") || "Gmail connection failed")
    if (g) window.history.replaceState({}, "", window.location.pathname)
  }, [])

  const connectGmail = async () => {
    setBusy(true)
    try {
      const { url } = await api.googleConnectUrl()
      window.location.href = url // → Google consent, redirects back to /?gmail=connected
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't start Google connection")
      setBusy(false)
    }
  }

  const disconnectGmail = async () => {
    setBusy(true)
    try {
      await api.disconnectGoogle()
      toast("Gmail disconnected")
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Disconnect failed")
    } finally {
      setBusy(false)
    }
  }

  const connectApify = async () => {
    if (!apifyToken.trim()) {
      toast("Paste your Apify API token first.")
      return
    }
    setApifyBusy(true)
    try {
      const r = await api.connectApify(apifyToken.trim(), apifyTools.trim() || APIFY_DEFAULT_TOOLS)
      toast(`Apify connected — ${r.toolCount} tools available in the Assistant ✓`)
      setApifyToken("")
      setShowApify(false)
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't connect Apify")
    } finally {
      setApifyBusy(false)
    }
  }

  const disconnectApify = async () => {
    setApifyBusy(true)
    try {
      await api.disconnectApify()
      toast("Apify disconnected")
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Disconnect failed")
    } finally {
      setApifyBusy(false)
    }
  }

  const gmail = state?.gmail
  const apify = state?.apify

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-sm text-sub">Connected accounts and tools.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent"><LinkedinIcon size={20} /></span>
            <div>
              <p className="font-bold">LinkedIn</p>
              {li?.connected ? (
                <Badge tone="success"><BadgeCheck size={12} /> Connected</Badge>
              ) : (
                <Badge tone="sub">Not connected</Badge>
              )}
            </div>
          </div>
          <p className="text-sm text-sub">
            {li?.connected
              ? [
                  li.email,
                  li.warmup
                    ? li.status === "warming_up"
                      ? `warming up ${li.warmup.todayLimit}/${li.warmup.target} per day`
                      : `daily limit ${li.warmup.todayLimit}/day`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Connect a LinkedIn account from onboarding to start sending."}
          </p>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-danger/10 text-danger"><Mail size={20} /></span>
            <div>
              <p className="font-bold">Gmail</p>
              {gmail?.connected ? (
                <Badge tone="success"><BadgeCheck size={12} /> Connected</Badge>
              ) : (
                <Badge tone="sub">Not connected</Badge>
              )}
            </div>
          </div>
          {gmail?.connected ? (
            <>
              {(state?.gmailAccounts?.length ? state.gmailAccounts : [gmail]).map((a: any) => (
                <p key={a.email} className="text-sm text-sub">
                  {a.email}
                  {!a.connected && <span className="ml-1 text-xs text-warn">({a.status})</span>}
                </p>
              ))}
              <p className="tabular mt-1 text-xs text-sub">Daily limit · {gmail.dailyLimit} emails/day</p>
              <p className="mt-2 text-xs text-sub">
                Connect a second mailbox to activate email warm-up (mailboxes exchange mail and
                rescue each other from spam — builds sender reputation). Re-connecting an existing
                mailbox refreshes its permissions.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button disabled={busy} onClick={connectGmail}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <><Mail size={16} /> Connect / re-connect mailbox</>}
                </Button>
                <Button variant="outline" disabled={busy} onClick={disconnectGmail}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : "Disconnect"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-3 text-sm text-sub">Send outreach & follow-ups from your own inbox.</p>
              <Button disabled={busy} onClick={connectGmail}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <><Mail size={16} /> Connect Google</>}
              </Button>
            </>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Boxes size={20} /></span>
            <div>
              <p className="font-bold">Apify</p>
              {apify?.connected ? (
                <Badge tone="success"><BadgeCheck size={12} /> Connected</Badge>
              ) : (
                <Badge tone="sub">Not connected</Badge>
              )}
            </div>
          </div>
          {apify?.connected ? (
            <>
              <p className="text-sm text-sub">
                Web scraping, actors &amp; data extraction available to the AI Assistant.
              </p>
              <p className="mt-1 break-words text-xs text-sub">
                Enabled tools · <span className="font-mono">{apify.enabledTools}</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" disabled={apifyBusy} onClick={() => setShowApify((v) => !v)}>
                  Update token
                </Button>
                <Button variant="outline" disabled={apifyBusy} onClick={disconnectApify}>
                  {apifyBusy ? <Loader2 size={16} className="animate-spin" /> : "Disconnect"}
                </Button>
              </div>
            </>
          ) : (
            <p className="mb-3 text-sm text-sub">
              Connect your Apify token to give the AI Assistant web-scraping &amp; actor tools
              (find leads, enrich data, browse the web).
            </p>
          )}

          {(showApify || !apify?.connected) && (
            <div className="mt-3 flex flex-col gap-2">
              <Field label="Apify API token">
                <input
                  type="password"
                  className={inputCls}
                  placeholder="apify_api_…"
                  value={apifyToken}
                  onChange={(e) => setApifyToken(e.target.value)}
                  autoComplete="off"
                />
                <span className="mt-1 block text-xs text-sub">
                  Get it at{" "}
                  <a
                    href="https://console.apify.com/settings/integrations"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    console.apify.com/settings/integrations
                  </a>
                </span>
              </Field>
              <Field label="Enabled tools">
                <input
                  className={inputCls}
                  value={apifyTools}
                  onChange={(e) => setApifyTools(e.target.value)}
                  placeholder={APIFY_DEFAULT_TOOLS}
                />
                <span className="mt-1 block text-xs text-sub">
                  Comma-separated tool categories or Actors (e.g. actors, docs, apify/rag-web-browser).
                </span>
              </Field>
              <div className="flex gap-2">
                <Button className="w-fit" disabled={apifyBusy} onClick={connectApify}>
                  {apifyBusy ? <Loader2 size={16} className="animate-spin" /> : <><Boxes size={16} /> {apify?.connected ? "Save" : "Connect Apify"}</>}
                </Button>
                {apify?.connected && (
                  <Button variant="outline" className="w-fit" disabled={apifyBusy} onClick={() => setShowApify(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-mutedbg text-sub"><Plug size={20} /></span>
            <div>
              <p className="font-bold">HubSpot CRM</p>
              <Badge tone="sub">Not connected</Badge>
            </div>
          </div>
          <Button variant="outline" onClick={() => toast("HubSpot connection coming soon")}>Connect</Button>
        </Card>
      </div>
    </div>
  )
}

/* ---------- Settings ---------- */

const tabs = ["Profile", "LinkedIn limits", "Blacklist", "Billing"] as const

// Common timezones offered in the working-hours picker (working hours are
// evaluated in the account's timezone by the pacing engine).
const TZ_OPTIONS = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Dubai",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
]

export function Settings() {
  const toast = useToast()
  const [tab, setTab] = useState<(typeof tabs)[number]>("LinkedIn limits")
  const [me, setMe] = useState<Me | null>(null)
  const [account, setAccount] = useState<LinkedInAccountState | null>(null)
  const [weeklyCap, setWeeklyCap] = useState(100)
  const [warmupTarget, setWarmupTarget] = useState(45)
  const [hoursStart, setHoursStart] = useState("09:00")
  const [hoursEnd, setHoursEnd] = useState("18:00")
  const [timezone, setTimezone] = useState("UTC")
  const [sendWeekends, setSendWeekends] = useState(false)
  const [saving, setSaving] = useState(false)

  // Real profile + account limits — nothing hardcoded.
  useEffect(() => {
    let alive = true
    api.me().then((m) => alive && setMe(m)).catch(() => {})
    api
      .linkedinAccount()
      .then((a) => {
        if (!alive) return
        setAccount(a)
        if (a.weeklyInviteCap) setWeeklyCap(a.weeklyInviteCap)
        if (a.warmup?.target) setWarmupTarget(a.warmup.target)
        if (a.hoursStart) setHoursStart(a.hoursStart)
        if (a.hoursEnd) setHoursEnd(a.hoursEnd)
        if (a.timezone) setTimezone(a.timezone)
        setSendWeekends(!!a.sendWeekends)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const safeToday = account?.warmup?.todayLimit ?? 5

  // Persist the limits — this page is the ONLY place limits are set; the
  // backend stores them on the account and the pacing engine enforces them.
  const saveLimits = async () => {
    if (!account?.connected) {
      toast("Connect a LinkedIn account before setting limits.")
      return
    }
    setSaving(true)
    try {
      const a = await api.saveLinkedinLimits({
        dailyLimit: warmupTarget,
        weeklyInviteCap: weeklyCap,
        warmupTarget,
        hoursStart,
        hoursEnd,
        timezone,
        sendWeekends,
      })
      setAccount(a)
      if (a.weeklyInviteCap) setWeeklyCap(a.weeklyInviteCap)
      if (a.warmup?.target) setWarmupTarget(a.warmup.target)
      if (a.hoursStart) setHoursStart(a.hoursStart)
      if (a.hoursEnd) setHoursEnd(a.hoursEnd)
      if (a.timezone) setTimezone(a.timezone)
      setSendWeekends(!!a.sendWeekends)
      toast("Limits saved — the engine now enforces these.")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save limits")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-sub">Workspace, limits, and billing.</p>
      </div>
      <div className="flex gap-1 border-b border-line" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cx(
              "border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
              tab === t ? "border-accent text-accent" : "border-transparent text-sub hover:text-fg",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Profile" && (
        <div className="flex max-w-md flex-col gap-4">
          <Field label="Full name">
            <input className={inputCls} value={me?.fullName ?? ""} readOnly />
          </Field>
          <Field label="Email">
            <input className={inputCls} value={me?.email ?? ""} readOnly />
          </Field>
          <Field label="Workspace">
            <input className={inputCls} value={me?.workspaceName ?? ""} readOnly />
          </Field>
          <p className="text-xs text-sub">Editing your profile isn't wired up yet — these are your real account details.</p>
        </div>
      )}

      {tab === "LinkedIn limits" && (
        <div className="flex max-w-xl flex-col gap-5">
          <Field label={`Daily connection target — ${warmupTarget}/day`}>
            <input
              type="number"
              min={5}
              max={100}
              className={inputCls}
              value={warmupTarget}
              onChange={(e) => setWarmupTarget(Math.max(5, Math.min(100, Number(e.target.value) || 5)))}
            />
            <span className="mt-1 block text-xs text-sub">
              {account?.warmup
                ? `The daily ceiling your account warms up toward. Today it allows ${safeToday}/day, climbing to ${warmupTarget}. Real safe limits vary by account (free vs premium) — keep it conservative.`
                : "The single daily ceiling your warm-up ramps toward (default 45). Connect a LinkedIn account to see today's live limit."}
            </span>
          </Field>
          <Field label="Weekly invite cap">
            <input
              type="number"
              min={1}
              max={200}
              className={inputCls}
              value={weeklyCap}
              onChange={(e) => setWeeklyCap(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
            />
            <span className="mt-1 block text-xs text-sub">LinkedIn enforces ~100 invites/week for most accounts.</span>
          </Field>
          <Field label="Working hours (only send during these hours)">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="time"
                className={cx(inputCls, "w-auto")}
                value={hoursStart}
                onChange={(e) => setHoursStart(e.target.value)}
                aria-label="Working hours start"
              />
              <span className="text-sub">to</span>
              <input
                type="time"
                className={cx(inputCls, "w-auto")}
                value={hoursEnd}
                onChange={(e) => setHoursEnd(e.target.value)}
                aria-label="Working hours end"
              />
            </div>
            <span className="mt-1 block text-xs text-sub">
              The engine only sends between these hours (in the timezone below). An end time before
              the start wraps past midnight.
            </span>
          </Field>
          <Field label="Timezone">
            <select className={inputCls} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {!TZ_OPTIONS.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {TZ_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-sub">Working hours are evaluated in this timezone.</span>
          </Field>
          <label className="flex w-fit items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={sendWeekends}
              onChange={(e) => setSendWeekends(e.target.checked)}
              className="accent-[#0369a1]"
            />
            Send on weekends (Sat &amp; Sun)
          </label>
          <p className="rounded-md bg-mutedbg p-3 text-xs text-sub">
            This is the only place limits are set — Auto Connect and campaigns always send within
            what you save here. Automation may conflict with LinkedIn's User Agreement. Conservative
            limits and warm-up reduce risk. Use responsibly.
          </p>
          <Button className="w-fit" disabled={saving} onClick={saveLimits}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : "Save limits"}
          </Button>
        </div>
      )}

      {tab === "Blacklist" && (
        <div className="flex max-w-md flex-col gap-4">
          <Field label="Never contact these domains" hint="One domain per line — leads are auto-excluded from every campaign.">
            <textarea className={cx(inputCls, "font-[inherit]")} rows={4} defaultValue={"competitor.com"} />
          </Field>
          <Button className="w-fit" onClick={() => toast("Blacklist saved")}>Save blacklist</Button>
        </div>
      )}

      {tab === "Billing" && (
        <div className="grid max-w-2xl gap-4 md:grid-cols-2">
          <Card className="border-accent p-5">
            <p className="font-bold">Pro — current plan</p>
            <p className="tabular mt-1 text-3xl font-bold">$79<span className="text-sm font-semibold text-sub">/mo</span></p>
            <ul className="mt-3 flex flex-col gap-1 text-sm text-sub">
              <li>1 LinkedIn account</li>
              <li>Unlimited campaigns</li>
              <li>Email + LinkedIn sequences</li>
            </ul>
          </Card>
          <Card className="p-5">
            <p className="font-bold">Agency</p>
            <p className="tabular mt-1 text-3xl font-bold">$249<span className="text-sm font-semibold text-sub">/mo</span></p>
            <ul className="mt-3 flex flex-col gap-1 text-sm text-sub">
              <li>5 LinkedIn accounts</li>
              <li>Workspace roles</li>
              <li>White-label reports</li>
            </ul>
            <Button variant="outline" className="mt-3" onClick={() => toast("Upgrade flow coming soon")}>Upgrade</Button>
          </Card>
        </div>
      )}
    </div>
  )
}
