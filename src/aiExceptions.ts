/**
 * Phase 4b — AI proposals for the challan exceptions the rules left open.
 *
 * Only what the rules could not decide goes to Gemini, and only MASKED:
 *   challans: number, date, tax, interest, major head, section breakup, balance left
 *   rows:     an id, month of deduction, section code, payee type (company / non-company), tax
 * No PAN, name, TAN, BSR code, challan serial or CIN is ever in the payload.
 *
 * Gemini only PROPOSES links. Every proposal is checked here by rules (row exists and is open,
 * challan exists, enough money left, section share, dates). A proposal that breaks a rule the
 * law or the SOP sets - e.g. a challan dated before the deduction, or using a duplicate challan to
 * fund a later month - is not dropped silently: it is marked as needing the user's approval.
 * Accepted links are applied as typed-in challan numbers and matchChallans() is run again,
 * so the final answer is always the rules' answer.
 *
 * New module — does not change the frozen core.
 */
import { matchChallans, type ChallanIn, type MatchResult, type RowIn } from './challanMatch.ts';

const payeeType = (pan: string) => (/^[A-Z]{3}C/.test(pan) ? 'company' : 'non-company');
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface MaskedPayload {
  challans: { challan: number; date: string; tax: number; interest: number; majorHead: string; breakup: Record<string, number> | null; balance: number }[];
  rows: { id: number; month: string; section: string; payee: 'company' | 'non-company'; tax: number; challan: number | null; status: string }[];
  exceptions: { kind: string; rows: number[]; challans: number[]; message: string }[];
}

/** Masked payload: only exception rows are open; matched rows are shown for context with their challan. */
export function maskedPayload(challans: ChallanIn[], rows: RowIn[], result: MatchResult): MaskedPayload {
  const st = new Map(result.rows.map(r => [r.row, r]));
  const bal = new Map(result.challans.map(c => [c.no, c.balance]));
  const strip = (s: string) => s.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]').replace(/\b[A-Z]{4}\d{5}[A-Z]\b/g, '[TAN]').replace(/\b\d{7}\b/g, '[BSR]');
  return {
    challans: challans.map(c => ({ challan: c.no, date: c.date, tax: c.tax, interest: c.interest, majorHead: c.majorHead, breakup: c.breakup, balance: bal.get(c.no) ?? c.tax })),
    rows: rows.map(r => ({ id: r.row, month: r.dateDeducted.slice(0, 7), section: r.code, payee: payeeType(r.pan), tax: r.tax,
      challan: st.get(r.row)?.status === 'exception' ? null : (st.get(r.row)?.challanNo ?? null), status: st.get(r.row)?.status ?? 'open' })),
    exceptions: result.exceptions.map(e => ({ kind: e.kind, rows: e.rows, challans: e.challans, message: strip(e.message) })),
  };
}

/** Throws if anything that looks like an identifier is in the payload (last line of defence). */
export function assertMasked(payload: unknown): void {
  const s = JSON.stringify(payload);
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(s)) throw new Error('PAN found in the AI payload - not sent');
  if (/\b[A-Z]{4}\d{5}[A-Z]\b/.test(s)) throw new Error('TAN found in the AI payload - not sent');
  if (/"(pan|name|bsr|serial|cin|tan)"/i.test(s)) throw new Error('Identifier field found in the AI payload - not sent');
}

/** Gemini request (responseMimeType 'application/json' + responseSchema). Show `payload` to the user before sending. */
export function geminiExceptionRequest(payload: MaskedPayload) {
  assertMasked(payload);
  return {
    systemInstruction: [
      'You help an Indian chartered accountant link TDS/TCS deduction rows to the challans (bank deposits) that paid them, for a quarterly e-TDS/TCS statement.',
      'Rules: a challan can only pay tax deducted on or before its date. A challan cannot be used beyond its balance; if it has a section breakup, rows of a section use only that section\'s amount.',
      'Company payees are normally paid under major head 0020, others under 0021; report what was actually deposited (note any mismatch).',
      'Only propose links for rows whose challan is null. Never invent challans. If nothing fits, say so instead of forcing a link.',
      'If a proposal needs a rule to be bent (for example using an excess or duplicate challan to cover a later month), set needsApproval true and explain in plain words.',
      'Return ONLY the JSON asked for.',
    ].join(' '),
    prompt: `Propose challans for the open rows. Data (identifiers removed):\n${JSON.stringify(payload)}`,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        proposals: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          rows: { type: 'ARRAY', items: { type: 'INTEGER' } }, challan: { type: 'INTEGER' },
          needsApproval: { type: 'BOOLEAN' }, explanation: { type: 'STRING' } }, required: ['rows', 'challan', 'explanation'] } },
        unresolved: { type: 'ARRAY', items: { type: 'OBJECT', properties: { rows: { type: 'ARRAY', items: { type: 'INTEGER' } }, explanation: { type: 'STRING' } }, required: ['rows', 'explanation'] } },
      },
      required: ['proposals'],
    },
  };
}

export interface CheckedProposal {
  rows: number[]; challan: number; explanation: string;
  verdict: 'accepted' | 'needs-approval' | 'rejected';
  checks: string[];                                    // what the rules found
}

/** Check Gemini's proposals against the rules. Nothing is applied here. */
export function checkProposals(json: string, challans: ChallanIn[], rows: RowIn[], result: MatchResult): { proposals: CheckedProposal[]; unresolved: { rows: number[]; explanation: string }[]; problems: string[] } {
  let o: { proposals?: unknown; unresolved?: unknown };
  try { o = JSON.parse(json); } catch { return { proposals: [], unresolved: [], problems: ['AI answer was not valid JSON'] }; }
  const list = Array.isArray(o.proposals) ? (o.proposals as { rows: number[]; challan: number; explanation?: string; needsApproval?: boolean }[]) : [];
  const byRow = new Map(rows.map(r => [r.row, r]));
  const byCh = new Map(challans.map(c => [c.no, c]));
  const status = new Map(result.rows.map(r => [r.row, r]));
  const dupChallans = new Set(result.exceptions.filter(e => e.kind === 'duplicate').flatMap(e => e.challans));
  // money still free per challan and per challan+section (after rows already matched or given)
  const free = new Map(result.challans.map(c => [c.no, c.balance]));
  const freeSec = new Map<string, number>();
  for (const c of challans) if (c.breakup) for (const [k, v] of Object.entries(c.breakup)) freeSec.set(`${c.no}|${k}`, v);
  for (const r of result.rows) if (r.challanNo && r.status !== 'exception') {
    const k = `${r.challanNo}|${byRow.get(r.row)?.code}`; if (freeSec.has(k)) freeSec.set(k, freeSec.get(k)! - (byRow.get(r.row)?.tax ?? 0));
  }
  const taken = new Set<number>();
  const out: CheckedProposal[] = [];
  for (const p of list) {
    const checks: string[] = []; let reject = false; let approve = !!p.needsApproval;
    const ids = Array.isArray(p.rows) ? p.rows : [];
    const c = byCh.get(p.challan);
    if (!c) { checks.push(`Challan ${p.challan} does not exist`); reject = true; }
    for (const id of ids) {
      if (!byRow.has(id)) { checks.push(`Row ${id} does not exist`); reject = true; continue; }
      if (status.get(id)?.status !== 'exception') { checks.push(`Row ${id} is already settled by the rules - left as it is`); reject = true; }
      if (taken.has(id)) { checks.push(`Row ${id} is in two proposals`); reject = true; }
    }
    if (!ids.length) { checks.push('No rows given'); reject = true; }
    if (!reject && c) {
      const rs = ids.map(id => byRow.get(id)!);
      const total = r2(rs.reduce((a, r) => a + r.tax, 0));
      const late = rs.filter(r => r.dateDeducted > c.date);
      if (late.length) { checks.push(`Challan dated ${c.date} is before the deduction of row(s) ${late.map(r => r.row).join(', ')} - a challan cannot pay tax deducted after it`); approve = true; }
      if (total > (free.get(c.no) ?? 0) + 0.5) { checks.push(`Rows total Rs ${total} but only Rs ${r2(free.get(c.no) ?? 0)} of challan ${c.no} is free`); reject = true; }
      if (c.breakup) for (const code of new Set(rs.map(r => r.code))) {
        const need = r2(rs.filter(r => r.code === code).reduce((a, r) => a + r.tax, 0));
        const have = freeSec.get(`${c.no}|${code}`);
        if (have === undefined) { checks.push(`Challan ${c.no} has no amount for section ${code}`); approve = true; }
        else if (need > have + 0.5) { checks.push(`Section ${code}: rows need Rs ${need}, challan ${c.no} has Rs ${r2(have)} left for it`); approve = true; }
      }
      const wrongHead = c.majorHead ? rs.filter(r => (payeeType(r.pan) === 'company' ? '0020' : '0021') !== c.majorHead) : [];
      if (wrongHead.length) checks.push(`Major head ${c.majorHead} differs from the payee type for row(s) ${wrongHead.map(r => r.row).join(', ')} - report as deposited (SOP rule 11) and note it`);
      if (dupChallans.has(c.no)) { checks.push(`Challan ${c.no} was flagged as a possible duplicate deposit - using it needs your decision`); approve = true; }
      if (!checks.length) checks.push('Fits: dates, balance and section share all check out');
      if (!reject) { free.set(c.no, (free.get(c.no) ?? 0) - total); for (const r of rs) { const k = `${c.no}|${r.code}`; if (freeSec.has(k)) freeSec.set(k, freeSec.get(k)! - r.tax); } ids.forEach(id => taken.add(id)); }
    }
    out.push({ rows: ids, challan: p.challan, explanation: String(p.explanation ?? ''), verdict: reject ? 'rejected' : approve ? 'needs-approval' : 'accepted', checks });
  }
  const unresolved = Array.isArray(o.unresolved) ? (o.unresolved as { rows: number[]; explanation: string }[]) : [];
  return { proposals: out, unresolved, problems: [] };
}

/**
 * Apply the proposals the user accepted (verdict 'accepted', plus any 'needs-approval' they approved)
 * as typed-in challan numbers, then run the rules again. Returns the new result and the links to write
 * with applyChallanMatches().
 */
export function applyProposals(challans: ChallanIn[], rows: RowIn[], result: MatchResult, approved: CheckedProposal[]) {
  const link = new Map<number, number>();
  for (const r of result.rows) if (r.challanNo && r.status !== 'exception') link.set(r.row, r.challanNo);
  for (const p of approved) if (p.verdict !== 'rejected') for (const id of p.rows) link.set(id, p.challan);
  const again = matchChallans(challans, rows.map(r => ({ ...r, challanNo: link.get(r.row) ?? null })));
  return { result: again, links: again.rows.filter(r => r.challanNo).map(r => ({ row: r.row, challanNo: r.challanNo! })) };
}
