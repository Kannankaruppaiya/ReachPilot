import { useEffect, useState } from "react"

type Mode = "linkedin" | "email"

const DEFAULT_BODY: Record<Mode, string> = {
  linkedin:
    "{Hi|Hey|Hello} {{firstName}}, impressed by your work at {{company}}. I'd love to connect and share how we help {{role}}s grow.",
  email:
    "{Hi|Hey|Hello} {{firstName}},\n\nI came across your profile at {{company}} and wanted to reach out about an opportunity that fits your experience as {{role}}.\n\nOpen to a quick chat this week?",
}
const DEFAULT_SUBJECT = "Quick intro — {{firstName}}"

const key = (mode: Mode, field: "body" | "subject") => `rp.autosend.${mode}.${field}`

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage blocked — the draft just won't survive a reload */
  }
}

/** The Auto Send message + subject, remembered per mode so leaving the screen doesn't wipe them. */
export function useTemplateDraft(mode: Mode) {
  const [template, setTemplate] = useState(() => read(key(mode, "body")) ?? DEFAULT_BODY[mode])
  const [subject, setSubject] = useState(() => read(key(mode, "subject")) ?? DEFAULT_SUBJECT)
  useEffect(() => write(key(mode, "body"), template), [mode, template])
  useEffect(() => write(key(mode, "subject"), subject), [mode, subject])
  return { template, setTemplate, subject, setSubject }
}
