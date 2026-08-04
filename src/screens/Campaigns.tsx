import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  GitBranch,
  Loader2,
  Mail,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Rocket,
  Search,
  Trash2,
  UserPlus,
  X,
} from "lucide-react"
import { Line, LineChart, ResponsiveContainer } from "recharts"
import { longestRender, renderTemplate } from "@/lib/utils/template"
import { api } from "@/lib/api"
import type {
  CampaignBuilderNode,
  CampaignDetailData,
  CampaignRow,
  LeadRow,
  LinkedInAccountState,
} from "@/types"
import { Avatar, Badge, Button, Card, Dot, EmptyState, Field } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"

type Campaign = CampaignRow

/* ---------- list ---------- */

export function CampaignList({
  onOpen,
  onNew,
}: {
  onOpen: (c: Campaign) => void
  onNew: () => void
}) {
  const toast = useToast()
  const [items, setItems] = useState<CampaignRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .getCampaigns()
      .then((rows) => alive && setItems(rows))
      .catch(() => alive && setItems([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  // Persist the pause/resume to the backend, not just local state.
  const togglePause = async (c: CampaignRow) => {
    const next = c.status === "Active" ? "Paused" : "Active"
    setItems((arr) => arr.map((x) => (x.id === c.id ? { ...x, status: next } : x)))
    try {
      await api.updateCampaign(c.id, { status: next })
      toast(`Campaign ${next.toLowerCase()}`)
    } catch (e) {
      setItems((arr) => arr.map((x) => (x.id === c.id ? { ...x, status: c.status } : x)))
      toast(e instanceof Error ? e.message : "Couldn't update campaign")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Campaigns</h1>
          <p className="text-sm text-sub">Automated LinkedIn + email sequences.</p>
        </div>
        <Button onClick={onNew}>
          <Plus size={16} /> New campaign
        </Button>
      </div>
      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-accent" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Rocket size={28} />}
            title="No campaigns yet"
            hint="Create your first campaign to start an automated sequence."
            action={<Button onClick={onNew}><Plus size={16} /> New campaign</Button>}
          />
        ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-sub">
              <th className="px-5 py-3">Campaign</th>
              <th className="hidden px-3 py-3 md:table-cell">Leads</th>
              <th className="hidden px-3 py-3 md:table-cell">Sent</th>
              <th className="px-3 py-3">Accepted</th>
              <th className="hidden px-3 py-3 sm:table-cell">Replied</th>
              <th className="hidden px-3 py-3 lg:table-cell">Trend</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-mutedbg/50"
                onClick={() => onOpen(c)}
              >
                <td className="px-5 py-4">
                  <div className="flex items-center gap-2 font-semibold">
                    <Dot tone={c.status === "Active" ? "success" : "warn"} />
                    {c.name}
                  </div>
                  <span className="text-xs text-sub">{c.status}</span>
                </td>
                <td className="tabular hidden px-3 py-4 md:table-cell">{c.leads}</td>
                <td className="tabular hidden px-3 py-4 md:table-cell">{c.sent}</td>
                <td className="tabular px-3 py-4 font-semibold text-success">{c.acceptedPct}%</td>
                <td className="tabular hidden px-3 py-4 sm:table-cell">{c.repliedPct}%</td>
                <td className="hidden px-3 py-4 lg:table-cell">
                  {c.trend.some((v) => v > 0) ? (
                    <div className="h-8 w-24">
                      <ResponsiveContainer>
                        <LineChart data={c.trend.map((v) => ({ v }))}>
                          <Line dataKey="v" stroke="#0369a1" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <span className="text-xs text-sub">—</span>
                  )}
                </td>
                <td className="px-3 py-4 text-right">
                  <button
                    aria-label={c.status === "Active" ? "Pause campaign" : "Resume campaign"}
                    className="rounded-md p-2 text-sub hover:bg-mutedbg hover:text-fg"
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePause(c)
                    }}
                  >
                    {c.status === "Active" ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </Card>
    </div>
  )
}

/* ---------- detail ---------- */

const ENROLLMENT_TONE: Record<string, "success" | "accent" | "warn" | "sub" | "danger"> = {
  finished: "success",
  replied: "success",
  active: "accent",
  waiting: "warn",
  paused: "sub",
  stopped: "sub",
  failed: "danger",
}

const stepLabel = (s: { kind: string; action: string | null; condition: string | null }): string => {
  if (s.kind === "condition") return `If ${(s.condition || "").replace(/^if_/, "").replace(/_/g, " ")}`
  const map: Record<string, string> = {
    connect_request: "Send connection request",
    linkedin_message: "LinkedIn message",
    send_email: "Send email",
    visit_profile: "View profile",
    follow: "Follow",
    inmail: "InMail",
  }
  return map[s.action || ""] || s.action || "Step"
}

export function CampaignDetail({
  campaign,
  onBack,
  onEdit,
}: {
  campaign: Campaign
  onBack: () => void
  onEdit: (data: CampaignDetailData) => void
}) {
  const toast = useToast()
  const [data, setData] = useState<CampaignDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  // Add-leads modal
  const [addOpen, setAddOpen] = useState(false)
  const [allLeads, setAllLeads] = useState<LeadRow[]>([])
  const [addLoading, setAddLoading] = useState(false)
  const [addQ, setAddQ] = useState("")
  const [addSel, setAddSel] = useState<Set<string>>(new Set())
  const [addBusy, setAddBusy] = useState(false)

  const load = () => {
    setLoading(true)
    api
      .getCampaign(campaign.id)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }
  useEffect(load, [campaign.id])

  const remove = async () => {
    if (!confirm(`Delete "${data?.name ?? campaign.name}"? This removes the campaign and its enrolled leads' progress.`)) return
    setDeleting(true)
    try {
      await api.deleteCampaign(campaign.id)
      toast("Campaign deleted")
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete the campaign")
      setDeleting(false)
    }
  }

  const enrollmentAction = async (enrollmentId: string, action: "pause" | "resume" | "remove") => {
    setRowBusy(enrollmentId)
    try {
      if (action === "remove") await api.removeEnrollment(campaign.id, enrollmentId)
      else await api.setEnrollment(campaign.id, enrollmentId, action)
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update the lead")
    } finally {
      setRowBusy(null)
    }
  }

  const openAddLeads = () => {
    setAddOpen(true)
    setAddSel(new Set())
    setAddLoading(true)
    api
      .getLeads({ limit: 500 })
      .then(setAllLeads)
      .catch(() => setAllLeads([]))
      .finally(() => setAddLoading(false))
  }

  const submitAddLeads = async () => {
    if (addSel.size === 0) return
    setAddBusy(true)
    try {
      const res = await api.enrollLeads(campaign.id, [...addSel])
      toast(`${res.enrolled} lead(s) added`)
      setAddOpen(false)
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add leads")
    } finally {
      setAddBusy(false)
    }
  }

  const enrolledIds = useMemo(() => new Set((data?.enrollments ?? []).map((e) => e.leadId)), [data])
  const addFiltered = useMemo(() => {
    const s = addQ.trim().toLowerCase()
    return allLeads.filter(
      (l) =>
        !enrolledIds.has(l.id) &&
        (!s || [l.name, l.company, l.title].filter(Boolean).some((v) => v.toLowerCase().includes(s))),
    )
  }, [allLeads, addQ, enrolledIds])

  const setStatus = async (status: "Active" | "Paused") => {
    setBusy(true)
    try {
      await api.updateCampaign(campaign.id, { status })
      toast(`Campaign ${status.toLowerCase()}`)
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update campaign")
    } finally {
      setBusy(false)
    }
  }

  const c = data
  const sent = c?.sent ?? 0
  const funnel = [
    { label: "Sent", v: sent, pct: 100 },
    { label: "Accepted", v: Math.round((sent * (c?.acceptedPct ?? 0)) / 100), pct: c?.acceptedPct ?? 0 },
    { label: "Replied", v: Math.round((sent * (c?.repliedPct ?? 0)) / 100), pct: c?.repliedPct ?? 0 },
  ]

  return (
    <div className="flex flex-col gap-6">
      <button onClick={onBack} className="flex w-fit items-center gap-1 text-sm font-semibold text-sub hover:text-fg">
        <ArrowLeft size={15} /> All campaigns
      </button>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{c?.name ?? campaign.name}</h1>
        <Badge tone={(c?.status ?? campaign.status) === "Active" ? "success" : "warn"}>
          {c?.status ?? campaign.status}
        </Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          {(c?.status ?? campaign.status) === "Active" ? (
            <Button variant="outline" className="text-xs" disabled={busy} onClick={() => setStatus("Paused")}>
              <Pause size={14} /> Pause
            </Button>
          ) : (
            <Button variant="outline" className="text-xs" disabled={busy} onClick={() => setStatus("Active")}>
              <Play size={14} /> {(c?.status ?? campaign.status) === "Draft" ? "Launch" : "Resume"}
            </Button>
          )}
          <Button variant="outline" className="text-xs" disabled={!c} onClick={() => c && onEdit(c)}>
            <Pencil size={14} /> Edit
          </Button>
          <Button
            variant="outline"
            className="text-xs text-danger hover:bg-danger/10"
            disabled={deleting}
            onClick={remove}
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-accent" />
        </div>
      ) : !c ? (
        <p className="py-8 text-center text-sm text-sub">Couldn't load this campaign.</p>
      ) : (
        <>
          {/* stat tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Leads", c.leads],
              ["Sent", c.sent],
              ["Accepted", `${c.acceptedPct}%`],
              ["Replied", `${c.repliedPct}%`],
            ].map(([k, v]) => (
              <Card key={k as string} className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-sub">{k}</p>
                <p className="tabular mt-1 text-2xl font-bold">{v}</p>
              </Card>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="mb-4 font-bold">Funnel</h2>
              <div className="flex flex-col gap-3">
                {funnel.map((f) => (
                  <div key={f.label} className="flex items-center gap-3">
                    <span className="w-20 text-sm font-semibold">{f.label}</span>
                    <div className="h-6 flex-1 overflow-hidden rounded bg-mutedbg">
                      <div
                        className="flex h-6 items-center rounded bg-accent pl-2 text-xs font-bold text-white transition-all duration-500"
                        style={{ width: `${Math.max(f.pct, 8)}%` }}
                      >
                        {f.v}
                      </div>
                    </div>
                    <span className="tabular w-12 text-right text-sm text-sub">{f.pct}%</span>
                  </div>
                ))}
              </div>
              {c.trend.some((v) => v > 0) && (
                <div className="mt-5 h-16">
                  <ResponsiveContainer>
                    <LineChart data={c.trend.map((v) => ({ v }))}>
                      <Line dataKey="v" stroke="#0369a1" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            {/* sequence */}
            <Card className="p-5">
              <h2 className="mb-4 font-bold">Sequence · {c.steps.length} steps</h2>
              {c.steps.length === 0 ? (
                <p className="text-sm text-sub">No steps defined.</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {c.steps.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-3 text-sm">
                      <span className="tabular flex h-6 w-6 items-center justify-center rounded-full bg-mutedbg text-xs font-bold text-sub">
                        {i + 1}
                      </span>
                      <span className="font-semibold">{stepLabel(s)}</span>
                      {s.delayHours > 0 && (
                        <span className="tabular rounded bg-mutedbg px-2 py-0.5 text-xs text-sub">
                          after {s.delayHours >= 24 ? `${Math.round(s.delayHours / 24)}d` : `${s.delayHours}h`}
                        </span>
                      )}
                      {s.kind === "condition" && <Badge tone="warn">Conditional</Badge>}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          {/* enrolled leads */}
          <Card>
            <div className="flex items-center justify-between px-5 pt-5">
              <h2 className="font-bold">Leads · {c.enrollments.length}</h2>
              <Button variant="outline" className="text-xs" onClick={openAddLeads}>
                <Plus size={14} /> Add leads
              </Button>
            </div>
            {c.enrollments.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-sub">
                No leads enrolled yet — click “Add leads”.
              </p>
            ) : (
              <ul className="divide-y divide-line p-2">
                {c.enrollments.map((e) => {
                  const paused = e.enrollmentStatus === "paused"
                  const done = ["finished", "stopped", "failed"].includes(e.enrollmentStatus)
                  return (
                    <li key={e.enrollmentId} className="flex items-center gap-3 p-3">
                      <Avatar name={e.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{e.name}</p>
                        <p className="truncate text-xs text-sub">{[e.title, e.company].filter(Boolean).join(" · ")}</p>
                      </div>
                      <Badge tone={ENROLLMENT_TONE[e.enrollmentStatus] || "sub"}>{e.enrollmentStatus}</Badge>
                      <div className="flex items-center gap-0.5">
                        {rowBusy === e.enrollmentId ? (
                          <Loader2 size={15} className="animate-spin text-accent" />
                        ) : (
                          <>
                            {!done && (
                              <button
                                aria-label={paused ? "Resume lead" : "Pause lead"}
                                className="rounded-md p-1.5 text-sub hover:bg-mutedbg hover:text-fg"
                                onClick={() => enrollmentAction(e.enrollmentId, paused ? "resume" : "pause")}
                              >
                                {paused ? <Play size={14} /> : <Pause size={14} />}
                              </button>
                            )}
                            <button
                              aria-label="Remove lead"
                              className="rounded-md p-1.5 text-sub hover:bg-danger/10 hover:text-danger"
                              onClick={() => enrollmentAction(e.enrollmentId, "remove")}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          {addOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => !addBusy && setAddOpen(false)}
            >
              <div
                className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-line bg-card p-6 shadow-xl"
                onClick={(ev) => ev.stopPropagation()}
                role="dialog"
                aria-label="Add leads"
              >
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <p className="text-lg font-bold">Add leads</p>
                    <p className="text-xs text-sub">Enroll more leads into “{c.name}”.</p>
                  </div>
                  <button aria-label="Close" className="rounded-md p-1.5 text-sub hover:bg-mutedbg" onClick={() => !addBusy && setAddOpen(false)}>
                    <X size={18} />
                  </button>
                </div>
                <div className="relative mb-3">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
                  <input
                    className={cx(inputCls, "pl-9")}
                    placeholder="Search leads"
                    value={addQ}
                    onChange={(ev) => setAddQ(ev.target.value)}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
                  {addLoading ? (
                    <div className="flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin text-accent" /></div>
                  ) : addFiltered.length === 0 ? (
                    <p className="py-8 text-center text-sm text-sub">No more leads to add.</p>
                  ) : (
                    <ul className="divide-y divide-line p-1.5">
                      {addFiltered.map((l) => (
                        <li key={l.id}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-mutedbg/50">
                            <input
                              type="checkbox"
                              className="accent-[#0369a1]"
                              checked={addSel.has(l.id)}
                              onChange={() =>
                                setAddSel((s) => {
                                  const n = new Set(s)
                                  n.has(l.id) ? n.delete(l.id) : n.add(l.id)
                                  return n
                                })
                              }
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{l.name}</p>
                              <p className="truncate text-xs text-sub">{[l.title, l.company].filter(Boolean).join(" · ")}</p>
                            </div>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-sm font-semibold text-sub">{addSel.size} selected</span>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setAddOpen(false)} disabled={addBusy}>Cancel</Button>
                    <Button onClick={submitAddLeads} disabled={addBusy || addSel.size === 0}>
                      {addBusy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ---------- builder ---------- */

type Node = CampaignBuilderNode & { uid: string }

let uidSeq = 0
const mk = (n: CampaignBuilderNode): Node => ({ ...n, uid: `n${++uidSeq}` })

const defaultNodes = (): Node[] => [
  mk({ kind: "view" }),
  mk({ kind: "invite", body: "Hi {{firstName}}, I came across your work at {{company}} and would love to connect." }),
  mk({ kind: "wait", days: 2 }),
  mk({ kind: "branch", condition: "if_connected", elseAction: { kind: "message", body: "" } }),
  mk({ kind: "message", body: "Thanks for connecting, {{firstName}}! Wanted to share something relevant to {{company}}." }),
]

const NODE_META: Record<
  Node["kind"],
  { icon: React.ReactNode; label: string; accent?: boolean }
> = {
  view: { icon: <Eye size={15} />, label: "View profile" },
  invite: { icon: <UserPlus size={15} />, label: "Send connection request", accent: true },
  wait: { icon: <Clock size={15} />, label: "Wait" },
  message: { icon: <MessageSquare size={15} />, label: "Follow-up message" },
  email: { icon: <Mail size={15} />, label: "Send email" },
  branch: { icon: <GitBranch size={15} />, label: "Condition" },
  follow: { icon: <UserPlus size={15} />, label: "Follow" },
}

const ADD_MENU: { kind: Node["kind"]; label: string }[] = [
  { kind: "invite", label: "Connection request" },
  { kind: "message", label: "LinkedIn message" },
  { kind: "email", label: "Email" },
  { kind: "wait", label: "Wait" },
  { kind: "branch", label: "Condition" },
  { kind: "view", label: "View profile" },
  { kind: "follow", label: "Follow" },
]

const CONDITIONS = [
  { value: "if_connected", label: "Connection accepted" },
  { value: "if_replied", label: "Lead replied" },
  { value: "if_has_email", label: "Lead has an email" },
]

const builderSteps = ["Audience", "Sequence", "Schedule", "Review"]

export function CampaignBuilder({
  onDone,
  edit,
}: {
  onDone: () => void
  edit?: { id: string; name: string; dailyCap: number; nodes: CampaignBuilderNode[] }
}) {
  const toast = useToast()
  const isEdit = !!edit
  const [step, setStep] = useState(edit ? 1 : 0)
  const [name, setName] = useState(edit?.name ?? "")
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [leadsLoading, setLeadsLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [q, setQ] = useState("")
  const [nodes, setNodes] = useState<Node[]>(edit ? edit.nodes.map(mk) : defaultNodes())
  const [account, setAccount] = useState<LinkedInAccountState | null>(null)
  const [previewIdx, setPreviewIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const [addOpen, setAddOpen] = useState(false)

  const cap = account?.warmup?.todayLimit ?? 15

  useEffect(() => {
    let alive = true
    api.linkedinAccount().then((a) => alive && setAccount(a)).catch(() => {})
    api
      .getLeads({ limit: 500 })
      .then((l) => alive && setLeads(l))
      .catch(() => alive && setLeads([]))
      .finally(() => alive && setLeadsLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const filteredLeads = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return leads
    return leads.filter((l) =>
      [l.name, l.company, l.title].filter(Boolean).some((v) => v.toLowerCase().includes(s)),
    )
  }, [leads, q])

  const selectedLeads = useMemo(() => leads.filter((l) => selected.has(l.id)), [leads, selected])

  // The invite message drives the length check + live preview.
  const inviteNode = nodes.find((n) => n.kind === "invite")
  const inviteBody = inviteNode?.body || ""
  const worst = useMemo(() => longestRender(inviteBody, selectedLeads), [inviteBody, selectedLeads])
  const over = worst.len > 300
  const previewLead = selectedLeads[previewIdx] || selectedLeads[0]

  const outboundCount = nodes.filter((n) => ["invite", "message", "email", "follow", "view"].includes(n.kind)).length

  /* node ops */
  const patchNode = (uid: string, patch: Partial<Node>) =>
    setNodes((ns) => ns.map((n) => (n.uid === uid ? { ...n, ...patch } : n)))
  const removeNode = (uid: string) => setNodes((ns) => ns.filter((n) => n.uid !== uid))
  const moveNode = (uid: string, dir: -1 | 1) =>
    setNodes((ns) => {
      const i = ns.findIndex((n) => n.uid === uid)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ns.length) return ns
      const copy = [...ns]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
  const addNode = (kind: Node["kind"]) => {
    const seed: CampaignBuilderNode =
      kind === "wait"
        ? { kind, days: 2 }
        : kind === "branch"
          ? { kind, condition: "if_connected", elseAction: { kind: "message", body: "" } }
          : kind === "email"
            ? { kind, subject: "", body: "" }
            : { kind, body: "" }
    setNodes((ns) => [...ns, mk(seed)])
    setAddOpen(false)
  }

  const toggleLead = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const selectAllFiltered = () => setSelected(new Set(filteredLeads.map((l) => l.id)))

  const launch = async (doLaunch: boolean) => {
    if (!name.trim()) {
      toast("Name your campaign.")
      setStep(3)
      return
    }
    if (selected.size === 0) {
      toast("Select at least one lead.")
      setStep(0)
      return
    }
    if (outboundCount === 0) {
      toast("Add at least one action step (connect, message or email).")
      setStep(1)
      return
    }
    if (over) {
      toast("Shorten the connection message — a lead's render exceeds 300 chars.")
      setStep(1)
      return
    }
    setSaving(true)
    try {
      const steps: CampaignBuilderNode[] = nodes.map(({ uid: _uid, ...n }) => n)
      await api.createCampaign({
        name: name.trim(),
        dailyCap: cap,
        steps,
        leadIds: [...selected],
        launch: doLaunch,
      })
      toast(doLaunch ? `Campaign "${name.trim()}" launched` : `Draft "${name.trim()}" saved`)
      onDone()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the campaign")
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async () => {
    if (!name.trim()) {
      toast("Name your campaign.")
      setStep(3)
      return
    }
    if (outboundCount === 0) {
      toast("Add at least one action step (connect, message or email).")
      setStep(1)
      return
    }
    if (over) {
      toast("Shorten the connection message — a lead's render exceeds 300 chars.")
      setStep(1)
      return
    }
    setSaving(true)
    try {
      const steps: CampaignBuilderNode[] = nodes.map(({ uid: _uid, ...n }) => n)
      await api.updateCampaign(edit!.id, { name: name.trim(), dailyCap: cap, steps })
      toast("Campaign updated")
      onDone()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update the campaign")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{isEdit ? "Edit campaign" : "New campaign"}</h1>
          <p className="text-sm text-sub">{name.trim() || "Name your campaign in Review"}</p>
        </div>
        <nav aria-label="Builder steps" className="hidden items-center gap-1 md:flex">
          {builderSteps.map((s, i) => (
            <button
              key={s}
              onClick={() => setStep(i)}
              className={cx(
                "rounded-full px-3 py-1.5 text-sm font-semibold transition-colors",
                i === step ? "bg-navy text-white dark:bg-accent" : "text-sub hover:bg-mutedbg",
              )}
            >
              {i + 1}. {s}
            </button>
          ))}
        </nav>
      </div>

      {/* Step 0 — Audience */}
      {step === 0 && (
        <div className="flex max-w-2xl flex-col gap-4">
          {isEdit && (
            <div className="rounded-md border border-line bg-mutedbg/40 px-4 py-3 text-sm text-sub">
              You're editing this campaign's <strong>sequence &amp; settings</strong>. Leads are added or
              removed from the campaign page. Saving a sequence change restarts enrolled leads from step 1.
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
              <input
                className={cx(inputCls, "pl-9")}
                placeholder="Search your leads by name, company, title"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Button variant="outline" className="text-xs" onClick={selectAllFiltered}>
              Select all{q ? " matching" : ""}
            </Button>
          </div>
          <p className="text-sm font-semibold text-sub">
            {selected.size} selected · {filteredLeads.length} shown
          </p>
          <Card className="max-h-[26rem] overflow-y-auto">
            {leadsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-accent" />
              </div>
            ) : filteredLeads.length === 0 ? (
              <p className="py-8 text-center text-sm text-sub">No leads — scrape or import some first.</p>
            ) : (
              <ul className="divide-y divide-line p-2">
                {filteredLeads.map((l) => (
                  <li key={l.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-mutedbg/50">
                      <input
                        type="checkbox"
                        className="accent-[#0369a1]"
                        checked={selected.has(l.id)}
                        onChange={() => toggleLead(l.id)}
                      />
                      <Avatar name={l.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{l.name}</p>
                        <p className="truncate text-xs text-sub">
                          {[l.title, l.company, l.location].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Button className="w-fit" disabled={selected.size === 0} onClick={() => setStep(1)}>
            Continue to sequence <ArrowRight size={16} />
          </Button>
        </div>
      )}

      {/* Step 1 — Sequence */}
      {step === 1 && (
        <div className="grid gap-6 xl:grid-cols-5">
          <div className="flex flex-col gap-3 xl:col-span-3">
            {nodes.map((n, i) => (
              <div key={n.uid} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cx(
                      "flex h-8 w-8 items-center justify-center rounded-full",
                      NODE_META[n.kind].accent ? "bg-accent text-white" : "bg-mutedbg text-sub",
                    )}
                  >
                    {NODE_META[n.kind].icon}
                  </span>
                  {i < nodes.length - 1 && <span className="w-px flex-1 bg-line" />}
                </div>
                <Card className={cx("mb-1 flex-1 p-4", NODE_META[n.kind].accent && "border-accent")}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold">{NODE_META[n.kind].label}</p>
                    <div className="flex items-center gap-0.5">
                      <button
                        aria-label="Move up"
                        disabled={i === 0}
                        className="rounded p-1 text-sub hover:bg-mutedbg disabled:opacity-30"
                        onClick={() => moveNode(n.uid, -1)}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        aria-label="Move down"
                        disabled={i === nodes.length - 1}
                        className="rounded p-1 text-sub hover:bg-mutedbg disabled:opacity-30"
                        onClick={() => moveNode(n.uid, 1)}
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        aria-label="Remove step"
                        className="rounded p-1 text-sub hover:bg-danger/10 hover:text-danger"
                        onClick={() => removeNode(n.uid)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* per-kind editor */}
                  {n.kind === "wait" && (
                    <div className="mt-3 flex items-center gap-2 text-sm">
                      Wait
                      <input
                        type="number"
                        min={0}
                        className={cx(inputCls, "w-20")}
                        value={n.days ?? 0}
                        onChange={(e) => patchNode(n.uid, { days: Math.max(0, Number(e.target.value)) })}
                      />
                      days
                    </div>
                  )}

                  {(n.kind === "invite" || n.kind === "message") && (
                    <MessageEditor
                      value={n.body || ""}
                      onChange={(v) => patchNode(n.uid, { body: v })}
                      showLimit={n.kind === "invite"}
                      worstLen={n.kind === "invite" ? worst.len : undefined}
                    />
                  )}

                  {n.kind === "email" && (
                    <div className="mt-3 flex flex-col gap-2">
                      <input
                        className={inputCls}
                        placeholder="Subject"
                        value={n.subject || ""}
                        onChange={(e) => patchNode(n.uid, { subject: e.target.value })}
                      />
                      <MessageEditor value={n.body || ""} onChange={(v) => patchNode(n.uid, { body: v })} />
                    </div>
                  )}

                  {n.kind === "branch" && (
                    <div className="mt-3 flex flex-col gap-3">
                      <Field label="Continue only if">
                        <select
                          className={inputCls}
                          value={n.condition || "if_connected"}
                          onChange={(e) => patchNode(n.uid, { condition: e.target.value })}
                        >
                          {CONDITIONS.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="accent-[#0369a1]"
                          checked={!!n.elseAction}
                          onChange={(e) =>
                            patchNode(n.uid, {
                              elseAction: e.target.checked ? { kind: "email", body: "" } : undefined,
                            })
                          }
                        />
                        Otherwise, send a fallback
                      </label>
                      {n.elseAction && (
                        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
                          <select
                            className={inputCls}
                            value={n.elseAction.kind}
                            onChange={(e) =>
                              patchNode(n.uid, {
                                elseAction: { ...n.elseAction!, kind: e.target.value as "email" | "message" },
                              })
                            }
                          >
                            <option value="email">Email</option>
                            <option value="message">LinkedIn message</option>
                          </select>
                          {n.elseAction.kind === "email" && (
                            <input
                              className={inputCls}
                              placeholder="Subject"
                              value={n.elseAction.subject || ""}
                              onChange={(e) =>
                                patchNode(n.uid, {
                                  elseAction: { ...n.elseAction!, subject: e.target.value },
                                })
                              }
                            />
                          )}
                          <textarea
                            rows={3}
                            className={cx(inputCls, "resize-none")}
                            placeholder="Fallback message"
                            value={n.elseAction.body || ""}
                            onChange={(e) =>
                              patchNode(n.uid, {
                                elseAction: { ...n.elseAction!, body: e.target.value },
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </div>
            ))}

            <div className="relative w-fit" ref={addMenuRef}>
              <Button variant="outline" onClick={() => setAddOpen((o) => !o)}>
                <Plus size={15} /> Add step
              </Button>
              {addOpen && (
                <div className="absolute z-10 mt-1 w-56 rounded-lg border border-line bg-bg p-1 shadow-lg">
                  {ADD_MENU.map((m) => (
                    <button
                      key={m.kind}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-mutedbg"
                      onClick={() => addNode(m.kind)}
                    >
                      {NODE_META[m.kind].icon} {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* live preview */}
          <div className="xl:col-span-2">
            <Card className="sticky top-4 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-bold">Live preview</h2>
                {selectedLeads.length > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      aria-label="Previous lead"
                      className="rounded-md p-1.5 text-sub hover:bg-mutedbg"
                      onClick={() => setPreviewIdx((previewIdx - 1 + selectedLeads.length) % selectedLeads.length)}
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <span className="tabular text-xs font-semibold text-sub">
                      {previewIdx + 1}/{selectedLeads.length}
                    </span>
                    <button
                      aria-label="Next lead"
                      className="rounded-md p-1.5 text-sub hover:bg-mutedbg"
                      onClick={() => setPreviewIdx((previewIdx + 1) % selectedLeads.length)}
                    >
                      <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-line bg-bg p-4">
                {!previewLead ? (
                  <p className="py-8 text-center text-sm text-sub">Select leads to preview the message.</p>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <Avatar name={previewLead.name} size={44} />
                      <div>
                        <p className="font-bold">{previewLead.name}</p>
                        <p className="text-xs text-sub">
                          {[previewLead.title, previewLead.company].filter(Boolean).join(" at ")}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 rounded-md bg-mutedbg p-3 text-sm leading-relaxed">
                      {renderTemplate(inviteBody, previewLead)}
                    </div>
                  </>
                )}
              </div>
              <p className="mt-3 text-xs text-sub">
                {outboundCount} action step(s) · {selected.size} lead(s). Sends are paced by your daily limit.
              </p>
            </Card>
          </div>
        </div>
      )}

      {/* Step 2 — Schedule */}
      {step === 2 && (
        <div className="flex max-w-xl flex-col gap-5">
          <Field label={`Daily send cap — ${cap}/day`}>
            <div className={cx(inputCls, "flex w-32 items-center justify-center bg-mutedbg font-semibold")}>
              {cap}/day
            </div>
            <span className="mt-1 block text-xs text-sub">
              {account?.warmup
                ? `Today's enforced limit (ramping to ${account.warmup.target}/day). Change it in Settings → LinkedIn limits.`
                : "Connect a LinkedIn account to see your enforced limit — it's managed in Settings → LinkedIn limits."}
            </span>
          </Field>
          <div className="rounded-md border border-line bg-mutedbg/40 px-4 py-3 text-sm text-sub">
            Working hours, weekends and timezone are enforced globally by the pacing engine
            (Settings → LinkedIn limits) so every campaign respects the same safe schedule.
          </div>
          <Button className="w-fit" onClick={() => setStep(3)}>
            Review <ArrowRight size={16} />
          </Button>
        </div>
      )}

      {/* Step 3 — Review */}
      {step === 3 && (
        <div className="flex max-w-xl flex-col gap-4">
          <Field label="Campaign name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. SaaS founders — Q3"
              aria-label="Campaign name"
            />
          </Field>
          <Card className="divide-y divide-line">
            {[
              ["Audience", `${selected.size} lead${selected.size === 1 ? "" : "s"}`],
              ["Sequence", `${nodes.length} steps`],
              ["Daily cap", `${cap} sends/day`],
              ["Estimated duration", selected.size > 0 ? `~${Math.max(1, Math.ceil(selected.size / cap))} day(s)` : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between p-4 text-sm">
                <span className="font-semibold text-sub">{k}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
          </Card>
          {over && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
              Fix before launch: a lead's rendered connection message exceeds 300 characters.
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            {isEdit ? (
              <Button disabled={saving || !name.trim() || over} onClick={saveEdit}>
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            ) : (
              <>
                <Button disabled={saving || !name.trim() || selected.size === 0 || over} onClick={() => launch(true)}>
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
                  {saving ? "Launching…" : "Launch campaign"}
                </Button>
                <Button variant="outline" disabled={saving || !name.trim()} onClick={() => launch(false)}>
                  Save as draft
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {step > 0 && (
        <button
          onClick={() => setStep(step - 1)}
          className="flex w-fit items-center gap-1 text-sm font-semibold text-sub hover:text-fg"
        >
          <ArrowLeft size={15} /> Back
        </button>
      )}
    </div>
  )
}

/* ---------- shared message editor with variable chips ---------- */

function MessageEditor({
  value,
  onChange,
  showLimit,
  worstLen,
}: {
  value: string
  onChange: (v: string) => void
  showLimit?: boolean
  worstLen?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const insertVar = (token: string) => {
    const el = ref.current
    if (!el) return onChange(value + token)
    const s = el.selectionStart ?? value.length
    onChange(value.slice(0, s) + token + value.slice(el.selectionEnd ?? s))
    el.focus()
  }
  const over = (worstLen ?? 0) > 300
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {["{{firstName}}", "{{company}}", "{{title}}", "{{location}}"].map((v) => (
          <button
            key={v}
            onClick={() => insertVar(v)}
            className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/20"
          >
            {v}
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        rows={4}
        className={cx(inputCls, "resize-none font-[inherit]")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Message template"
      />
      {showLimit && (
        <p
          className={cx("tabular mt-1 text-xs font-semibold", over ? "text-danger" : "text-sub")}
          role={over ? "alert" : undefined}
        >
          {worstLen ? `Longest render: ${worstLen}/300` : `${value.length}/300 characters`}
          {over && " — shorten to launch"}
        </p>
      )}
      <p className="mt-1 text-xs text-sub">
        <code className="rounded bg-mutedbg px-1">{"{{firstName|there}}"}</code> fallback ·{" "}
        <code className="rounded bg-mutedbg px-1">{"{Hi|Hey}"}</code> picks one per recipient.
      </p>
    </div>
  )
}
