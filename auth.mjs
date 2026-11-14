/**
 * Office portal: server-side login check (same logic as TRUE GST server/authCheck.ts) for /api routes (no extra dependencies).
 * Verifies the Firebase ID token sent by the browser (Authorization: Bearer <token>) as Firebase
 * documents: RS256 signature against Google's published keys, aud = project id,
 * iss = https://securetoken.google.com/<project id>, not expired, non-empty sub.
 * Then requires a verified office (Workspace) email signed in through Google.
 */
import { createPublicKey, verify as verifySig } from "node:crypto";

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = null;

async function getCerts() {
  if (certCache && Date.now() < certCache.expires) return certCache.certs;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error(`Could not fetch Google signing keys (HTTP ${r.status})`);
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  const certs = await r.json();
  certCache = { certs, expires: Date.now() + maxAge * 1000 };
  return certs;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export async function verifyStaffToken(authHeader, projectId, officeDomain) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? '');
  if (!m) throw new Error('Not signed in');
  const parts = m[1].split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unexpected token type');
  const cert = (await getCerts())[header.kid];
  if (!cert) throw new Error('Unknown signing key');
  const ok = verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(cert), b64url(parts[2]));
  if (!ok) throw new Error('Bad token signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Token is for another project');
  if (typeof payload.exp !== 'number' || payload.exp <= now - 60) throw new Error('Session expired - sign in again');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('Token issued in the future');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Token has no user');
  const email = String(payload.email ?? '').toLowerCase();
  if (payload.email_verified !== true || !email.endsWith('@' + officeDomain)) throw new Error('Office accounts only');
  if (payload.firebase?.sign_in_provider !== 'google.com') throw new Error('Sign in with your office Google account');
  return { uid: payload.sub, email };
}
