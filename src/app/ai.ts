/** Talks to the app's own server route, which holds the Gemini key. The browser never sees the key.
 *  Paths are relative to where the app is served (e.g. /tds/), and carry the staff login token. */
import { authHeader } from './office.ts';
const API = `${import.meta.env.BASE_URL}api`;
export async function aiAvailable(): Promise<{ ai: boolean; model: string }> {
  try { const r = await fetch(`${API}/health`, { headers: await authHeader() }); return r.ok ? await r.json() : { ai: false, model: '' }; }
  catch { return { ai: false, model: '' }; }
}

export async function askGemini(req: { systemInstruction: string; prompt: string; responseSchema: unknown }): Promise<string> {
  const r = await fetch(`${API}/gemini`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(req) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `AI request failed (${r.status})`);
  return j.text as string;
}
