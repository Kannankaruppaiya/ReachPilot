import * as crypto from 'crypto';

/**
 * API key token format.
 *
 * `api_keys` is RLS-scoped, but a request authenticated by an API key arrives
 * with no workspace context — the key IS what names the workspace. Looking the
 * hash up with raw getDb() only worked because production connected as a
 * BYPASSRLS role; under a role subject to RLS every key read as invalid.
 *
 * So new keys carry their workspace:  rp_live_<48 hex random>_<32 hex workspace>
 * The guard reads the workspace from the token, then looks the hash up UNDER
 * that workspace's context. The stored hash covers the whole token, so editing
 * the workspace part yields a different hash and matches nothing — the embedded
 * id is a routing hint, never a credential. The random part stays first so the
 * stored display prefix (first 12 chars) still tells keys apart.
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
