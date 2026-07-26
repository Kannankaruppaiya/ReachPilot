import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  GitBranch,
  Loader2,
  Mail,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Rocket,
  UserPlus,
} from "lucide-react"
import { Line, LineChart, ResponsiveContainer } from "recharts"
import { longestRender, renderTemplate } from "@/lib/utils/template"
import { api } from "@/lib/api"
import type { CampaignRow, LeadRow, LinkedInAccountState, TemplateRow } from "@/types"
import { Avatar, Badge, Button, Card, Dot, EmptyState, Field, LinkedinIcon } from "@/components/ui"
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
                  {c.trend.length > 0 ? (
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

export function CampaignDetail({ campaign, onBack }: { campaign: Campaign; onBack: () => void }) {
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [loadingLeads, setLoadingLeads] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .getLeads()
      .then((rows) => alive && setLeads(rows))
      .catch(() => alive && setLeads([]))
      .finally(() => alive && setLoadingLeads(false))
    return () => {
      alive = false
    }
  }, [])

  const funnel = [
    { label: "Sent", v: campaign.sent, pct: 100 },
    { label: "Accepted", v: Math.round((campaign.sent * campaign.acceptedPct) / 100), pct: campaign.acceptedPct },
    { label: "Replied", v: Math.round((campaign.sent * campaign.repliedPct) / 100), pct: campaign.repliedPct },
  ]
  return (
    <div className="flex flex-col gap-6">
      <button onClick={onBack} className="flex w-fit items-center gap-1 text-sm font-semibold text-sub hover:text-fg">
        <ArrowLeft size={15} /> All campaigns
      </button>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{campaign.name}</h1>
        <Badge tone={campaign.status === "Active" ? "success" : "warn"}>{campaign.status}</Badge>
      </div>
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
      </Card>
      <Card>
        <h2 className="px-5 pt-5 font-bold">Leads</h2>
        {loadingLeads ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={20} className="animate-spin text-accent" />
          </div>
        ) : leads.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-sub">No leads yet.</p>
        ) : (
          <ul className="divide-y divide-line p-2">
            {leads.map((l) => (
              <li key={l.id} className="flex items-center gap-3 p-3">
                <Avatar name={l.name} />
                <div className="flex-1">
                  <p className="text-sm font-semibold">{l.name}</p>
                  <p className="text-xs text-sub">{[l.title, l.company].filter(Boolean).join(" · ")}</p>
                </div>
                <Badge tone={l.status === "Replied" ? "success" : l.status === "Accepted" ? "accent" : "sub"}>
                  {l.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* ---------- builder ---------- */

type Node = {
  id: string
  kind: "view" | "invite" | "wait" | "message" | "branch" | "email"
  label: string
  days?: number
}

const initialNodes: Node[] = [
  { id: "n1", kind: "view", label: "View profile" },
  { id: "n2", kind: "invite", label: "Send connection request" },
  { id: "n3", kind: "wait", label: "Wait", days: 2 },
  { id: "n4", kind: "message", label: "Follow-up message" },
  { id: "n5", kind: "branch", label: "If not accepted in 7 days → switch to email" },
  { id: "n6", kind: "email", label: "Email 1 — intro" },
]

const nodeIcon: Record<Node["kind"], React.ReactNode> = {
  view: <Eye size={15} />,
  invite: <UserPlus size={15} />,
  wait: <Clock size={15} />,
  message: <MessageSquare size={15} />,
  branch: <GitBranch size={15} />,
  email: <Mail size={15} />,
}

const builderSteps = ["Audience", "Sequence", "Schedule", "Review"]

export function CampaignBuilder({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [tplId, setTplId] = useState("")
  const [body, setBody] = useState("")
  const [previewIdx, setPreviewIdx] = useState(0)
  const [account, setAccount] = useState<LinkedInAccountState | null>(null)
  const [saving, setSaving] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // The daily cap is NOT set per campaign — it comes from the one place limits
  // live (Settings → LinkedIn limits) and the pacing engine enforces it.
  const cap = account?.warmup?.todayLimit ?? 15

  // Real templates + leads for this workspace.
  useEffect(() => {
    let alive = true
    api.linkedinAccount().then((a) => alive && setAccount(a)).catch(() => {})
    Promise.all([api.getTemplates().catch(() => []), api.getLeads().catch(() => [])]).then(([t, l]) => {
      if (!alive) return
      setTemplates(t)
      setLeads(l)
      if (t.length > 0) {
        setTplId(t[0].id)
        setBody(t[0].body)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const worst = useMemo(() => longestRender(body, leads), [body, leads])
  const over = worst.len > 300
  const lead = leads[previewIdx]

  const insertVar = (token: string) => {
    const el = areaRef.current
    if (!el) return setBody(body + token)
    const s = el.selectionStart ?? body.length
    setBody(body.slice(0, s) + token + body.slice(el.selectionEnd ?? s))
    el.focus()
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">New campaign</h1>
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

      {step === 0 && (
        <div className="flex max-w-2xl flex-col gap-5">
          <Field label="Audience source" hint="Paste a LinkedIn or Sales Navigator people-search URL.">
            <input className={inputCls} defaultValue="https://www.linkedin.com/search/results/people/?keywords=saas%20founder" />
          </Field>
          <Card>
            <p className="px-4 pt-4 text-sm font-semibold text-sub">Matched profiles · 2</p>
            <ul className="divide-y divide-line p-2">
              {leads.map((l) => (
                <li key={l.id} className="flex items-center gap-3 p-3">
                  <Avatar name={l.name} />
                  <div>
                    <p className="text-sm font-semibold">{l.name}</p>
                    <p className="text-xs text-sub">{l.title} · {l.company} · {l.location}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" defaultChecked className="accent-[#0369a1]" />
            Exclude 1st-degree connections and leads already in campaigns
          </label>
          <Button className="w-fit" onClick={() => setStep(1)}>
            Continue to sequence <ArrowRight size={16} />
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="grid gap-6 xl:grid-cols-5">
          {/* timeline + editor */}
          <div className="flex flex-col gap-3 xl:col-span-3">
            {initialNodes.map((n, i) => (
              <div key={n.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cx(
                      "flex h-8 w-8 items-center justify-center rounded-full",
                      n.kind === "invite" ? "bg-accent text-white" : "bg-mutedbg text-sub",
                    )}
                  >
                    {nodeIcon[n.kind]}
                  </span>
                  {i < initialNodes.length - 1 && <span className="w-px flex-1 bg-line" />}
                </div>
                <Card className={cx("mb-1 flex-1 p-4", n.kind === "invite" && "border-accent")}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold">{n.label}</p>
                    {n.kind === "wait" && (
                      <span className="tabular rounded bg-mutedbg px-2 py-0.5 text-xs font-semibold">
                        {n.days} days
                      </span>
                    )}
                    {n.kind === "branch" && <Badge tone="warn">Conditional</Badge>}
                  </div>

                  {n.kind === "invite" && (
                    <div className="mt-3 flex flex-col gap-3">
                      {templates.length > 0 ? (
                        <Field label="Template">
                          <select
                            className={inputCls}
                            value={tplId}
                            onChange={(e) => {
                              setTplId(e.target.value)
                              const t = templates.find((x) => x.id === e.target.value)
                              if (t) setBody(t.body)
                            }}
                          >
                            {templates.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name} · used {t.used}× · {t.acceptPct}% accepted
                              </option>
                            ))}
                          </select>
                        </Field>
                      ) : (
                        <p className="text-xs text-sub">No saved templates yet — write your message below.</p>
                      )}
                      <div>
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
                          ref={areaRef}
                          rows={4}
                          className={cx(inputCls, "resize-none font-[inherit]")}
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                          aria-label="Connection request message template"
                        />
                        <p
                          className={cx(
                            "tabular mt-1 text-xs font-semibold",
                            over ? "text-danger" : worst.len > 280 ? "text-warn" : "text-sub",
                          )}
                          role={over ? "alert" : undefined}
                        >
                          {worst.lead
                            ? `Longest render: ${worst.len}/300 (${worst.lead.name}, ${worst.lead.company})`
                            : `${body.length}/300 characters · add leads to preview the longest render`}
                          {over && " — shorten the template to launch"}
                        </p>
                        <p className="mt-1 text-xs text-sub">
                          Fallbacks: <code className="rounded bg-mutedbg px-1">{"{{firstName|there}}"}</code> is
                          used when a lead is missing a first name. Variation:{" "}
                          <code className="rounded bg-mutedbg px-1">{"{Hi|Hey|Hello}"}</code> picks one option
                          per recipient.
                        </p>
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            ))}
            <Button variant="outline" className="w-fit">
              <Plus size={15} /> Add step
            </Button>
          </div>

          {/* live preview */}
          <div className="xl:col-span-2">
            <Card className="sticky top-4 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-bold">
                  <LinkedinIcon size={16} className="text-accent" /> Live preview
                </h2>
                {leads.length > 0 && (
                  <div className="flex items-center gap-1">
                    <button
                      aria-label="Previous lead"
                      className="rounded-md p-1.5 text-sub hover:bg-mutedbg"
                      onClick={() => setPreviewIdx((previewIdx - 1 + leads.length) % leads.length)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="tabular text-xs font-semibold text-sub">
                      {previewIdx + 1}/{leads.length}
                    </span>
                    <button
                      aria-label="Next lead"
                      className="rounded-md p-1.5 text-sub hover:bg-mutedbg"
                      onClick={() => setPreviewIdx((previewIdx + 1) % leads.length)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-line bg-bg p-4">
                {!lead ? (
                  <p className="py-8 text-center text-sm text-sub">
                    No leads yet — import leads to preview your message.
                  </p>
                ) : (
                <>
                <div className="flex items-center gap-3">
                  <Avatar name={lead.name} size={44} />
                  <div>
                    <p className="font-bold">{lead.name}</p>
                    <p className="text-xs text-sub">{[lead.title, lead.company].filter(Boolean).join(" at ")}</p>
                  </div>
                </div>
                <div className="mt-3 rounded-md bg-mutedbg p-3 text-sm leading-relaxed">
                  {renderTemplate(body, lead)}
                </div>
                <div className="mt-3 flex gap-2">
                  <span className="rounded-full border border-accent px-4 py-1 text-xs font-bold text-accent">
                    Connect
                  </span>
                  <span className="rounded-full border border-line px-4 py-1 text-xs font-bold text-sub">
                    Ignore
                  </span>
                </div>
                </>
                )}
              </div>
              {lead && (
                <p className="mt-2 text-xs text-sub">
                  Previewing with real lead data — variables resolved for {lead.firstName}.
                </p>
              )}
            </Card>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex max-w-xl flex-col gap-5">
          <Field label={`Daily invite cap — ${cap}/day`}>
            <div className={cx(inputCls, "flex w-32 items-center justify-center bg-mutedbg font-semibold")}>
              {cap}/day
            </div>
            <span className="mt-1 block text-xs text-sub">
              {account?.warmup
                ? `Today's enforced limit (ramping to ${account.warmup.target}/day). Change it in Settings → LinkedIn limits.`
                : "Connect a LinkedIn account to see your enforced limit — it's managed in Settings → LinkedIn limits."}
            </span>
          </Field>
          <Field label="Working hours">
            <div className="flex items-center gap-2">
              <input className={inputCls} defaultValue="09:00" />
              <span className="text-sub">to</span>
              <input className={inputCls} defaultValue="18:00" />
            </div>
          </Field>
          <Button className="w-fit" onClick={() => setStep(3)}>
            Review <ArrowRight size={16} />
          </Button>
        </div>
      )}

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
              ["Audience", `${leads.length} lead${leads.length === 1 ? "" : "s"}`],
              ["Sequence", `${initialNodes.length} steps · LinkedIn → conditional email fallback`],
              ["Template", templates.find((t) => t.id === tplId)?.name || "Custom message"],
              ["Daily cap", `${cap} invites/day · 09:00–18:00`],
              [
                "Estimated duration",
                leads.length > 0 ? `~${Math.max(1, Math.ceil(leads.length / cap))} day(s)` : "—",
              ],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between p-4 text-sm">
                <span className="font-semibold text-sub">{k}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
          </Card>
          {over ? (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
              Fix before launch: a lead's rendered message exceeds 300 characters.
            </div>
          ) : (
            <Button
              className="w-fit"
              disabled={saving || !name.trim()}
              onClick={async () => {
                setSaving(true)
                try {
                  // Actually create the campaign instead of only showing a toast.
                  await api.createCampaign({ name: name.trim(), dailyCap: cap })
                  toast(`Campaign "${name.trim()}" created`)
                  onDone()
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Couldn't create the campaign")
                } finally {
                  setSaving(false)
                }
              }}
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
              {saving ? "Creating…" : "Create campaign"}
            </Button>
          )}
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
