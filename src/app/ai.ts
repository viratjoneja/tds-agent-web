/** Talks to the app's own server route, which holds the Gemini key. The browser never sees the key. */
export async function aiAvailable(): Promise<{ ai: boolean; model: string }> {
  try { const r = await fetch('/api/health'); return r.ok ? await r.json() : { ai: false, model: '' }; }
  catch { return { ai: false, model: '' }; }
}

export async function askGemini(req: { systemInstruction: string; prompt: string; responseSchema: unknown }): Promise<string> {
  const r = await fetch('/api/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `AI request failed (${r.status})`);
  return j.text as string;
}
