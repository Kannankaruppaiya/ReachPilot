import * as crypto from 'crypto';

/**
 * Format: rp_live_<48 hex random>_<32 hex workspace>. The workspace part lets the
 * guard look the key up under RLS; the stored hash covers the whole token, so the
 * embedded id is a routing hint, never a credential.
 */
const TOKEN_RE = /^rp_live_[0-9a-f]{48}_([0-9a-f]{32})$/;

export function mintApiKeyToken(workspaceId: string): string {
  const random = crypto.randomBytes(24).toString('hex');
  return `rp_live_${random}_${workspaceId.replace(/-/g, '').toLowerCase()}`;
}

/** The workspace a token was minted for, or null for a legacy (pre-format) key. */
export function workspaceIdFromToken(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function hashApiKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
