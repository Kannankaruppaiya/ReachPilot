import { useEffect, useMemo, useState } from "react"
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Trash2,
  UserCheck,
  Users,
  XCircle,
} from "lucide-react"
import { api } from "@/lib/api"
import type { ConnectionRow, ConnectionsData, ConnectionOutcome, ConnectionDelivery } from "@/types"
import { Badge, Button, Card, StatCard } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"

const REFRESH_MS = 20_000
const PAGE_SIZES = [10, 25, 50, 100]

/** Human-friendly "2h ago" / "just now" from an ISO timestamp. */
function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const s = Math.floor((Date.now() - then) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// ── Outcome column temporarily disabled ───────────────────────────────
// LinkedIn sync is OFF (LINKEDIN_SYNC_ENABLED=false), so acceptance/reply
// detection never runs — every sent invite would show a misleading "Awaiting".
// Re-enable outcomeMeta + the <th>/<td>/`om` below when sync is turned back on.
/*
const outcomeMeta: Record<ConnectionOutcome, { tone: string; label: string; icon: React.ReactNode }> = {
  accepted: { tone: "success", label: "Accepted", icon: <UserCheck size={12} /> },
  replied: { tone: "accent", label: "Replied", icon: <MessageSquare size={12} /> },
  pending: { tone: "warn", label: "Awaiting", icon: <Clock size={12} /> },
  in_queue: { tone: "sub", label: "In queue", icon: <Clock size={12} /> },
  failed: { tone: "danger", label: "Failed", icon: <XCircle size={12} /> },
}
*/

const deliveryMeta: Record<ConnectionDelivery, { tone: string; label: string }> = {
  sent: { tone: "success", label: "Sent" },
  running: { tone: "accent", label: "Sending" },
  queued: { tone: "warn", label: "Queued" },
  scheduled: { tone: "sub", label: "Scheduled" },
  failed: { tone: "danger", label: "Failed" },
  canceled: { tone: "sub", label: "Canceled" },
}

type Filter = "all" | ConnectionOutcome

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Awaiting" },
  { key: "accepted", label: "Accepted" },
  { key: "replied", label: "Replied" },
  { key: "in_queue", label: "In queue" },
  { key: "failed", label: "Failed" },
]

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?"
}

export function Connections() {
  const toast = useToast()
  const [data, setData] = useState<ConnectionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("all")
  const [q, setQ] = useState("")
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)

  // Changing the filter, search or page size restarts you at page 1.
  useEffect(() => {
    setPage(1)
  }, [filter, q, pageSize])

  const load = async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const d = await api.getConnections()
      setData(d)
      setError(null)
      setUpdatedAt(new Date())
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't load connections"
      setError(msg)
      if (manual) toast(msg)
    } finally {
      setLoading(false)
      if (manual) setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(() => load(), REFRESH_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Delete one row (cancels + removes the job).
  const deleteRow = async (id: string) => {
    setData((d) => (d ? { ...d, rows: d.rows.filter((r) => r.id !== id) } : d))
    try {
      await api.deleteJob(id)
      load()
    } catch {
      toast("Couldn't delete that request.")
      load()
    }
  }

  // Clear just the not-yet-sent queue (scheduled + queued), keeping sent history.
  const clearQueue = async () => {
    if (!window.confirm("Cancel and delete all queued/scheduled connection requests?")) return
    try {
      const r = await api.clearJobs(["scheduled", "queued"], "linkedin")
      toast(`Cleared ${r.deleted} from the queue`)
      load(true)
    } catch {
      toast("Couldn't clear the queue.")
    }
  }

  // Wipe ALL LinkedIn connection jobs — a clean slate to test the flow fresh.
  const clearAll = async () => {
    if (!window.confirm("Delete ALL connection history for a fresh test? This can't be undone.")) return
    try {
      const r = await api.clearJobs(undefined, "linkedin")
      toast(`Deleted ${r.deleted} — clean slate`)
      load(true)
    } catch {
      toast("Couldn't clear.")
    }
  }

  const rows = data?.rows ?? []
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter !== "all" && r.outcome !== filter) return false
      if (!needle) return true
      return (
        r.name.toLowerCase().includes(needle) ||
        r.company.toLowerCase().includes(needle) ||
        r.role.toLowerCase().includes(needle) ||
        r.linkedinUrl.toLowerCase().includes(needle)
      )
    })
  }, [rows, filter, q])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  )
  const rangeStart = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const rangeEnd = Math.min(filtered.length, safePage * pageSize)

  const s = data?.summary

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Users size={22} className="text-accent" /> Connections
          </h1>
          <p className="text-sm text-sub">
            Everyone you've sent a LinkedIn connection request to, with live delivery and acceptance status.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {updatedAt && (
            <span className="hidden text-xs text-sub sm:inline">Updated {timeAgo(updatedAt.toISOString())}</span>
          )}
          <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={15} className={cx(refreshing && "animate-spin")} /> Refresh
          </Button>
          {(s?.inQueue ?? 0) > 0 && (
            <Button variant="outline" onClick={clearQueue}>
              <XCircle size={15} /> Clear queue
            </Button>
          )}
          {rows.length > 0 && (
            <Button variant="danger" onClick={clearAll}>
              <Trash2 size={15} /> Clear all
            </Button>
          )}
        </div>
      </div>

      {/* Summary tiles */}
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Requests sent" value={s.sent} icon={<Send size={16} />} />
          <StatCard label="Accepted" value={s.accepted} icon={<UserCheck size={16} />} />
          <StatCard label="Replied" value={s.replied} icon={<MessageSquare size={16} />} />
          <StatCard label="Awaiting" value={s.pending} icon={<Clock size={16} />} />
          <StatCard label="In queue" value={s.inQueue} icon={<Clock size={16} />} />
          <StatCard label="Accept rate" value={s.acceptanceRate} suffix="%" icon={<CheckCircle2 size={16} />} />
        </div>
      )}

      {/* Controls */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => {
              const count =
                f.key === "all" ? rows.length : rows.filter((r) => r.outcome === f.key).length
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cx(
                    "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    filter === f.key ? "bg-accent text-white" : "bg-mutedbg text-sub hover:text-fg",
                  )}
                >
                  {f.label}
                  <span className="ml-1.5 tabular opacity-70">{count}</span>
                </button>
              )
            })}
          </div>
          <div className="relative ml-auto">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, company, role…"
              aria-label="Search connections"
              className={cx(inputCls, "w-full pl-9 sm:w-72")}
            />
          </div>
        </div>

        {/* Table / states */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sub">
            <Loader2 size={18} className="animate-spin" /> Loading connections…
          </div>
        ) : error && rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-danger">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Users size={28} className="text-sub" />
            <p className="font-semibold">
              {rows.length === 0 ? "No connection requests sent yet" : "No matches for this filter"}
            </p>
            <p className="max-w-sm text-sm text-sub">
              {rows.length === 0
                ? "Head to Auto Connect, upload your profiles and start a batch — every request shows up here with its live status."
                : "Try a different filter or clear the search."}
            </p>
          </div>
        ) : (
          <div className="max-h-[540px] overflow-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--line)]">
                <tr className="text-xs font-semibold uppercase tracking-wide text-sub">
                  <th className="px-4 py-3">Person</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Delivery</th>
                  {/* Outcome column disabled — LinkedIn sync off (see outcomeMeta) */}
                  {/* <th className="px-4 py-3">Outcome</th> */}
                  <th className="px-4 py-3">Sent</th>
                  <th className="px-4 py-3">Profile</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((r) => (
                  <ConnectionRowView key={r.id} r={r} onDelete={() => deleteRow(r.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 text-xs text-sub">
            <label className="flex items-center gap-1.5">
              Rows per page
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label="Rows per page"
                className="rounded-md border border-line bg-card px-2 py-1 font-semibold text-fg"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <span className="tabular">
              Showing {rangeStart}–{rangeEnd} of {filtered.length}
              {filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ""}
            </span>
            <span className="hidden sm:inline">· auto-refreshes every {REFRESH_MS / 1000}s</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                aria-label="Previous page"
                className="rounded-md border border-line p-1.5 transition-colors hover:bg-mutedbg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="tabular px-1 font-semibold">
                Page {safePage} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                aria-label="Next page"
                className="rounded-md border border-line p-1.5 transition-colors hover:bg-mutedbg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function ConnectionRowView({ r, onDelete }: { r: ConnectionRow; onDelete: () => void }) {
  // const om = outcomeMeta[r.outcome]  // outcome column disabled (sync off)
  const dm = deliveryMeta[r.delivery]
  return (
    <tr className="border-b border-line last:border-0 hover:bg-mutedbg/40">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-bold text-white dark:bg-accent">
            {initials(r.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{r.name || "—"}</p>
            {r.role && <p className="truncate text-xs text-sub">{r.role}</p>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-sub">{r.company || "—"}</span>
      </td>
      <td className="px-4 py-3">
        <Badge tone={dm.tone}>{dm.label}</Badge>
      </td>
      {/* Outcome cell disabled — LinkedIn sync off (re-enable with outcomeMeta/om above)
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <Badge tone={om.tone}>
            {om.icon} {om.label}
          </Badge>
          {r.outcome === "failed" && r.error && (
            <span className="max-w-[180px] truncate text-xs text-danger" title={r.error}>
              {r.error}
            </span>
          )}
        </div>
      </td>
      */}
      <td className="px-4 py-3 whitespace-nowrap text-sub">{timeAgo(r.sentAt)}</td>
      <td className="px-4 py-3">
        {r.linkedinUrl ? (
          <a
            // A bare "linkedin.com/in/x" without a protocol resolves against the
            // app domain (→ Vercel 404). Force an absolute URL.
            href={/^https?:\/\//i.test(r.linkedinUrl) ? r.linkedinUrl : `https://${r.linkedinUrl.replace(/^\/+/, '')}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
          >
            Open <ExternalLink size={12} />
          </a>
        ) : (
          <span className="text-xs text-sub">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={onDelete}
          aria-label={`Delete request to ${r.name}`}
          title={r.outcome === "in_queue" ? "Cancel & delete from queue" : "Delete from history"}
          className="rounded-md p-1.5 text-sub transition-colors hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  )
}
