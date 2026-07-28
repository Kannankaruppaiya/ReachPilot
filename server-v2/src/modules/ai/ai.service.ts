import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '@/config/env';

/** The prospect facts we personalize against (mirrors the `leads` table). */
export interface LeadContext {
  firstName: string;
  fullName?: string;
  title?: string;
  company?: string;
  location?: string;
  /** Extra facts scraped from the prospect's profile (Apify) — free-form text
   *  the model can reference for a genuinely personalized note. */
  profileContext?: string;
}

/** Campaign-level tone/intent knobs. */
export interface CampaignVoice {
  /** Who the note is from (the sender's first name / brand). */
  senderName?: string;
  /** e.g. "warm and casual", "professional", "founder-to-founder". */
  brandVoice?: string;
  /** One line on why connecting is worth it — the soft value prop. */
  valueProp?: string;
  /** Hard character ceiling (LinkedIn connection notes cap ~300). */
  maxChars?: number;
}

export interface GeneratedNote {
  note: string;
  /** 'ai' when Gemini produced it, 'template' when we fell back. */
  source: 'ai' | 'template';
  model?: string;
}

/** A cleanly-extracted lead from a batch of raw search results (extractProfiles). */
export interface ExtractedProfile {
  name: string;
  title: string;
  company: string;
  location: string;
  linkedinUrl: string;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MAX_CHARS = 280; // safely under LinkedIn's ~300-char note limit

/**
 * Personalizes LinkedIn outreach copy with Google Gemini (Flash, free tier).
 *
 * Safety-first by construction:
 *  - never throws to the caller — any failure returns a plain-template note so a
 *    campaign never stalls on the AI;
 *  - hard length cap + unresolved-{{token}} strip so we never send a broken or
 *    over-long note to LinkedIn;
 *  - degrades to templates when GEMINI_API_KEY is unset.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  isConfigured(): boolean {
    return !!getEnv().GEMINI_API_KEY;
  }

  /** Produce a personalized connection note (or a safe template fallback). */
  async generateConnectionNote(lead: LeadContext, voice: CampaignVoice = {}): Promise<GeneratedNote> {
    const maxChars = voice.maxChars && voice.maxChars > 0 ? voice.maxChars : DEFAULT_MAX_CHARS;

    if (!this.isConfigured()) {
      return { note: this.templateNote(lead, voice, maxChars), source: 'template' };
    }

    try {
      const raw = await this.callGemini(this.buildPrompt(lead, voice, maxChars));
      const cleaned = this.sanitize(raw, maxChars);
      // Empty / all-stripped / still-broken output → template rather than junk.
      if (!cleaned) return { note: this.templateNote(lead, voice, maxChars), source: 'template' };
      return { note: cleaned, source: 'ai', model: getEnv().GEMINI_MODEL };
    } catch (err: any) {
      this.logger.warn({ err: String(err?.message || err) }, 'Gemini note generation failed — using template');
      return { note: this.templateNote(lead, voice, maxChars), source: 'template' };
    }
  }

  /* ---------------- internals ---------------- */

  private buildPrompt(lead: LeadContext, voice: CampaignVoice, maxChars: number): string {
    const facts = [
      `First name: ${lead.firstName}`,
      lead.title ? `Role: ${lead.title}` : '',
      lead.company ? `Company: ${lead.company}` : '',
      lead.location ? `Location: ${lead.location}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return [
      `You write short, natural LinkedIn connection-request notes.`,
      ``,
      `Rules:`,
      `- Address the person by their first name.`,
      `- Reference their role/company when it helps, but do NOT list facts robotically.`,
      `- Sound like a real human, ${voice.brandVoice || 'warm and professional'}.`,
      `- No salesy pitch, no links, no emojis, no hashtags.`,
      voice.valueProp ? `- Softly hint at this reason to connect: ${voice.valueProp}` : ``,
      voice.senderName ? `- The note is from ${voice.senderName}; do not sign it.` : ``,
      lead.profileContext
        ? `- Ground the note in ONE specific, genuine detail from their profile below — not a generic compliment.`
        : ``,
      `- STRICT: at most ${maxChars} characters. One or two sentences.`,
      `- Output ONLY the note text. No quotes, no preamble, no template placeholders.`,
      ``,
      `Prospect:`,
      facts,
      lead.profileContext ? `\nProfile details:\n${lead.profileContext}` : ``,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Single generateContent call against the Gemini REST API. */
  /**
   * Clean structured lead fields out of raw search-engine results. Google SERP
   * snippets are messy ("Finance Manager · 19 years · Nov 2024 - Present …"), so
   * a regex parse mislabels company/title. One batched Gemini call (JSON mode)
   * reads name / title / company / location far more reliably. Returns null on
   * any failure or when Gemini isn't configured — the caller then falls back to
   * its own regex parse, so this can only improve results, never break them.
   */
  async extractProfiles(
    raw: { title: string; snippet: string; url: string }[],
  ): Promise<ExtractedProfile[] | null> {
    const env = getEnv();
    if (!env.GEMINI_API_KEY || !raw.length) return null;
    const url = `${GEMINI_BASE}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent?key=${env.GEMINI_API_KEY}`;

    const prompt = [
      'These are LinkedIn profile search results (title, snippet, url).',
      'For each result extract the person\'s real NAME, current job TITLE, current COMPANY, and LOCATION.',
      'Rules:',
      '- Use ONLY facts present in that result\'s title/snippet; if a field is unknown, use "".',
      '- name = the person (usually the text before " - " in the title).',
      '- Never put role text in company or company text in title. Drop tenure phrases like "19 years" or "Nov 2024 - Present".',
      '- Copy linkedinUrl EXACTLY as given.',
      'Return a JSON array, one object per input result, in the same order.',
      '',
      'RESULTS:',
      JSON.stringify(raw.map((r) => ({ title: r.title, snippet: r.snippet, url: r.url }))),
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            // Room for Gemini-3 "thinking" tokens PLUS a JSON array of ~30 objects.
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  title: { type: 'STRING' },
                  company: { type: 'STRING' },
                  location: { type: 'STRING' },
                  linkedinUrl: { type: 'STRING' },
                },
                required: ['name', 'linkedinUrl'],
              },
            },
          },
        }),
      });
      if (!res.ok) {
        this.logger.warn(`extractProfiles: Gemini ${res.status} — falling back to regex parse`);
        return null;
      }
      const data: any = await res.json();
      const text: string =
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') || '';
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return null;
      return arr
        .map((o: any) => ({
          name: String(o?.name || '').trim(),
          title: String(o?.title || '').trim(),
          company: String(o?.company || '').trim(),
          location: String(o?.location || '').trim(),
          linkedinUrl: String(o?.linkedinUrl || '').trim(),
        }))
        .filter((o: ExtractedProfile) => o.name && /linkedin\.com\/in\//i.test(o.linkedinUrl));
    } catch (err: any) {
      this.logger.warn(`extractProfiles failed (${err?.message}) — falling back to regex parse`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callGemini(prompt: string): Promise<string> {
    const env = getEnv();
    const url = `${GEMINI_BASE}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent?key=${env.GEMINI_API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // maxOutputTokens must cover Gemini 2.5/3 "thinking" tokens PLUS the note,
          // or the answer returns empty/truncated (thinking eats the whole budget).
          // 1024 leaves ample room for a <280-char note after thinking.
          generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 1024 },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data: any = await res.json();
      const text: string =
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') || '';
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Enforce the guardrails: strip junk, drop leftover tokens, hard length cap. */
  private sanitize(text: string, maxChars: number): string {
    let t = (text || '').trim();
    // Models sometimes wrap the note in quotes — remove a single wrapping pair.
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1).trim();
    }
    // Never ship an unresolved template token (e.g. "{{firstName}}").
    if (/\{\{.*?\}\}/.test(t)) t = t.replace(/\{\{.*?\}\}/g, '').replace(/\s{2,}/g, ' ').trim();
    // Collapse whitespace/newlines to keep it a tidy one-liner-ish note.
    t = t.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (t.length > maxChars) {
      // Trim to the last sentence/word boundary under the cap rather than mid-word.
      const cut = t.slice(0, maxChars);
      const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      t = (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, '')).trim();
    }
    return t;
  }

  /** Deterministic, always-safe fallback when AI is unavailable. */
  private templateNote(lead: LeadContext, voice: CampaignVoice, maxChars: number): string {
    const name = lead.firstName?.trim() || 'there';
    const at = lead.company ? ` at ${lead.company}` : '';
    const base = lead.title
      ? `Hi ${name}, I came across your work as ${lead.title}${at} and would love to connect.`
      : `Hi ${name}, I'd love to connect and follow your work${at}.`;
    return base.length > maxChars ? base.slice(0, maxChars).replace(/\s+\S*$/, '').trim() : base;
  }
}
