import { useEffect, useState } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { CalendarClock, Loader2, Send, ThumbsUp, MessageSquare } from "lucide-react"
import { api } from "../api"
import type { DashboardData, DailyStat } from "../api"
import { Card, ProgressRing, StatCard } from "../ui"

/** "Jul 17" from whatever date string the backend hands back (ISO or raw JS date). */
function fmtDay(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [series, setSeries] = useState<DailyStat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.all([api.getDashboard(), api.getAnalyticsDaily().catch(() => [])])
      .then(([d, s]) => {
        if (!alive) return
        setData(d)
        setSeries(s)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 size={26} className="animate-spin text-accent" />
      </div>
    )
  }

  const d = data
  const warmup = d?.account?.warmup

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-sub">Your outreach at a glance.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Invites sent" value={d?.invitesSent ?? 0} icon={<Send size={18} />} />
        <StatCard label="Acceptance rate" value={d?.acceptanceRate ?? 0} suffix="%" icon={<ThumbsUp size={18} />} />
        <StatCard label="Replies" value={d?.replies ?? 0} icon={<MessageSquare size={18} />} />
        <StatCard label="Meetings booked" value={d?.meetings ?? 0} icon={<CalendarClock size={18} />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <h2 className="mb-4 font-bold">Activity over time</h2>
          <div className="h-64">
            {series.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-sub">
                <p className="font-semibold">No activity yet</p>
                <p>Once you start sending, your daily invites, accepts and replies show up here.</p>
              </div>
            ) : (
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <defs>
                    <linearGradient id="inv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0369a1" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#0369a1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={fmtDay}
                    tick={{ fontSize: 12, fill: "var(--sub)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: "var(--sub)" }}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                  />
                  <Tooltip
                    labelFormatter={(v) => fmtDay(String(v))}
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
                  <Area type="monotone" dataKey="invites" stroke="#0369a1" strokeWidth={2} fill="url(#inv)" name="Invites" />
                  <Area type="monotone" dataKey="accepted" stroke="#16a34a" strokeWidth={2} fill="transparent" name="Accepted" />
                  <Area type="monotone" dataKey="replies" stroke="#d97706" strokeWidth={2} fill="transparent" name="Replies" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="flex flex-col items-center gap-3 p-5">
          <h2 className="self-start font-bold">Account health</h2>
          {d?.account && warmup ? (
            <>
              <ProgressRing pct={warmup.progressPct} label={`Warm-up progress ${warmup.progressPct}%`} />
              <p className="text-sm font-semibold">
                {d.account.status === "warming_up"
                  ? `Warming up — ${warmup.todayLimit} of ${warmup.target}/day`
                  : `Daily limit — ${warmup.todayLimit}/day`}
              </p>
              <p className="text-center text-xs text-sub">
                {d.account.dedicatedIp && d.account.dedicatedIp !== "0.0.0.0"
                  ? `Dedicated IP (${d.account.country || "—"})`
                  : `Local IP (${d.account.country || "no proxy"})`}
                {warmup.daysToFull > 0 ? ` · full capacity in ~${warmup.daysToFull} days` : " · at full capacity"}
              </p>
              <div className="mt-1 w-full rounded-md bg-mutedbg p-3 text-xs">
                <div className="mb-1 flex justify-between font-semibold">
                  <span>Today's invites</span>
                  <span className="tabular">
                    {d.sentToday} / {warmup.todayLimit}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-line">
                  <div
                    className="h-1.5 rounded-full bg-accent transition-all"
                    style={{ width: `${Math.min(100, warmup.todayLimit ? (d.sentToday / warmup.todayLimit) * 100 : 0)}%` }}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center py-6 text-center text-sm text-sub">
              <p className="font-semibold">No LinkedIn account connected</p>
              <p>Connect an account to start warming up and sending.</p>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 font-bold">Today's queue</h2>
          {(d?.queuedToday ?? 0) + (d?.scheduled ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-sub">Nothing queued. Upload profiles in Auto Connect to get started.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              <li className="flex items-center justify-between py-1.5">
                <span>Sending today</span>
                <span className="tabular font-semibold text-success">{d?.queuedToday ?? 0}</span>
              </li>
              <li className="flex items-center justify-between py-1.5">
                <span>Scheduled for later</span>
                <span className="tabular font-semibold text-warn">{d?.scheduled ?? 0}</span>
              </li>
            </ul>
          )}
        </Card>
        <Card className="flex flex-col p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold">Recent activity</h2>
            {(d?.activity.length ?? 0) > 0 && (
              <span className="tabular rounded-full bg-mutedbg px-2 py-0.5 text-xs font-semibold text-sub">
                {d!.activity.length}
              </span>
            )}
          </div>
          {(d?.activity.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-sub">No activity yet.</p>
          ) : (
            // Bounded scroll: a long history stays inside the card instead of
            // stretching the whole page. -mr-1/pr-1 keeps the scrollbar off the text.
            <ul className="-mr-1 flex max-h-80 flex-col divide-y divide-line overflow-y-auto pr-1">
              {d!.activity.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-sm">{f.text}</span>
                  <span className="shrink-0 text-xs text-sub">{f.time}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
