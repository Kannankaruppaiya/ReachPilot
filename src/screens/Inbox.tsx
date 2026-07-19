import { useEffect, useState } from "react"
import { Inbox as InboxIcon, Mail, Send, Loader2 } from "lucide-react"
import { api, type InboxThread } from "../api"
import { Avatar, Badge, Button, Card, EmptyState, LinkedinIcon, cx, inputCls, useToast } from "../ui"

export function Inbox() {
  const toast = useToast()
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "linkedin" | "email">("all")
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  const load = async () => {
    try {
      const data = await api.getThreads()
      setThreads(data)
      setActiveId((cur) => (cur && data.some((t) => t.id === cur) ? cur : data[0]?.id ?? null))
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't load inbox")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const visible = threads.filter((t) => filter === "all" || t.channel === filter)
  const active = threads.find((t) => t.id === activeId)

  const send = async () => {
    if (!draft.trim() || !active || sending) return
    const text = draft
    setSending(true)
    setDraft("")
    try {
      const updated = await api.sendThreadMessage(active.id, text)
      setThreads((ts) =>
        ts.map((t) => (t.id === active.id ? { ...t, unread: false, messages: updated.messages } : t)),
      )
      toast(active.channel === "email" ? "Email sent" : "Message sent")
    } catch (e) {
      setDraft(text)
      toast(e instanceof Error ? e.message : "Send failed")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Inbox</h1>
        <p className="text-sm text-sub">LinkedIn and email conversations in one place.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        {/* thread list */}
        <Card className="lg:col-span-3">
          <div className="flex gap-1.5 border-b border-line p-3">
            {(["all", "linkedin", "email"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cx(
                  "rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors",
                  filter === f ? "bg-navy text-white dark:bg-accent" : "text-sub hover:bg-mutedbg",
                )}
              >
                {f}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-sub">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<InboxIcon size={28} />}
              title="No conversations"
              hint="Replies to your outreach will show up here."
            />
          ) : (
            <ul>
              {visible.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => {
                      setActiveId(t.id)
                      setThreads((ts) => ts.map((x) => (x.id === t.id ? { ...x, unread: false } : x)))
                    }}
                    className={cx(
                      "flex w-full items-start gap-3 border-b border-line p-3 text-left transition-colors last:border-0 hover:bg-mutedbg/60",
                      t.id === activeId && "bg-mutedbg/60",
                    )}
                  >
                    <Avatar name={t.leadName || "?"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={cx("truncate text-sm", t.unread ? "font-bold" : "font-semibold")}>
                          {t.leadName}
                        </span>
                        <span className="shrink-0 text-xs text-sub">{t.time}</span>
                      </div>
                      <p className="truncate text-xs text-sub">{t.preview}</p>
                      <span className="mt-1 inline-flex items-center gap-1 text-xs text-sub">
                        {t.channel === "linkedin" ? <LinkedinIcon size={11} /> : <Mail size={11} />}
                        {t.channel === "linkedin" ? "LinkedIn" : "Email"}
                        {t.unread && <span className="ml-1 h-2 w-2 rounded-full bg-accent" aria-label="Unread" />}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* thread view */}
        <Card className="flex min-h-[480px] flex-col lg:col-span-6">
          {active ? (
            <>
              <div className="flex items-center gap-3 border-b border-line p-4">
                <Avatar name={active.leadName || "?"} />
                <div>
                  <p className="font-bold">{active.leadName}</p>
                  <p className="text-xs text-sub">
                    {active.leadTitle}
                    {active.leadCompany ? ` · ${active.leadCompany}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                {active.messages.map((m, i) =>
                  m.channel === "email" ? (
                    <div key={i} className="rounded-lg border border-line p-3">
                      <p className="text-xs font-semibold text-sub">
                        Email · {m.time} {m.subject && <>· <span className="text-fg">{m.subject}</span></>}
                      </p>
                      <p className="mt-1 whitespace-pre-line text-sm">{m.text}</p>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={cx(
                        "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                        m.from === "me"
                          ? "self-end rounded-br-sm bg-accent text-white"
                          : "self-start rounded-bl-sm bg-mutedbg",
                      )}
                    >
                      {m.text}
                      <span className={cx("mt-1 block text-[11px]", m.from === "me" ? "text-white/70" : "text-sub")}>
                        {m.time}
                      </span>
                    </div>
                  ),
                )}
              </div>
              <div className="flex gap-2 border-t border-line p-3">
                <input
                  className={inputCls}
                  placeholder={`Reply to ${active.leadFirstName || active.leadName || ""}…`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  disabled={sending}
                  aria-label="Reply message"
                />
                <Button onClick={send} disabled={!draft.trim() || sending} aria-label="Send reply">
                  {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </Button>
              </div>
            </>
          ) : (
            <EmptyState icon={<InboxIcon size={28} />} title="Select a conversation" hint="Pick a thread from the list." />
          )}
        </Card>

        {/* context panel */}
        <Card className="hidden p-4 lg:col-span-3 lg:block">
          {active && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col items-center gap-2 pb-3 text-center">
                <Avatar name={active.leadName || "?"} size={56} />
                <div>
                  <p className="font-bold">{active.leadName}</p>
                  <p className="text-xs text-sub">{active.leadTitle}</p>
                  <p className="text-xs text-sub">
                    {active.leadCompany}
                    {active.leadLocation ? ` · ${active.leadLocation}` : ""}
                  </p>
                </div>
                {active.leadTags && active.leadTags.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {active.leadTags.map((t) => (
                      <Badge key={t} tone="accent">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              {active.campaign && (
                <div className="border-t border-line pt-3 text-sm">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Campaign</p>
                  <p className="font-semibold">{active.campaign}</p>
                </div>
              )}
              {active.leadStatus && (
                <div className="border-t border-line pt-3 text-sm">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Status</p>
                  <Badge tone={active.leadStatus === "replied" ? "success" : "sub"}>
                    {active.leadStatus}
                  </Badge>
                </div>
              )}
              {active.leadEmail && (
                <div className="border-t border-line pt-3 text-sm">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Email</p>
                  <p className="break-all font-semibold">{active.leadEmail}</p>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
