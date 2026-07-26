// Template rendering helpers. These operate on REAL leads from the API —
// previously they lived in data.ts and iterated a hardcoded sample list.
import type { LeadRow } from "@/types"

/** Fill {{token}} / {{token|fallback}} placeholders from a lead. */
export function renderTemplate(tpl: string, lead: LeadRow): string {
  const map: Record<string, string> = {
    firstName: lead.firstName || "",
    lastName: (lead.name || "").split(" ").slice(1).join(" "),
    fullName: lead.name || "",
    company: lead.company || "",
    title: lead.title || "",
    role: lead.title || "",
    location: lead.location || "",
  }
  return tpl.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, fb) => map[key] || fb || `{{${key}}}`)
}

/**
 * The lead whose rendered message is longest — used to warn when a template
 * could exceed LinkedIn's 300-char note limit for some lead. Returns len 0 when
 * there are no leads yet (nothing to render against).
 */
export function longestRender(tpl: string, leads: LeadRow[]): { len: number; lead: LeadRow | null } {
  let best: { len: number; lead: LeadRow | null } = { len: 0, lead: null }
  for (const l of leads) {
    const len = renderTemplate(tpl, l).length
    if (len > best.len) best = { len, lead: l }
  }
  return best
}
