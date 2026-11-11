/**
 * Small server for the deployed app:
 *  - serves the built app (dist/)
 *  - POST /api/gemini: forwards a MASKED request to Gemini with the key kept here (env GEMINI_API_KEY).
 *    Nothing is stored or logged. Requests that look like they carry a PAN or TAN are refused.
 *  - GET /api/health: tells the app whether AI is available.
 * Start: npm run build && npm start   (PORT defaults to 8080, as on Cloud Run)
 * No dependencies beyond Node 18+.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.xlsx': 'application/octet-stream',
  '.txt': 'application/octet-stream', '.woff2': 'font/woff2' };
const MAX_BODY = 2_000_000;

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};

/** Handles /api/*; returns false for anything else. Also used by the Vite dev server. */
export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') { send(res, 200, { ai: !!process.env.GEMINI_API_KEY, model: MODEL }); return true; }
  if (url.pathname !== '/api/gemini') return false;
  if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
  if (!process.env.GEMINI_API_KEY) { send(res, 503, { error: 'AI is not set up on this server (GEMINI_API_KEY missing)' }); return true; }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) { send(res, 413, { error: 'Request too large' }); return true; } }
  let body;
  try { body = JSON.parse(raw); } catch { send(res, 400, { error: 'Not JSON' }); return true; }
  // last line of defence: the browser masks first; refuse anything that still looks like a PAN or TAN
  if (/\b[A-Z]{5}\d{4}[A-Z]\b|\b[A-Z]{4}\d{5}[A-Z]\b/.test(raw)) { send(res, 400, { error: 'Request looks like it contains a PAN or TAN - not sent' }); return true; }
  const { systemInstruction, prompt, responseSchema } = body ?? {};
  if (typeof prompt !== 'string' || typeof systemInstruction !== 'string' || typeof responseSchema !== 'object') { send(res, 400, { error: 'Bad request shape' }); return true; }
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: 0 },
      }),
    });
    const j = await r.json();
    if (!r.ok) { send(res, 502, { error: `Gemini error ${r.status}: ${j?.error?.message ?? 'unknown'}` }); return true; }
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    send(res, 200, { text });
  } catch (e) { send(res, 502, { error: `Could not reach Gemini: ${e.message}` }); }
  return true;
}

async function serveStatic(req, res) {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) { send(res, 403, 'Forbidden', 'text/plain'); return; }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(DIST, 'index.html'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
    res.end(data);
  } catch { send(res, 404, 'Not found - run "npm run build" first', 'text/plain'); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8080);
  createServer(async (req, res) => { if (!(await handleApi(req, res))) await serveStatic(req, res); })
    .listen(port, () => console.log(`TDS return builder on http://localhost:${port} (AI ${process.env.GEMINI_API_KEY ? 'on' : 'off'}, model ${MODEL})`));
}
