import { useEffect, useState } from "react"
import { BadgeCheck, Download, Loader2, Search, Tag, Users, X } from "lucide-react"
import { api } from "@/lib/api"
import type { LeadRow } from "@/types"
import { Avatar, Badge, Button, Card, EmptyState } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"

export function Leads() {
  const toast = useToast()
  const [q, setQ] = useState("")
  const [sel, setSel] = useState<string[]>([])
  const [open, setOpen] = useState<LeadRow | null>(null)
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .getLeads()
      .then((rows) => alive && setLeads(rows))
      .catch(() => alive && setLeads([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const visible = leads.filter(
    (l) =>
      (l.name || "").toLowerCase().includes(q.toLowerCase()) ||
      (l.company || "").toLowerCase().includes(q.toLowerCase()),
  )
  const toggle = (id: string) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-sub">Everyone you're reaching out to, in one table.</p>
        </div>
        <div className="relative w-full sm:w-auto">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
          <input
            className={cx(inputCls, "w-full pl-9 sm:w-64")}
            placeholder="Search name or company"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search leads"
          />
        </div>
      </div>

      {sel.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-accent bg-accent/5 px-4 py-2.5">
          <span className="tabular text-sm font-bold">{sel.length} selected</span>
          <Button variant="outline" className="px-3 py-1.5 text-xs" onClick={() => toast(`${sel.length} lead(s) added to campaign`)}>
            <Users size={13} /> Add to campaign
          </Button>
          <Button variant="outline" className="px-3 py-1.5 text-xs" onClick={() => toast("Tag applied")}>
            <Tag size={13} /> Tag
          </Button>
          <Button variant="outline" className="px-3 py-1.5 text-xs" onClick={() => toast("CSV exported")}>
            <Download size={13} /> Export CSV
          </Button>
          <button className="ml-auto text-sub hover:text-fg" aria-label="Clear selection" onClick={() => setSel([])}>
            <X size={16} />
          </button>
        </Card>
      )}

      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-accent" />
          </div>
        ) : leads.length === 0 ? (
          <EmptyState
            icon={<Users size={28} />}
            title="No leads yet"
            hint="Upload profiles in Auto Connect or import a list — they'll show up here."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Search size={28} />}
            title={`No results for "${q}"`}
            hint="Try a different name or company, or clear the search."
            action={<Button variant="outline" onClick={() => setQ("")}>Clear search</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-sub">
                <th className="w-10 px-4 py-3"><span className="sr-only">Select</span></th>
                <th className="px-2 py-3">Lead</th>
                <th className="hidden px-3 py-3 md:table-cell">Company</th>
                <th className="hidden px-3 py-3 lg:table-cell">Email</th>
                <th className="px-3 py-3">Status</th>
                <th className="hidden px-3 py-3 xl:table-cell">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => (
                <tr
                  key={l.id}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-mutedbg/50"
                  onClick={() => setOpen(l)}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={sel.includes(l.id)}
                      onChange={() => toggle(l.id)}
                      aria-label={`Select ${l.name}`}
                      className="accent-[#0369a1]"
                    />
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={l.name} size={32} />
                      <div>
                        <p className="font-semibold">{l.name}</p>
                        <p className="text-xs text-sub">{l.title}</p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-3 md:table-cell">{l.company}</td>
                  <td className="hidden px-3 py-3 lg:table-cell">
                    <span className="flex items-center gap-1.5">
                      {l.email}
                      {l.emailVerified && <BadgeCheck size={14} className="text-success" aria-label="Verified" />}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={l.status === "Replied" ? "success" : l.status === "Accepted" ? "accent" : "sub"}>
                      {l.status}
                    </Badge>
                  </td>
                  <td className="hidden px-3 py-3 text-sub xl:table-cell">{l.lastActivity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

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
                      <Badge key={t} tone="accent">{t}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
