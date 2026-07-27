import { useEffect, useRef, useState } from "react"
import {
  Sparkles,
  Send,
  Loader2,
  Wrench,
  ChevronDown,
  ChevronRight,
  Plus,
  MessageSquare,
  Trash2,
  PanelLeftOpen,
  X,
} from "lucide-react"
import { cx } from "@/lib/utils/cx"
import { api, type AgentEvent, type ConversationSummary } from "@/lib/api"

/** A tool call + its result, shown as a collapsible card under the turn. */
interface ToolTrace {
  name: string
  args: unknown
  ok?: boolean
  result?: unknown
}

interface Turn {
  role: "user" | "assistant"
  content: string
  tools?: ToolTrace[]
  pending?: boolean
}

const SUGGESTIONS = [
  { title: "Scrape leads with Apify", body: "Use Apify to find SaaS founders in Chennai and list their companies" },
  { title: "Review my pipeline", body: "How many leads do I have and what's their status?" },
  { title: "Check account health", body: "What's my LinkedIn account warm-up status?" },
  { title: "Summarize a website", body: "Browse a company's site and summarize what they do" },
]

/** "2m", "5h", "3d", or a date — compact relative time for the history list. */
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function Assistant() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [drawer, setDrawer] = useState(false) // mobile history drawer
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    api.aiStatus().then((s) => setConfigured(s.configured)).catch(() => setConfigured(false))
    refreshList()
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [turns])

  // Auto-grow the composer up to a max height.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }, [input])

  const refreshList = () =>
    api.aiConversations().then(setConversations).catch(() => {})

  const newChat = () => {
    abortRef.current?.abort()
    setActiveId(null)
    setTurns([])
    setInput("")
    setDrawer(false)
    taRef.current?.focus()
  }

  const openConversation = async (id: string) => {
    if (id === activeId || busy) return
    setDrawer(false)
    setLoadingThread(true)
    setActiveId(id)
    try {
      const { messages } = await api.aiConversation(id)
      setTurns(messages.map((m) => ({ role: m.role, content: m.content, tools: m.tools as ToolTrace[] })))
    } catch {
      setTurns([])
    } finally {
      setLoadingThread(false)
    }
  }

  const removeConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (id === activeId) newChat()
    await api.aiDeleteConversation(id).catch(() => {})
  }

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    setInput("")
    const history = [...turns, { role: "user" as const, content: q }]
    setTurns([...history, { role: "assistant", content: "", tools: [], pending: true }])
    setBusy(true)
    abortRef.current = new AbortController()
    let convId = activeId

    const wire = history.map((t) => ({ role: t.role, content: t.content }))
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev]
        next[next.length - 1] = fn(next[next.length - 1])
        return next
      })

    try {
      await api.aiChat(
        wire,
        (e: AgentEvent) => {
          if (e.type === "conversation") {
            convId = e.id
            setActiveId(e.id)
          } else if (e.type === "tool_call") {
            patch((t) => ({ ...t, tools: [...(t.tools || []), { name: e.name, args: e.args }] }))
          } else if (e.type === "tool_result") {
            patch((t) => {
              const tools = [...(t.tools || [])]
              for (let i = tools.length - 1; i >= 0; i--) {
                if (tools[i].name === e.name && tools[i].ok === undefined) {
                  tools[i] = { ...tools[i], ok: e.ok, result: e.result }
                  break
                }
              }
              return { ...t, tools }
            })
          } else if (e.type === "text") {
            patch((t) => ({ ...t, content: (t.content ? t.content + "\n" : "") + e.text }))
          } else if (e.type === "error") {
            patch((t) => ({ ...t, content: (t.content ? t.content + "\n" : "") + `⚠️ ${e.message}` }))
          }
        },
        abortRef.current.signal,
        convId || undefined,
      )
    } catch (err) {
      patch((t) => ({ ...t, content: t.content || `⚠️ ${err instanceof Error ? err.message : "Chat failed"}` }))
    } finally {
      patch((t) => ({ ...t, pending: false }))
      setBusy(false)
      refreshList() // pick up the new/updated conversation in the sidebar
    }
  }

  const off = configured === false
  const empty = turns.length === 0 && !loadingThread

  return (
    <div className="flex h-full min-h-0 bg-bg">
      {/* ── History sidebar ─────────────────────────────────────────── */}
      <HistoryPanel
        conversations={conversations}
        activeId={activeId}
        onNew={newChat}
        onOpen={openConversation}
        onDelete={removeConversation}
        drawer={drawer}
        onCloseDrawer={() => setDrawer(false)}
      />

      {/* ── Chat column ─────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 lg:px-6">
          <button
            className="rounded-md p-1.5 text-sub hover:bg-mutedbg hover:text-fg md:hidden"
            aria-label="Chat history"
            onClick={() => setDrawer(true)}
          >
            <PanelLeftOpen size={18} />
          </button>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold leading-tight">ReachPilot Assistant</h1>
            <p className="truncate text-xs text-sub">
              {off ? "AI is off — set GEMINI_API_KEY to enable." : "Grounded in your live workspace data & tools"}
            </p>
          </div>
          <button
            onClick={newChat}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-sub transition-colors hover:border-accent hover:text-accent"
          >
            <Plus size={14} /> <span className="hidden sm:inline">New chat</span>
          </button>
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-smooth">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-6">
            {loadingThread ? (
              <ThreadSkeleton />
            ) : empty ? (
              <EmptyState onPick={send} disabled={off} />
            ) : (
              <div className="flex flex-col gap-6">
                {turns.map((t, i) => (
                  <MessageRow key={i} turn={t} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-line bg-bg px-4 py-3 lg:px-6">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
            className="mx-auto w-full max-w-3xl"
          >
            <div
              className={cx(
                "flex items-end gap-2 rounded-2xl border border-line bg-card px-3 py-2 transition-colors",
                "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15",
              )}
            >
              <textarea
                ref={taRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    send(input)
                  }
                }}
                placeholder={off ? "AI is disabled" : "Ask anything, or tell me to scrape the web…"}
                className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-sub"
                disabled={busy || off}
              />
              <button
                type="submit"
                aria-label="Send message"
                disabled={busy || !input.trim() || off}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
            <p className="mt-1.5 px-1 text-center text-[11px] text-sub">
              <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line
            </p>
          </form>
        </div>
      </div>
    </div>
  )
}

/* ── History panel (sidebar on desktop, drawer on mobile) ──────────────── */

function HistoryPanel({
  conversations,
  activeId,
  onNew,
  onOpen,
  onDelete,
  drawer,
  onCloseDrawer,
}: {
  conversations: ConversationSummary[]
  activeId: string | null
  onNew: () => void
  onOpen: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  drawer: boolean
  onCloseDrawer: () => void
}) {
  const list = (
    <>
      <div className="p-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Plus size={16} /> New chat
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-sub">
            No conversations yet. Your chats appear here.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpen(c.id)}
                className={cx(
                  "group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  c.id === activeId ? "bg-accent/10 text-accent" : "text-fg hover:bg-mutedbg",
                )}
              >
                <MessageSquare size={14} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-[10px] text-sub group-hover:hidden">{relTime(c.updatedAt)}</span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Delete conversation"
                  onClick={(e) => onDelete(c.id, e)}
                  className="hidden shrink-0 rounded p-0.5 text-sub hover:text-danger group-hover:block"
                >
                  <Trash2 size={13} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )

  return (
    <>
      {/* Desktop */}
      <aside className="hidden w-64 flex-col border-r border-line bg-card/40 md:flex">{list}</aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={onCloseDrawer} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <span className="text-sm font-bold">History</span>
              <button className="rounded-md p-1.5 text-sub hover:bg-mutedbg" onClick={onCloseDrawer} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {list}
          </aside>
        </div>
      )}
    </>
  )
}

/* ── Empty state ───────────────────────────────────────────────────────── */

function EmptyState({ onPick, disabled }: { onPick: (q: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <Sparkles size={26} />
      </span>
      <h2 className="text-xl font-bold">How can I help with your outreach?</h2>
      <p className="mt-1.5 max-w-md text-sm text-sub">
        Ask about your leads, pipeline, and account — or put your connected tools to work
        (Apify web scraping, data extraction, and more).
      </p>
      <div className="mt-7 grid w-full max-w-xl gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            disabled={disabled}
            onClick={() => onPick(s.body)}
            className="rounded-xl border border-line bg-card p-3.5 text-left transition-colors hover:border-accent/60 hover:bg-mutedbg/40 disabled:opacity-50"
          >
            <p className="text-sm font-semibold">{s.title}</p>
            <p className="mt-0.5 text-xs text-sub">{s.body}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function ThreadSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-6">
      <div className="ml-auto h-9 w-2/3 rounded-2xl bg-mutedbg" />
      <div className="flex gap-3">
        <div className="h-8 w-8 shrink-0 rounded-lg bg-mutedbg" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-full rounded bg-mutedbg" />
          <div className="h-4 w-5/6 rounded bg-mutedbg" />
          <div className="h-4 w-3/4 rounded bg-mutedbg" />
        </div>
      </div>
    </div>
  )
}

/* ── One message row ───────────────────────────────────────────────────── */

function MessageRow({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white">
          {turn.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Sparkles size={16} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5 text-sm">
        {turn.tools?.map((tool, j) => <ToolCard key={j} tool={tool} />)}
        {turn.content && <Markdown text={turn.content} />}
        {turn.pending && !turn.content && (
          <div className="flex items-center gap-1 py-1 text-sub">
            <Dot /> <Dot delay={150} /> <Dot delay={300} />
          </div>
        )}
      </div>
    </div>
  )
}

function Dot({ delay = 0 }: { delay?: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-sub"
      style={{ animationDelay: `${delay}ms` }}
    />
  )
}

/** Inline **bold**, *italic*, `code`, and [text](url) → React nodes. */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${keyBase}-${i++}`
    const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) {
      out.push(
        <a key={k} href={link[2]} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
          {link[1]}
        </a>,
      )
    } else if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-mutedbg px-1 text-[0.85em]">{tok.slice(1, -1)}</code>)
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Minimal, safe Markdown: headings, bullet/numbered lists, and inline styles. */
function Markdown({ text }: { text: string }) {
  const lines = text.split("\n")
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `li${blocks.length}-${i}`)}</li>)
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} className="ml-5 list-decimal space-y-1">{items}</ol>
      ) : (
        <ul key={blocks.length} className="ml-5 list-disc space-y-1">{items}</ul>
      ),
    )
    list = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const num = line.match(/^\s*\d+\.\s+(.*)$/)
    const head = line.match(/^(#{1,3})\s+(.*)$/)
    if (bullet) {
      if (!list || list.ordered) flush()
      list = list || { ordered: false, items: [] }
      list.items.push(bullet[1])
    } else if (num) {
      if (!list || !list.ordered) flush()
      list = list || { ordered: true, items: [] }
      list.items.push(num[1])
    } else if (head) {
      flush()
      blocks.push(<p key={blocks.length} className="mt-2 font-bold">{inline(head[2], `h${blocks.length}`)}</p>)
    } else if (line.trim() === "") {
      flush()
    } else {
      flush()
      blocks.push(<p key={blocks.length}>{inline(line, `p${blocks.length}`)}</p>)
    }
  }
  flush()
  return <div className="space-y-2 leading-relaxed">{blocks}</div>
}

/** Collapsible tool-call trace (name + args + result), Claude-style. */
function ToolCard({ tool }: { tool: ToolTrace }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-line bg-mutedbg/40 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-sub transition-colors hover:bg-mutedbg/70"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Wrench size={12} />
        <span className="font-semibold text-fg">{tool.name}</span>
        {tool.ok === undefined ? (
          <Loader2 size={12} className="ml-auto animate-spin" />
        ) : (
          <span className={cx("ml-auto font-bold", tool.ok ? "text-success" : "text-danger")}>
            {tool.ok ? "✓" : "✕"}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1 border-t border-line px-2.5 py-1.5">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-sub">
            args: {JSON.stringify(tool.args, null, 2)}
          </pre>
          {tool.result !== undefined && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-sub">
              {JSON.stringify(tool.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
