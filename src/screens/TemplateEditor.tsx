import { useEffect, useRef, useState } from "react"
import { Bookmark, BookmarkPlus, Loader2, X } from "lucide-react"
import { Field } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"
import { api } from "@/lib/api"
import { templatesApi } from "@/lib/api/templates"
import type { TemplateRow } from "@/types"

// The greeting chip drops in spintax so each recipient gets a different opener.
const INSERT_CHIPS = ["{Hi|Hey|Hello}", "{{firstName}}", "{{company}}", "{{role}}"]

/** Auto Send message box: saved templates, insert-at-cursor chips, subject (email) and body. */
export function TemplateEditor({
  mode,
  template,
  setTemplate,
  subject,
  setSubject,
}: {
  mode: "linkedin" | "email"
  template: string
  setTemplate: (v: string) => void
  subject: string
  setSubject: (v: string) => void
}) {
  const toast = useToast()
  const textRef = useRef<HTMLTextAreaElement>(null)
  // Saved templates for this channel — workspace-wide, stored server-side.
  const [saved, setSaved] = useState<TemplateRow[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .getTemplates()
      .then((ts) => alive && setSaved(ts.filter((t) => t.channel === mode)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mode])

  // Insert at the caret (replacing any selection) instead of appending. The
  // textarea keeps selectionStart/End after it blurs, so this still knows where
  // the user last clicked.
  const insertAtCursor = (text: string) => {
    const el = textRef.current
    const start = el?.selectionStart ?? template.length
    const end = el?.selectionEnd ?? template.length
    setTemplate(template.slice(0, start) + text + template.slice(end))
    const caret = start + text.length
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const save = async () => {
    const body = template.trim()
    if (!body) return
    if (saved.some((t) => t.body.trim() === body && (mode !== "email" || (t.subject ?? "") === subject.trim()))) {
      toast("This message is already saved")
      return
    }
    const name = window.prompt("Name this template", body.replace(/\s+/g, " ").slice(0, 40))
    if (name === null) return
    setSaving(true)
    try {
      const t = await templatesApi.create({
        name: name.trim() || undefined,
        channel: mode,
        body,
        subject: mode === "email" ? subject : undefined,
      })
      setSaved((ts) => [...ts, t])
      toast("Template saved")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save the template")
    } finally {
      setSaving(false)
    }
  }

  const load = (t: TemplateRow) => {
    setTemplate(t.body)
    if (mode === "email" && t.subject) setSubject(t.subject)
  }

  const remove = async (t: TemplateRow) => {
    setSaved((ts) => ts.filter((x) => x.id !== t.id))
    try {
      await templatesApi.remove(t.id)
    } catch {
      setSaved((ts) => [...ts, t])
      toast("Couldn't delete the template")
    }
  }

  return (
    <>
      {saved.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs font-semibold text-sub">
            <Bookmark size={12} /> Saved:
          </span>
          {saved.map((t) => (
            <span
              key={t.id}
              className={cx(
                "flex items-center rounded-full border text-xs font-semibold",
                t.body === template ? "border-accent bg-accent/10 text-accent" : "border-line",
              )}
            >
              <button
                type="button"
                onClick={() => load(t)}
                title={t.body}
                className="max-w-[220px] truncate py-1 pl-2.5 pr-1"
              >
                {t.name}
              </button>
              <button
                type="button"
                onClick={() => remove(t)}
                aria-label={`Delete template ${t.name}`}
                className="rounded-full p-1 pr-1.5 text-sub hover:text-danger"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {INSERT_CHIPS.map((v) => (
          <button
            key={v}
            type="button"
            // mousedown's default would blur the textarea first; keep focus.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertAtCursor(v)}
            className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/20"
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          onClick={save}
          disabled={saving || !template.trim()}
          className="ml-auto flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs font-semibold text-sub hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <BookmarkPlus size={12} />}
          Save template
        </button>
      </div>
      {mode === "email" && (
        <Field label="Subject">
          <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      )}
      <textarea
        ref={textRef}
        rows={mode === "email" ? 5 : 3}
        className={cx(inputCls, "mt-3 resize-none font-[inherit]")}
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        aria-label="Message template"
      />
      <p className="mt-1 text-xs text-sub">
        Variation: <code className="rounded bg-mutedbg px-1">{"{Hi|Hey|Hello}"}</code> picks one option per
        recipient, so no two {mode === "linkedin" ? "notes" : "emails"} read identically. Chips insert where your
        cursor is.
      </p>
    </>
  )
}
