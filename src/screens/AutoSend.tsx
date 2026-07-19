import { useEffect, useRef, useState } from "react"
import * as XLSX from "xlsx"
import {
  CalendarClock,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Mail,
  Rocket,
  Send,
  UploadCloud,
  UserPlus,
  X,
} from "lucide-react"
import { Badge, Button, Card, Field, LinkedinIcon, cx, inputCls, useToast } from "../ui"
import { api } from "../api"
import type { LinkedInAccountState } from "../api"

type Mode = "linkedin" | "email"

type Row = {
  id: number
  jobId?: string
  name: string
  firstName: string
  target: string
  company: string
  role: string
  day: number
  status: "pending" | "sending" | "sent" | "scheduled" | "failed" | "canceled"
}

type Mapping = { name: string; target: string; company: string; role: string }

const detect = (headers: string[], patterns: RegExp[]): string => {
  for (const p of patterns) {
    const hit = headers.find((h) => p.test(h))
    if (hit) return hit
  }
  return ""
}

function fillTemplate(tpl: string, r: Row) {
  return tpl
    .replace(/\{\{firstName\}\}/g, r.firstName || "there")
    .replace(/\{\{company\}\}/g, r.company || "your company")
    .replace(/\{\{role\}\}/g, r.role || "your role")
}

const dayLabel = (day: number) => {
  if (day === 0) return "Today"
  const d = new Date()
  d.setDate(d.getDate() + day)
  const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
  return day === 1 ? `Tomorrow (${label})` : label
}

export function AutoSend({ mode, account }: { mode: Mode; account?: LinkedInAccountState | null }) {
  const toast = useToast()
  // The safe daily ceiling comes from the account's real warm-up state (LinkedIn),
  // not a hardcoded number. Falls back sensibly when there's no account yet.
  const safeMax = mode === "linkedin" ? account?.warmup?.todayLimit ?? 15 : 50
  const [fileName, setFileName] = useState("")
  const [headers, setHeaders] = useState<string[]>([])
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([])
  const [mapping, setMapping] = useState<Mapping>({ name: "", target: "", company: "", role: "" })
  const [rows, setRows] = useState<Row[]>([])
  const [cap, setCap] = useState(safeMax)
  // LinkedIn limits live ONLY in Settings → LinkedIn limits — this screen just
  // mirrors the account's enforced daily limit (the backend enforces it too, so
  // there's no way to send above it from here).
  useEffect(() => {
    if (mode === "linkedin" && account?.warmup) setCap(account.warmup.todayLimit)
  }, [account?.warmup?.todayLimit, mode])
  const [subject, setSubject] = useState("Quick intro — {{firstName}}")
  const [template, setTemplate] = useState(
    mode === "linkedin"
      ? "Hi {{firstName}}, impressed by your work at {{company}}. I'd love to connect and share how we help {{role}}s grow."
      : "Hi {{firstName}},\n\nI came across your profile at {{company}} and wanted to reach out about an opportunity that fits your experience as {{role}}.\n\nOpen to a quick chat this week?",
  )
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const targetPatterns =
    mode === "linkedin"
      ? [/linkedin/i, /profile\s*(url|link)/i]
      : [/e-?mail/i, /mail\s*(id|address)/i]

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
  }, [])

  const parseWorkbook = (buf: ArrayBuffer, name: string) => {
    const wb = XLSX.read(buf, { type: "array" })
    // pick the sheet with the most usable columns for this mode
    let best: { sheet: string; rows: Record<string, unknown>[]; score: number } | null = null
    for (const sheetName of wb.SheetNames) {
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], {
        defval: "",
      })
      if (!json.length) continue
      const hdrs = Object.keys(json[0])
      const score =
        (detect(hdrs, targetPatterns) ? 2 : 0) + (detect(hdrs, [/^name$/i, /name/i]) ? 1 : 0)
      if (!best || score > best.score) best = { sheet: sheetName, rows: json, score }
    }
    if (!best || best.score < 2) {
      toast(
        mode === "linkedin"
          ? "No LinkedIn URL column found in this file"
          : "No email column found in this file",
      )
      return
    }
    const hdrs = Object.keys(best.rows[0])
    const m: Mapping = {
      name: detect(hdrs, [/^name$/i, /full\s*name/i, /candidate/i, /name/i]),
      target: detect(hdrs, targetPatterns),
      company: detect(hdrs, [/company/i, /organi[sz]ation/i]),
      role: detect(hdrs, [/role/i, /title/i, /designation/i]),
    }
    setFileName(name)
    setHeaders(hdrs)
    setRawRows(best.rows)
    setMapping(m)
    setRows([])
    setDone(false)
    toast(`Parsed ${best.rows.length} profiles from "${best.sheet}"`)
  }

  const onFile = async (f: File) => {
    parseWorkbook(await f.arrayBuffer(), f.name)
  }

  const loadSample = async () => {
    const res = await fetch("/sample.xlsx")
    parseWorkbook(await res.arrayBuffer(), "sample.xlsx")
  }

  const buildRows = (): Row[] =>
    rawRows
      .map((r, i) => {
        const name = String(r[mapping.name] ?? "").trim()
        const target = String(r[mapping.target] ?? "").trim()
        return {
          id: i,
          name,
          firstName: name.split(" ")[0] || "",
          target,
          company: String(r[mapping.company] ?? "").trim(),
          role: String(r[mapping.role] ?? "").trim(),
          day: 0,
          status: "pending" as const,
        }
      })
      .filter((r) => r.name && r.target)

  // Map a backend job status → the row status shown in the queue.
  const jobToRowStatus = (s: string): Row["status"] => {
    if (s === "sent") return "sent"
    if (s === "running") return "sending"
    if (s === "scheduled") return "scheduled"
    if (s === "canceled") return "canceled"
    if (s === "failed") return "failed"
    return "pending" // queued
  }

  // "Close" a queued/scheduled profile: drop it from the queue view and cancel
  // the backend job so it never sends.
  const cancelRow = async (row: Row) => {
    setRows((rs) => rs.filter((r) => r.id !== row.id))
    if (row.jobId) {
      try {
        await api.cancelJob(row.jobId)
      } catch {
        toast("Couldn't cancel on the server — it may already be sending.")
      }
    }
  }

  const start = async () => {
    const list = buildRows().map((r, i) => ({
      ...r,
      day: Math.floor(i / cap),
      status: (Math.floor(i / cap) === 0 ? "pending" : "scheduled") as Row["status"],
    }))
    setRows(list)
    setRunning(true)
    setDone(false)

    let batchId: string
    try {
      const res = await api.createSend({
        kind: mode,
        cap,
        rows: list.map((r) => ({ name: r.name, target: r.target, company: r.company, role: r.role })),
        template,
        subject: mode === "email" ? subject : undefined,
      })
      batchId = res.batchId
      toast(
        `Queued ${res.total} ${mode === "linkedin" ? "connection requests" : "emails"} — ${res.today} today` +
          (res.queuedDays > 1 ? ` · rest scheduled over ${res.queuedDays} days (9:00 AM)` : ""),
      )
    } catch (e) {
      setRunning(false)
      toast(e instanceof Error ? e.message : "Couldn't start the send")
      return
    }

    // Poll the backend for real job statuses (worker paces sends with jitter).
    let ticks = 0
    timerRef.current = setInterval(async () => {
      ticks++
      try {
        const jobs = await api.listJobs(batchId)
        const byTarget = new Map(jobs.map((j) => [j.target, j]))
        setRows((rs) =>
          rs.map((r) => {
            // Keep a locally-canceled row canceled even if a stale poll returns.
            if (r.status === "canceled") return r
            const j = byTarget.get(r.target)
            return j ? { ...r, jobId: j.id, status: jobToRowStatus(j.status) } : r
          }),
        )
        const todayJobs = jobs.filter((j) => j.day === 0)
        const settled = todayJobs.every((j) => ["sent", "failed", "canceled"].includes(j.status))
        if ((todayJobs.length > 0 && settled) || ticks > 60) {
          if (timerRef.current) clearInterval(timerRef.current)
          setRunning(false)
          setDone(true)
          const sent = jobs.filter((j) => j.status === "sent").length
          const failed = jobs.filter((j) => j.status === "failed").length
          toast(`${sent} sent${failed ? ` · ${failed} failed` : ""}`)
        }
      } catch {
        /* transient — keep polling */
      }
    }, 3000)
  }

  const parsed = rawRows.length > 0
  const valid = parsed && mapping.name && mapping.target
  const total = valid ? buildRows().length : 0
  const days = total ? Math.ceil(total / cap) : 0
  const sentCount = rows.filter((r) => r.status === "sent").length
  const todayTotal = rows.filter((r) => r.day === 0).length

  const icon = mode === "linkedin" ? <LinkedinIcon size={18} /> : <Mail size={18} />

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          {mode === "linkedin" ? <UserPlus size={22} className="text-accent" /> : <Send size={22} className="text-accent" />}
          {mode === "linkedin" ? "Auto Connect" : "Auto Mail"}
        </h1>
        <p className="text-sm text-sub">
          {mode === "linkedin"
            ? "Upload an Excel file — we find names and LinkedIn URLs, then send connection requests within your daily safe limit."
            : "Upload an Excel file — we find names and email addresses, then send personalized emails within your daily limit."}
        </p>
      </div>

      {/* 1. Upload */}
      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-bold">
          <FileSpreadsheet size={16} className="text-success" /> 1. Upload profiles
        </h2>
        {!parsed ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload Excel file"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files[0]
              if (f) onFile(f)
            }}
            className={cx(
              "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
              dragOver ? "border-accent bg-accent/5" : "border-line hover:border-accent",
            )}
          >
            <UploadCloud size={30} className="text-accent" />
            <p className="font-semibold">Drop your .xlsx here or click to browse</p>
            <p className="text-xs text-sub">
              We auto-detect the {mode === "linkedin" ? "Name and LinkedIn URL" : "Name and Email"} columns.
            </p>
            <button
              className="mt-1 text-sm font-semibold text-accent hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                loadSample()
              }}
            >
              or load the sample candidate file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="success">
                <CheckCircle2 size={12} /> {fileName}
              </Badge>
              <span className="tabular text-sm font-semibold">{total} usable profiles</span>
              <button
                className="ml-auto flex items-center gap-1 text-sm font-semibold text-sub hover:text-danger"
                onClick={() => {
                  setRawRows([])
                  setRows([])
                  setFileName("")
                  setDone(false)
                }}
              >
                <X size={14} /> Remove file
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["name", "Name column"],
                  ["target", mode === "linkedin" ? "LinkedIn URL column" : "Email column"],
                  ["company", "Company column"],
                  ["role", "Role column"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <select
                    className={inputCls}
                    value={mapping[key]}
                    onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                  >
                    <option value="">— not used —</option>
                    {headers.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-sub">
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">{mode === "linkedin" ? "LinkedIn" : "Email"}</th>
                    <th className="hidden px-4 py-2.5 md:table-cell">Company</th>
                  </tr>
                </thead>
                <tbody>
                  {buildRows().slice(0, 4).map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 font-semibold">{r.name}</td>
                      <td className="max-w-[240px] truncate px-4 py-2.5 text-accent">{r.target}</td>
                      <td className="hidden px-4 py-2.5 text-sub md:table-cell">{r.company}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > 4 && (
                <p className="border-t border-line px-4 py-2 text-xs text-sub">+ {total - 4} more profiles</p>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* 2. Message */}
      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-bold">{icon} 2. Message template</h2>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {["{{firstName}}", "{{company}}", "{{role}}"].map((v) => (
            <button
              key={v}
              onClick={() => setTemplate(template + " " + v)}
              className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/20"
            >
              {v}
            </button>
          ))}
        </div>
        {mode === "email" && (
          <Field label="Subject">
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        )}
        <textarea
          rows={mode === "email" ? 5 : 3}
          className={cx(inputCls, "mt-3 resize-none font-[inherit]")}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          aria-label="Message template"
        />
        {valid && (
          <div className="mt-3 rounded-md bg-mutedbg p-3 text-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">
              Preview — {buildRows()[0]?.name}
            </p>
            {mode === "email" && (
              <p className="font-semibold">{fillTemplate(subject, buildRows()[0])}</p>
            )}
            <p className="whitespace-pre-line">{fillTemplate(template, buildRows()[0])}</p>
          </div>
        )}
      </Card>

      {/* 3. Schedule + send */}
      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-bold">
          <CalendarClock size={16} className="text-warn" /> 3. Daily limit &amp; schedule
        </h2>
        <div className="flex flex-wrap items-end gap-4">
          {mode === "linkedin" ? (
            <Field
              label="Daily limit"
              hint={
                account?.warmup
                  ? `Today's enforced limit (ramping to ${account.warmup.target}). Change it in Settings → LinkedIn limits.`
                  : "Set in Settings → LinkedIn limits once your account is connected."
              }
            >
              <div className={cx(inputCls, "flex w-32 items-center justify-center bg-mutedbg font-semibold")}>
                {cap}/day
              </div>
            </Field>
          ) : (
            <Field label="Max per day" hint="Safe limit protects your account.">
              <input
                type="number"
                min={1}
                max={200}
                value={cap}
                onChange={(e) => setCap(Math.max(1, Number(e.target.value)))}
                className={cx(inputCls, "w-28")}
              />
            </Field>
          )}
          {valid && (
            <div className="flex-1 rounded-md bg-mutedbg p-3 text-sm">
              <span className="font-semibold">{total} profiles → </span>
              {Array.from({ length: days }, (_, d) => {
                const n = Math.min(cap, total - d * cap)
                return (
                  <span key={d}>
                    {d > 0 && " · "}
                    <span className={cx("font-semibold", d === 0 ? "text-success" : "text-warn")}>
                      {n} {dayLabel(d).toLowerCase()}
                    </span>
                  </span>
                )
              })}
              {days > 1 && <span className="text-sub"> — queued sends go out automatically at 9:00 AM.</span>}
            </div>
          )}
        </div>
        <Button
          className="mt-4"
          disabled={!valid || running || total === 0}
          onClick={start}
        >
          {running ? (
            <>
              <Loader2 size={16} className="animate-spin" /> Sending {sentCount}/{todayTotal}…
            </>
          ) : (
            <>
              <Rocket size={16} />
              {mode === "linkedin" ? "Start sending connection requests" : "Start sending emails"}
            </>
          )}
        </Button>
      </Card>

      {/* 4. Queue */}
      {rows.length > 0 && (
        <Card>
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="font-bold">Send queue</h2>
            <div className="flex gap-2">
              <Badge tone="success">{sentCount} sent</Badge>
              <Badge tone="warn">{rows.filter((r) => r.status === "scheduled").length} queued</Badge>
            </div>
          </div>
          {Array.from(new Set(rows.map((r) => r.day))).map((day) => (
            <div key={day}>
              <p className="bg-mutedbg/60 px-5 py-2 text-xs font-bold uppercase tracking-wide text-sub">
                {dayLabel(day)} · {rows.filter((r) => r.day === day).length} profiles
                {day > 0 && " · sends automatically at 9:00 AM"}
              </p>
              <ul className="divide-y divide-line">
                {rows
                  .filter((r) => r.day === day)
                  .map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-bold text-white dark:bg-accent">
                        {r.firstName[0]}
                        {(r.name.split(" ")[1] || "")[0] || ""}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{r.name}</p>
                        <p className="truncate text-xs text-sub">{r.target}</p>
                      </div>
                      {r.status === "sent" && (
                        <Badge tone="success">
                          <CheckCircle2 size={12} /> Sent
                        </Badge>
                      )}
                      {r.status === "sending" && (
                        <Badge tone="accent">
                          <Loader2 size={12} className="animate-spin" /> Sending
                        </Badge>
                      )}
                      {r.status === "pending" && <Badge tone="sub">Waiting</Badge>}
                      {r.status === "scheduled" && (
                        <Badge tone="warn">
                          <CalendarClock size={12} /> Queued
                        </Badge>
                      )}
                      {r.status === "failed" && <Badge tone="danger">Failed</Badge>}
                      {/* Close button — cancels a not-yet-sent profile and removes it. */}
                      {(r.status === "pending" || r.status === "scheduled" || r.status === "sending") && (
                        <button
                          onClick={() => cancelRow(r)}
                          aria-label={`Remove ${r.name} from queue`}
                          title="Remove from queue"
                          className="rounded-md p-1.5 text-sub transition-colors hover:bg-danger/10 hover:text-danger"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {done && (
            <p className="border-t border-line px-5 py-3 text-sm text-sub">
              Done for today — queued profiles will be sent automatically on their scheduled day at
              9:00 AM to stay within your daily limit.
            </p>
          )}
        </Card>
      )}
    </div>
  )
}
