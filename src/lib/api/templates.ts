// Saved message templates (Auto Connect / Auto Mail). Reads go through
// `api.getTemplates`; this module holds the writes.
import { del, req } from "./index"
import type { TemplateRow } from "@/types"

export const templatesApi = {
  create: (body: { name?: string; channel: "linkedin" | "email"; subject?: string; body: string }) =>
    req<TemplateRow>("/api/templates", body),
  remove: (id: string) => del<{ deleted: boolean }>(`/api/templates/${id}`),
}
