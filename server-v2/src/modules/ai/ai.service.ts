import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '@/config/env';

/** The prospect facts we personalize against (mirrors the `leads` table). */
export interface LeadContext {
  firstName: string;
  fullName?: string;
  title?: string;
  company?: string;
  location?: string;
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
      `- STRICT: at most ${maxChars} characters. One or two sentences.`,
      `- Output ONLY the note text. No quotes, no preamble, no template placeholders.`,
      ``,
      `Prospect:`,
      facts,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Single generateContent call against the Gemini REST API. */
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
          generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 256 },
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
