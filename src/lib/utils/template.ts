// Template rendering over real leads from the API.
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

/** The lead with the longest rendered message (to warn about LinkedIn's 300-char note limit). */
export function longestRender(tpl: string, leads: LeadRow[]): { len: number; lead: LeadRow | null } {
  let best: { len: number; lead: LeadRow | null } = { len: 0, lead: null }
  for (const l of leads) {
    const len = renderTemplate(tpl, l).length
    if (len > best.len) best = { len, lead: l }
  }
  return best
}
