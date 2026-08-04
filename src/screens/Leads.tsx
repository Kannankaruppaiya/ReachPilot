import { useEffect, useState, type ReactNode } from "react"
import {
  ArrowUpRight,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  History,
  Loader2,
  Search,
  Sparkles,
  Tag,
  Users,
  X,
  XCircle,
} from "lucide-react"
import { Rocket } from "lucide-react"
import { api } from "@/lib/api"
import type { CampaignRow, LeadRow, ScrapeJob } from "@/types"
import { Avatar, Badge, Button, Card, EmptyState, LinkedinIcon } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"

const PAGE = 50
const TERMINAL = ["done", "blocked", "failed"]

function relTime(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Status → a leading dot + tinted pill, the scannable pattern outreach tools use.
const STATUS_STYLE: Record<string, { dot: string; text: string; bg: string; label: string }> = {
  new: { dot: "bg-slate-400", text: "text-sub", bg: "bg-mutedbg", label: "New" },
  contacted: { dot: "bg-warn", text: "text-warn", bg: "bg-warn/10", label: "Contacted" },
  pending: { dot: "bg-warn", text: "text-warn", bg: "bg-warn/10", label: "Pending" },
  accepted: { dot: "bg-accent", text: "text-accent", bg: "bg-accent/10", label: "Accepted" },
  replied: { dot: "bg-success", text: "text-success", bg: "bg-success/10", label: "Replied" },
  bounced: { dot: "bg-danger", text: "text-danger", bg: "bg-danger/10", label: "Bounced" },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[(status || "new").toLowerCase()] ?? {
    dot: "bg-slate-400",
    text: "text-sub",
    bg: "bg-mutedbg",
    label: status || "—",
  }
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold", s.bg, s.text)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  )
}

// Fit score graded green/blue/amber, like Clay's match indicators.
function ScorePill({ score }: { score: number }) {
  const tone =
    score >= 80 ? "bg-success/10 text-success" : score >= 55 ? "bg-accent/10 text-accent" : "bg-warn/10 text-warn"
  return (
    <span className={cx("tabular shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold", tone)} title={`Fit score ${score}`}>
      {score}
    </span>
  )
}

// Compact filter chip — a native select styled as a pill with a custom chevron,
// the pattern Linear / Attio / Apollo use instead of full-width form selects.
function FilterSelect({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  children: ReactNode
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={cx(
          "h-9 cursor-pointer appearance-none rounded-lg border bg-card pl-3 pr-8 text-sm font-medium text-fg transition-colors focus:border-accent focus:outline-none",
          value ? "border-accent/60" : "border-line hover:border-accent/50",
        )}
      >
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sub" />
    </div>
  )
}

// Skeleton row — product-grade loading (never a lone spinner over content).
function RowSkeleton() {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-3.5">
        <div className="h-4 w-4 rounded bg-mutedbg" />
      </td>
      <td className="px-2 py-3.5">
        <div className="flex items-center gap-3">
          <div className="h-[34px] w-[34px] shrink-0 rounded-full bg-mutedbg" />
          <div className="space-y-1.5">
            <div className="h-3 w-32 rounded bg-mutedbg" />
            <div className="h-2.5 w-24 rounded bg-mutedbg/70" />
          </div>
        </div>
      </td>
      <td className="hidden px-3 py-3.5 md:table-cell">
        <div className="h-3 w-28 rounded bg-mutedbg" />
      </td>
      <td className="hidden px-3 py-3.5 lg:table-cell">
        <div className="h-3 w-36 rounded bg-mutedbg" />
      </td>
      <td className="px-3 py-3.5">
        <div className="h-5 w-16 rounded-full bg-mutedbg" />
      </td>
      <td className="hidden px-3 py-3.5 xl:table-cell">
        <div className="h-3 w-14 rounded bg-mutedbg" />
      </td>
      <td className="w-24 px-3 py-3.5" />
    </tr>
  )
}

export function Leads() {
  const toast = useToast()
  const [q, setQ] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
  const [status, setStatus] = useState("")
  const [source, setSource] = useState("")
  const [sort, setSort] = useState<"recent" | "score">("recent")

  const [sel, setSel] = useState<string[]>([])
  const [open, setOpen] = useState<LeadRow | null>(null)
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // Scrape run tracking (history + live progress)
  const [jobs, setJobs] = useState<ScrapeJob[]>([])
  const [activeJob, setActiveJob] = useState<ScrapeJob | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // When set, the table shows ONLY the leads from that one scrape run (a "list").
  const [viewJob, setViewJob] = useState<ScrapeJob | null>(null)

  const viewRun = (j: ScrapeJob) => {
    setViewJob(j)
    setHistoryOpen(false)
    setSel([])
  }

  // Scrape-leads modal
  const [scrapeOpen, setScrapeOpen] = useState(false)
  const [titles, setTitles] = useState("Finance Head, Finance Manager")
  const [location, setLocation] = useState("Tamil Nadu")
  const [count, setCount] = useState(50)
  const [startFresh, setStartFresh] = useState(false)
  const [scraping, setScraping] = useState(false)

  // Add-to-campaign picker
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(false)
  const [enrolling, setEnrolling] = useState<string | null>(null)

  const openCampaignPicker = () => {
    setCampaignPickerOpen(true)
    setCampaignsLoading(true)
    api
      .getCampaigns()
      .then(setCampaigns)
      .catch(() => setCampaigns([]))
      .finally(() => setCampaignsLoading(false))
  }

  const enrollInCampaign = async (c: CampaignRow) => {
    setEnrolling(c.id)
    try {
      const res = await api.enrollLeads(c.id, sel)
      toast(`${res.enrolled} lead(s) added to "${c.name}"`)
      setCampaignPickerOpen(false)
      setSel([])
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add to campaign")
    } finally {
      setEnrolling(null)
    }
  }

  const loadJobs = () => api.getScrapeJobs().then(setJobs).catch(() => undefined)
  useEffect(() => {
    loadJobs()
  }, [])

  // Debounce the search box so we hit the server at most every ~350ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350)
    return () => clearTimeout(t)
  }, [q])

  // First page — reloads whenever a filter/search/sort (or a finished scrape) changes.
  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .getLeads({ limit: PAGE, offset: 0, q: debouncedQ || undefined, status: status || undefined, source: source || undefined, sort, scrapeJobId: viewJob?.id })
      .then((rows) => {
        if (!alive) return
        setLeads(rows)
        setHasMore(rows.length === PAGE)
        setOffset(rows.length)
      })
      .catch(() => alive && setLeads([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [debouncedQ, status, source, sort, reloadKey, viewJob?.id])

  // Poll the running scrape until it finishes, then reveal the new leads.
  useEffect(() => {
    if (!activeJob || TERMINAL.includes(activeJob.status)) return
    const t = setInterval(async () => {
      try {
        const j = await api.getScrapeJob(activeJob.id)
        if (!j) return
        setActiveJob(j)
        if (TERMINAL.includes(j.status)) {
          clearInterval(t)
          setReloadKey((k) => k + 1)
          loadJobs()
          if (j.status === "done") toast(`Scrape done — ${j.counts?.imported ?? 0} leads added.`)
          else if (j.status === "blocked") toast("Scrape finished — no new leads found.")
          else toast("Scrape failed. Try again.")
          setTimeout(() => setActiveJob(null), 5000)
        }
      } catch {
        /* keep polling */
      }
    }, 3000)
    return () => clearInterval(t)
  }, [activeJob?.id, activeJob?.status])

  const loadMore = () => {
    setLoadingMore(true)
    api
      .getLeads({ limit: PAGE, offset, q: debouncedQ || undefined, status: status || undefined, source: source || undefined, sort, scrapeJobId: viewJob?.id })
      .then((rows) => {
        // Dedupe on append — offset pagination can overlap when rows shift under
        // it, and duplicate lead ids would collide as React keys.
        setLeads((prev) => {
          const seen = new Set(prev.map((l) => l.id))
          return [...prev, ...rows.filter((r) => !seen.has(r.id))]
        })
        setHasMore(rows.length === PAGE)
        setOffset((o) => o + rows.length)
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false))
  }

  const exportCsv = () => {
    const rows = leads.filter((l) => sel.includes(l.id))
    if (!rows.length) {
      toast("No leads selected to export.")
      return
    }
    const headers = [
      "Name",
      "First Name",
      "Title",
      "Company",
      "Location",
      "Email",
      "Email Verified",
      "Status",
      "Source",
      "Tags",
      "Fit Score",
      "LinkedIn URL",
      "Created At",
    ]
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [
      headers.join(","),
      ...rows.map((l) =>
        [
          l.name,
          l.firstName,
          l.title,
          l.company,
          l.location,
          l.email,
          l.emailVerified ? "yes" : "no",
          l.status,
          l.source ?? "",
          (l.tags ?? []).join("; "),
          l.fitScore ?? "",
          l.linkedinUrl,
          l.createdAt,
        ]
          .map(cell)
          .join(","),
      ),
    ]
    // Prepend a BOM so Excel opens UTF-8 (accented names) correctly.
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `reachpilot-leads-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast(`${rows.length} lead(s) exported`)
  }

  const runScrape = async () => {
    const titleList = titles.split(",").map((t) => t.trim()).filter(Boolean)
    if (!titleList.length) {
      toast("Enter at least one job title.")
      return
    }
    setScraping(true)
    try {
      const res = await api.scrapeLeads({ titles: titleList, location: location.trim() || undefined, maxResults: count, startFresh })
      setScrapeOpen(false)
      // Track this run live — a big scrape can take a couple of minutes, and the
      // progress banner shows it working until the leads land.
      setActiveJob({
        id: res.scrapeJobId,
        titles: titleList,
        location: location.trim() || null,
        maxResults: count,
        status: "queued",
        stage: null,
        counts: {},
        reason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      loadJobs()
    } catch {
      toast("Couldn't start the scrape. Try again.")
    } finally {
      setScraping(false)
    }
  }

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const running = activeJob && !TERMINAL.includes(activeJob.status)

  // Header select-all over the loaded page (indeterminate when partial).
  const allSelected = leads.length > 0 && leads.every((l) => sel.includes(l.id))
  const someSelected = sel.length > 0 && !allSelected
  const toggleAll = () => setSel(allSelected ? [] : leads.map((l) => l.id))

  const jobBadge = (s: string) =>
    s === "done" ? (
      <Badge tone="success">Done</Badge>
    ) : s === "failed" ? (
      <Badge tone="danger">Failed</Badge>
    ) : s === "blocked" ? (
      <Badge tone="sub">No results</Badge>
    ) : (
      <Badge tone="accent">Running</Badge>
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Leads</h1>
          <p className="text-sm text-sub">Everyone you're reaching out to, in one place.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="shrink-0" onClick={() => setHistoryOpen(true)} aria-label="Scrape history">
            <History size={15} /> History
          </Button>
          <Button className="shrink-0 whitespace-nowrap" onClick={() => setScrapeOpen(true)}>
            <Sparkles size={15} /> Scrape leads
          </Button>
        </div>
      </div>

      {/* Live scrape progress — a run can take a minute or two on large counts. */}
      {activeJob && (
        <Card className={cx("flex items-center gap-3 px-4 py-3", running ? "border-accent bg-accent/5" : "border-line")}>
          {running ? (
            <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
          ) : activeJob.status === "done" ? (
            <CheckCircle2 size={16} className="shrink-0 text-success" />
          ) : (
            <XCircle size={16} className="shrink-0 text-sub" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {running ? "Scraping" : activeJob.status === "done" ? "Scrape complete" : "Scrape finished"}
              {" — "}
              {activeJob.titles.join(", ")}
              {activeJob.location ? ` · ${activeJob.location}` : ""}
            </p>
            <p className="text-xs text-sub">
              {running
                ? `${activeJob.stage || "starting"}${activeJob.counts?.valid != null ? ` · ${activeJob.counts.valid} found` : ""}`
                : activeJob.status === "done"
                  ? `${activeJob.counts?.imported ?? 0} leads added`
                  : "No new leads this run"}
            </p>
          </div>
        </Card>
      )}

      {/* Toolbar — search + compact filter chips + count, one clean control row. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[11rem] flex-1 sm:max-w-xs">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
          <input
            className="h-9 w-full rounded-lg border border-line bg-card pl-9 pr-3 text-sm placeholder:text-sub focus:border-accent focus:outline-none"
            placeholder="Search name, company, title"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search leads"
          />
        </div>
        <FilterSelect value={status} onChange={setStatus} ariaLabel="Filter by status">
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="accepted">Accepted</option>
          <option value="replied">Replied</option>
          <option value="bounced">Bounced</option>
        </FilterSelect>
        <FilterSelect value={source} onChange={setSource} ariaLabel="Filter by source">
          <option value="">All sources</option>
          <option value="google-scrape">Scraped</option>
          <option value="import">Imported</option>
        </FilterSelect>
        <FilterSelect value={sort} onChange={(v) => setSort(v as "recent" | "score")} ariaLabel="Sort leads">
          <option value="recent">Newest first</option>
          <option value="score">Best fit</option>
        </FilterSelect>
        {(status || source || debouncedQ) && (
          <button
            className="rounded-lg px-2 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10"
            onClick={() => {
              setStatus("")
              setSource("")
              setQ("")
            }}
          >
            Clear
          </button>
        )}
        <span className="tabular ml-auto shrink-0 text-xs text-sub">
          {loading ? "Loading…" : `${leads.length}${hasMore ? "+" : ""} lead${leads.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Viewing a single scrape run's leads (opened from History). */}
      {viewJob && (
        <Card className="flex flex-wrap items-center gap-3 border-accent bg-accent/5 px-4 py-2.5">
          <History size={16} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {viewJob.titles.join(", ")}
              {viewJob.location ? ` · ${viewJob.location}` : ""}
            </p>
            <p className="text-xs text-sub">
              Leads from this scrape run
              {typeof viewJob.counts?.imported === "number" ? ` · ${viewJob.counts.imported} added` : ""} ·{" "}
              {relTime(viewJob.createdAt)}
            </p>
          </div>
          <Button variant="outline" className="shrink-0 px-3 py-1.5 text-xs" onClick={() => setViewJob(null)}>
            <X size={14} /> View all leads
          </Button>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wide text-sub">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all leads on this page"
                    className="align-middle accent-[#0369a1]"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected
                    }}
                    onChange={toggleAll}
                    disabled={loading || leads.length === 0}
                  />
                </th>
                <th className="px-2 py-3">Lead</th>
                <th className="hidden px-3 py-3 md:table-cell">Company</th>
                <th className="hidden px-3 py-3 lg:table-cell">Email</th>
                <th className="px-3 py-3">Status</th>
                <th className="hidden px-3 py-3 xl:table-cell">Source</th>
                <th className="w-24 px-3 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className={cx(loading && "animate-pulse")}>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => <RowSkeleton key={i} />)
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {viewJob ? (
                      <EmptyState
                        icon={<History size={28} />}
                        title="No leads from this run"
                        hint="This scrape run didn't add any leads (or they were already in your list from an earlier run)."
                        action={
                          <Button variant="outline" onClick={() => setViewJob(null)}>
                            View all leads
                          </Button>
                        }
                      />
                    ) : debouncedQ || status || source ? (
                      <EmptyState
                        icon={<Search size={28} />}
                        title="No matching leads"
                        hint="Try a different search or clear the filters."
                        action={
                          <Button
                            variant="outline"
                            onClick={() => {
                              setQ("")
                              setStatus("")
                              setSource("")
                            }}
                          >
                            Clear filters
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        icon={<Users size={28} />}
                        title="No leads yet"
                        hint="Scrape LinkedIn profiles by title + location, or import a list — they'll show up here."
                        action={
                          <Button onClick={() => setScrapeOpen(true)}>
                            <Sparkles size={15} /> Scrape leads
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : (
                leads.map((l) => {
                  const selected = sel.includes(l.id)
                  return (
                    <tr
                      key={l.id}
                      className={cx(
                        "group cursor-pointer border-b border-line transition-colors last:border-0",
                        selected ? "bg-accent/5" : "hover:bg-mutedbg/40",
                      )}
                      onClick={() => setOpen(l)}
                    >
                      <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggle(l.id)}
                          aria-label={`Select ${l.name}`}
                          className="align-middle accent-[#0369a1]"
                        />
                      </td>
                      <td className="px-2 py-3.5">
                        <div className="flex items-center gap-3">
                          <Avatar name={l.name} size={34} />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 font-semibold">
                              <span className="truncate">{l.name}</span>
                              {typeof l.fitScore === "number" && <ScorePill score={l.fitScore} />}
                            </p>
                            <p className="truncate text-xs text-sub">{l.title || "—"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden max-w-[220px] px-3 py-3.5 md:table-cell">
                        {l.company ? (
                          <span className="flex items-center gap-2">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-mutedbg text-sub">
                              <Building2 size={12} />
                            </span>
                            <span className="truncate">{l.company}</span>
                          </span>
                        ) : (
                          <span className="text-sub">—</span>
                        )}
                      </td>
                      <td className="hidden max-w-[240px] px-3 py-3.5 lg:table-cell">
                        {l.email ? (
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{l.email}</span>
                            {l.emailVerified && (
                              <BadgeCheck size={14} className="shrink-0 text-success" aria-label="Verified" />
                            )}
                          </span>
                        ) : (
                          <span className="text-sub">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        <StatusPill status={l.status} />
                      </td>
                      <td className="hidden px-3 py-3.5 text-xs text-sub xl:table-cell">
                        {(l.source || "").startsWith("google-scrape") ? "Scraped" : l.source || "—"}
                      </td>
                      <td className="px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          {l.linkedinUrl && (
                            <a
                              href={l.linkedinUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-md p-1.5 text-sub hover:bg-mutedbg hover:text-accent"
                              aria-label={`Open ${l.name} on LinkedIn`}
                              title="Open LinkedIn"
                            >
                              <LinkedinIcon size={15} />
                            </a>
                          )}
                          <button
                            className="rounded-md p-1.5 text-sub hover:bg-mutedbg hover:text-accent"
                            aria-label={`Add ${l.name} to a campaign`}
                            title="Add to campaign"
                            onClick={() => {
                              setSel([l.id])
                              openCampaignPicker()
                            }}
                          >
                            <Users size={15} />
                          </button>
                          <button
                            className="rounded-md p-1.5 text-sub hover:bg-mutedbg hover:text-fg"
                            aria-label={`Open ${l.name}'s profile`}
                            title="View details"
                            onClick={() => setOpen(l)}
                          >
                            <ArrowUpRight size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {!loading && leads.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 text-xs text-sub">
            <span className="tabular">
              Showing {leads.length} lead{leads.length === 1 ? "" : "s"}
              {hasMore ? "+" : ""}
            </span>
            {hasMore && (
              <Button variant="outline" className="px-3 py-1.5 text-xs" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Loader2 size={13} className="animate-spin" /> : null}
                Load more
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* Floating bulk-action bar — appears on selection (Linear / Gmail pattern). */}
      {sel.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
          <div className="toast-in pointer-events-auto flex items-center gap-1 rounded-full border border-line bg-card/95 py-1.5 pl-4 pr-2 shadow-lg backdrop-blur">
            <span className="tabular text-sm font-bold">{sel.length}</span>
            <span className="mr-1 text-sm text-sub">selected</span>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={openCampaignPicker}>
              <Users size={14} /> Campaign
            </Button>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={exportCsv}>
              <Download size={14} /> Export
            </Button>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => toast("Tag applied")}>
              <Tag size={14} /> Tag
            </Button>
            <button
              className="ml-1 rounded-full p-1.5 text-sub hover:bg-mutedbg hover:text-fg"
              aria-label="Clear selection"
              onClick={() => setSel([])}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Scrape history — like the Assistant's conversation history. */}
      {historyOpen && (
        <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setHistoryOpen(false)}>
          <aside
            className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-line bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Scrape history"
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <p className="flex items-center gap-2 text-lg font-bold">
                <History size={18} /> Scrape history
              </p>
              <button aria-label="Close history" className="rounded-md p-1.5 text-sub hover:bg-mutedbg" onClick={() => setHistoryOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {jobs.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-sub">No scrape runs yet.</div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <button
                        onClick={() => viewRun(j)}
                        className={cx(
                          "w-full rounded-lg border p-3 text-left transition-colors",
                          viewJob?.id === j.id
                            ? "border-accent bg-accent/5"
                            : "border-line hover:border-accent hover:bg-accent/5",
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{j.titles.join(", ")}</span>
                          {jobBadge(j.status)}
                        </div>
                        <p className="text-xs text-sub">
                          {j.location ? `${j.location} · ` : ""}
                          {j.status === "done"
                            ? `${j.counts?.imported ?? 0} leads added`
                            : j.status === "running" || j.status === "queued"
                              ? j.stage || "running…"
                              : j.status === "blocked"
                                ? "no results"
                                : "failed"}
                        </p>
                        <p className="mt-1 flex items-center justify-between gap-1 text-[11px] text-sub">
                          <span className="flex items-center gap-1">
                            <Clock size={11} /> {relTime(j.createdAt)}
                          </span>
                          <span className="flex items-center gap-0.5 font-semibold text-accent">
                            View <ArrowUpRight size={12} />
                          </span>
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setOpen(null)}>
          <aside
            className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-line bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={`Lead profile — ${open.name}`}
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <Avatar name={open.name} size={52} />
                <div>
                  <p className="text-lg font-bold">{open.name}</p>
                  <p className="text-sm text-sub">{open.title}</p>
                </div>
              </div>
              <button aria-label="Close profile" className="rounded-md p-1.5 text-sub hover:bg-mutedbg" onClick={() => setOpen(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="flex flex-col gap-4 text-sm">
              {[
                ["Company", open.company],
                ["Location", open.location],
                ["Email", open.email],
                ["LinkedIn", open.linkedinUrl],
                ["Status", open.status],
                ["Source", (open.source || "").startsWith("google-scrape") ? "Scraped" : open.source],
                ["Last activity", open.lastActivity],
              ].map(([k, v]) => (
                <div key={k} className="border-b border-line pb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-sub">{k}</p>
                  <p className="break-words font-semibold">{v || "—"}</p>
                </div>
              ))}
              {(open.tags?.length ?? 0) > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-sub">Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {open.tags.map((t) => (
                      <Badge key={t} tone="accent">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {scrapeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !scraping && setScrapeOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Scrape leads"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <Sparkles size={18} className="text-accent" />
                <div>
                  <p className="text-lg font-bold">Scrape leads</p>
                  <p className="text-xs text-sub">Find LinkedIn profiles by title + location — free.</p>
                </div>
              </div>
              <button aria-label="Close" className="rounded-md p-1.5 text-sub hover:bg-mutedbg" onClick={() => !scraping && setScrapeOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-sub">Job titles</span>
                <input className={inputCls} value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="Finance Head, Finance Manager" />
                <span className="text-xs text-sub">Comma-separated. Each is matched as an exact phrase.</span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-sub">Location</span>
                <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Tamil Nadu" />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-sub">How many</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className={cx(inputCls, "w-28")}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                />
                <span className="text-xs text-sub">Up to 100 per run. Re-run the same search to keep collecting more.</span>
              </label>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3">
                <input type="checkbox" checked={startFresh} onChange={(e) => setStartFresh(e.target.checked)} className="mt-0.5 accent-[#0369a1]" />
                <span className="text-sm">
                  <span className="font-semibold">Start fresh</span>
                  <span className="block text-xs text-sub">Re-scan this search from the top instead of continuing where the last run left off.</span>
                </span>
              </label>

              <div className="mt-1 flex items-center justify-end gap-2">
                <Button variant="outline" onClick={() => setScrapeOpen(false)} disabled={scraping}>
                  Cancel
                </Button>
                <Button onClick={runScrape} disabled={scraping}>
                  {scraping ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                  {scraping ? "Starting…" : "Scrape"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {campaignPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !enrolling && setCampaignPickerOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Add to campaign"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <Rocket size={18} className="text-accent" />
                <div>
                  <p className="text-lg font-bold">Add to campaign</p>
                  <p className="text-xs text-sub">Enroll {sel.length} selected lead(s) into a sequence.</p>
                </div>
              </div>
              <button aria-label="Close" className="rounded-md p-1.5 text-sub hover:bg-mutedbg" onClick={() => !enrolling && setCampaignPickerOpen(false)}>
                <X size={18} />
              </button>
            </div>

            {campaignsLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 size={20} className="animate-spin text-accent" />
              </div>
            ) : campaigns.length === 0 ? (
              <p className="py-8 text-center text-sm text-sub">
                No campaigns yet — create one from the Campaigns page first.
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
                {campaigns.map((c) => (
                  <li key={c.id}>
                    <button
                      className="flex w-full items-center gap-3 rounded-lg border border-line p-3 text-left hover:border-accent hover:bg-accent/5 disabled:opacity-60"
                      disabled={!!enrolling}
                      onClick={() => enrollInCampaign(c)}
                    >
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{c.name}</p>
                        <p className="text-xs text-sub">{c.status} · {c.leads} leads</p>
                      </div>
                      {enrolling === c.id ? (
                        <Loader2 size={16} className="animate-spin text-accent" />
                      ) : (
                        <Users size={16} className="text-sub" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
