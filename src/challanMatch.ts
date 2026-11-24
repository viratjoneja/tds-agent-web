/**
 * Phase 3 — match deductee/collectee rows to challans by rules, and check the challans.
 *
 * Rules (no AI):
 *  - A row deducted in month M is paid by a challan dated from the 1st of M; due by the 7th of M+1
 *    (30 April for March). Later challans are allowed but late (interest is checked).
 *  - Major head must fit the payee: company PAN (4th letter C) -> 0020, others -> 0021
 *    (only when the challan's major head is given).
 *  - With a section breakup on the challan (e.g. "1023=5000; 1073=180000"), only that section's
 *    share is used; without one, the whole challan tax is available. What this form does not use
 *    stays as balance for other forms (shared challans - e.g. TCS paid with TDS).
 *  - Within 50 paise counts as rounding (v2.1: a challan is never used beyond its limit, not even by Re 1).
 * Month plan (v1.5, first): each challan is tied to the month it pays - a challan with no interest
 *  to the earliest month it is on time for; a challan with interest to the month it is late for
 *  (unique, and the interest must fit 1.5% a month on at most the challan amount). Same-date pairs
 *  with no major head: the smaller is taken as 0020 when the month has company and other payees.
 *  A month's rows (per major head) go to its challan; rows that do not fit are split off to other
 *  challans with money left (top-up challans first). Section breakups only reserve the share of
 *  sections this return does not have (e.g. 1002 salary); otherwise a difference is a note.
 * Strict limit (v2.1): the money of a challan this return may use is
 *    its tax - "Used by other forms" (what the other return, e.g. 24Q salary, claims from it), if given;
 *    else its tax - the receipt's share for sections this return has no rows for (e.g. 1002 salary);
 *    else the whole tax - and then, if money is left over, the tool asks (split-unknown) instead of
 *    assuming the challan pays only this return. The limit is never exceeded: money kept for another
 *    return is never borrowed. Rows that do not fit are a decision, with a hint where the split may be wrong.
 *  Overflow rows go to challans of the same major head first - top-up challans (they carry the interest)
 *  before other monthly challans - and to the other major head only as a last resort (SOP rule 11, noted).
 * Never decided here (returned as exceptions for a person, or for the Phase 4 AI to propose):
 *  rows larger than any challan, a challan dated before the month of deduction, possible duplicate
 *  challans, a typed-in challan that does not fit.
 *
 * New module — does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import type { Form, Ymd } from './protean.ts';
import { makeTemplateWithSection } from './sectionCodes.ts';

export const MAJOR_HEAD_COLUMN = 'Major head (0020 company / 0021 non-company)';
export const BREAKUP_COLUMN = 'Section breakup (code=amount; ...)';
export const OTHER_FORMS_COLUMN = 'Used by other forms (e.g. 24Q salary)';

export interface ChallanIn {
  no: number; bsr: string; serial: string; date: Ymd;
  tax: number; interest: number; fee: number; others: number;
  majorHead: string;                          // '0020' | '0021' | '' (not given)
  breakup: Record<string, number> | null;     // section code -> tax, if given
  otherForms?: number | null;                 // amount of this challan claimed by other returns (e.g. 24Q), if known
}
export interface RowIn {
  row: number; pan: string; name: string; code: string; dateDeducted: Ymd; tax: number;
  challanNo: number | null;                   // typed in the workbook, if any
}
export interface RowMatch { row: number; challanNo: number | null; status: 'given' | 'matched' | 'exception'; reason: string }
export interface ChallanUse {
  no: number; tax: number; usedHere: number; balance: number;
  forThisReturn: number;                       // the limit for this return (tax less money kept for other returns)
  left: number;                                // forThisReturn - usedHere
  limitFrom: 'other-forms' | 'breakup' | 'whole';
  interestPaid: number; interestDue: number; notes: string[];
}
export interface MatchException {
  kind: 'too-large' | 'no-challan' | 'duplicate' | 'given-mismatch' | 'interest-short' | 'over-limit' | 'split-unknown';
  rows: number[]; challans: number[]; message: string;
}
export interface MatchResult { rows: RowMatch[]; challans: ChallanUse[]; exceptions: MatchException[] }

// ---------------------------------------------------------------- dates and money
const parts = (d: Ymd) => d.split('-').map(Number) as [number, number, number];
const monthKey = (d: Ymd) => d.slice(0, 7);
export function dueDate(deducted: Ymd): Ymd {
  const [y, m] = parts(deducted);
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}
/** Months for interest on late deposit: from the month of deduction to the month of payment, part months counting as whole. */
export function lateMonths(deducted: Ymd, paid: Ymd): number {
  if (paid <= dueDate(deducted)) return 0;
  const [y1, m1] = parts(deducted), [y2, m2] = parts(paid);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}
const majorHeadFor = (pan: string) => (/^[A-Z]{3}C[A-Z]\d{4}[A-Z]$/.test(pan) ? '0020' : /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? '0021' : '');
const r2 = (x: number) => Math.round(x * 100) / 100;
const inr = (x: number) => x.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export function parseBreakup(text: unknown): Record<string, number> | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const out: Record<string, number> = {};
  for (const part of t.split(/[;,\n]+/)) {
    const m = part.trim().match(/^(\d{4})\s*[=:]\s*([\d.]+)$/);
    if (!m) throw new Error(`Section breakup "${part.trim()}" should look like 1023=5000`);
    out[m[1]] = (out[m[1]] ?? 0) + Number(m[2]);
  }
  return out;
}

// ---------------------------------------------------------------- matching
export function matchChallans(challansIn: ChallanIn[], rows: RowIn[]): MatchResult {
  // with "Used by other forms" given, that figure is the limit; the receipt's section split no longer restricts the rows
  const challans = challansIn.map(c => (c.otherForms !== null && c.otherForms !== undefined && Number.isFinite(c.otherForms) && c.breakup ? { ...c, breakup: null } : c));
  const used = new Map<string, number>();                       // `${challan}|${code or *}` -> amount used
  const capKey = (c: ChallanIn, code: string) => `${c.no}|${c.breakup ? code : '*'}`;
  const capacity = (c: ChallanIn, code: string) =>
    Math.min((c.breakup && code !== '*' ? (c.breakup[code] ?? 0) : c.tax) - (used.get(capKey(c, code)) ?? 0), free(c));
  const usedTotal = new Map<number, number>();
  const use = (c: ChallanIn, code: string, amt: number) => {
    used.set(capKey(c, code), (used.get(capKey(c, code)) ?? 0) + amt);
    usedTotal.set(c.no, (usedTotal.get(c.no) ?? 0) + amt);
  };
  // money of a challan this return may use (v2.1 strict limit): its tax less what other returns use,
  // else less the breakup share of sections this return has no rows for, else the whole tax
  const codesHere = new Set(rows.map(r => r.code));
  const hasOther = (c: ChallanIn) => c.otherForms !== null && c.otherForms !== undefined && Number.isFinite(c.otherForms);
  const reserved = (c: ChallanIn) => (hasOther(c) ? c.otherForms! : c.breakup ? Object.entries(c.breakup).filter(([k]) => !codesHere.has(k)).reduce((a, [, v]) => a + v, 0) : 0);
  const limitOf = (c: ChallanIn) => r2(Math.max(0, c.tax - reserved(c)));
  const free = (c: ChallanIn) => r2(limitOf(c) - (usedTotal.get(c.no) ?? 0));
  const byNo = new Map(challans.map(c => [c.no, c]));
  const out: RowMatch[] = [];
  const exceptions: MatchException[] = [];

  // possible duplicates: same date, same tax, same major head
  const seen = new Map<string, number[]>();
  for (const c of challans) {
    const k = `${c.date}|${c.tax}|${c.majorHead}`;
    seen.set(k, [...(seen.get(k) ?? []), c.no]);
  }
  for (const [k, nos] of seen) if (nos.length > 1)
    exceptions.push({ kind: 'duplicate', rows: [], challans: nos, message: `Challans ${nos.join(' and ')} have the same date (${k.split('|')[0]}) and amount (Rs ${inr(Number(k.split('|')[1]))}) - possible duplicate payment. Decide which one this return uses; the other may be adjusted later (needs approval).` });

  // 1. rows with a challan typed in: check, then reserve
  for (const r of rows.filter(r => r.challanNo !== null)) {
    const c = byNo.get(r.challanNo!);
    const problems: string[] = [];
    if (!c) problems.push(`challan #${r.challanNo} is not on the Challans sheet`);
    else {
      if (c.date < `${monthKey(r.dateDeducted)}-01`) problems.push(`challan dated ${c.date} is before the month of deduction (${r.dateDeducted})`);
      const mh = majorHeadFor(r.pan);
      if (c.majorHead && mh && c.majorHead !== mh) problems.push(`payee needs major head ${mh}, challan is ${c.majorHead}`);
      if (c.breakup && !(r.code in c.breakup)) problems.push(`challan breakup has no section ${r.code}`);
    }
    if (problems.length) {
      out.push({ row: r.row, challanNo: r.challanNo, status: 'exception', reason: problems.join('; ') });
      exceptions.push({ kind: 'given-mismatch', rows: [r.row], challans: c ? [c.no] : [], message: `Row ${r.row} (${r.name}): ${problems.join('; ')}.` });
    } else {
      use(c!, r.code, r.tax);
      out.push({ row: r.row, challanNo: c!.no, status: 'given', reason: `challan #${c!.no} as typed in the workbook` });
    }
  }

  const describe = (month: string, mh: string, code: string, grp: RowIn[], total: number) =>
    `${grp.length} row(s) deducted in ${month}${mh ? `, payee major head ${mh}` : ''}${code !== '*' ? `, section ${code}` : ''} (Rs ${inr(total)})`;
  const headNote = (c: ChallanIn, mh: string) => (c.majorHead && mh && c.majorHead !== mh
    ? `; challan is major head ${c.majorHead} although the payee needs ${mh} - reported as deposited (SOP rule 11), check` : '');
  const lateNote = (c: ChallanIn, month: string) => (c.date > dueDate(`${month}-01`) ? `; paid after the due date ${dueDate(`${month}-01`)}` : '');

  // 1b. MONTH PLAN (v1.5): tie challans to the month they pay, then fill and split.
  const monthsWithRows = [...new Set(rows.map(r => monthKey(r.dateDeducted)))].sort();
  const tagOf = new Map<number, string>();           // challan -> month it pays
  for (const c of challans) {
    const possible = monthsWithRows.filter(m => c.date >= `${m}-01`);
    if (c.interest > 0) {
      const late = possible.filter(m => c.date > dueDate(`${m}-01`) && c.interest / (0.015 * lateMonths(`${m}-01`, c.date)) <= c.tax * 1.02 + 1);
      if (late.length === 1) tagOf.set(c.no, late[0]);
    } else {
      const onTime = possible.filter(m => c.date <= dueDate(`${m}-01`));
      if (onTime.length) tagOf.set(c.no, onTime[0]);
    }
  }
  // same-date pairs without a major head: the smaller one is the company (0020) challan
  const headOf = new Map<number, string>(challans.map(c => [c.no, c.majorHead]));
  const headNoteOf = new Map<number, string>();
  for (const date of new Set(challans.map(c => c.date))) {
    const pair = challans.filter(c => c.date === date);
    const m = tagOf.get(pair[0]?.no);
    if (pair.length !== 2 || pair.some(c => c.majorHead) || !m || tagOf.get(pair[1].no) !== m || pair[0].tax === pair[1].tax) continue;
    const mr = rows.filter(r => monthKey(r.dateDeducted) === m);
    if (!mr.some(r => majorHeadFor(r.pan) === '0020') || !mr.some(r => majorHeadFor(r.pan) === '0021')) continue;
    const [small, big] = [...pair].sort((a, b) => a.tax - b.tax);
    headOf.set(small.no, '0020'); headOf.set(big.no, '0021');
    for (const c of pair) headNoteOf.set(c.no, `; major head not given - #${small.no} (the smaller of the two challans of ${date}) taken as 0020 and #${big.no} as 0021, check with the challan receipts`);
  }
  const planned = (r: RowIn) => {
    const m = monthKey(r.dateDeducted), mh = majorHeadFor(r.pan);
    const mine = challans.filter(c => tagOf.get(c.no) === m && c.date >= r.dateDeducted);
    const sameHead = mine.filter(c => headOf.get(c.no) === mh);
    if (sameHead.length === 1) return sameHead[0];
    if (!sameHead.length && mine.length === 1 && !headOf.get(mine[0].no)) return mine[0];
    return undefined;
  };
  {
    const g = new Map<number, RowIn[]>();
    for (const r of rows.filter(r => r.challanNo === null)) { const c = planned(r); if (c) g.set(c.no, [...(g.get(c.no) ?? []), r]); }
    const overflow: { r: RowIn; home: ChallanIn }[] = [];
    for (const [no, grp] of [...g.entries()].sort(([a], [b]) => a - b)) {
      const c = byNo.get(no)!;
      const total = r2(grp.reduce((a, r) => a + r.tax, 0));
      const fits = total <= free(c) + 0.5;
      // if not all fit, keep the most rows by value: largest first while they fit, the rest overflow
      const take = fits ? grp : [];
      if (!fits) { let left = free(c); for (const r of [...grp].sort((a, b) => b.tax - a.tax)) if (r.tax <= left + 0.5) { take.push(r); left = r2(left - r.tax); } }
      const m = monthKey(grp[0].dateDeducted);
      for (const r of take) {
        use(c, r.code, r.tax);
        out.push({ row: r.row, challanNo: c.no, status: 'matched',
          reason: `deducted in ${m} -> challan #${c.no} of ${c.date}, the challan for ${m}${c.interest > 0 ? ' (paid late, with interest)' : ''}${headOf.get(c.no) ? `, major head ${headOf.get(c.no)}` : ''}${headNoteOf.get(c.no) ?? ''}${headNote({ ...c, majorHead: headOf.get(c.no) ?? '' }, majorHeadFor(r.pan))}${lateNote(c, m)}` });
      }
      for (const r of grp) if (!take.includes(r)) overflow.push({ r, home: c });
    }
    // split: overflow rows to other challans with money left for this return, dated after the deduction -
    // same major head first (top-ups, which carry the interest, then by date); the other head only as a
    // last resort (SOP rule 11, noted). Never beyond a challan's limit for this return.
    for (const { r, home } of overflow.sort((a, b) => b.r.tax - a.r.tax)) {
      const mh = majorHeadFor(r.pan);
      const sameHead = (c: ChallanIn) => !headOf.get(c.no) || !mh || headOf.get(c.no) === mh;
      const cands = challans.filter(c => c.no !== home.no && c.date >= r.dateDeducted && free(c) + 0.5 >= r.tax)
        .sort((a, b) => (sameHead(a) ? 0 : 1) - (sameHead(b) ? 0 : 1) || (tagOf.has(a.no) ? 1 : 0) - (tagOf.has(b.no) ? 1 : 0) || a.date.localeCompare(b.date));
      const c = cands[0];
      if (!c) continue;                                  // left for the passes / exceptions below
      use(c, r.code, r.tax);
      const m = monthKey(r.dateDeducted);
      out.push({ row: r.row, challanNo: c.no, status: 'matched',
        reason: `deducted in ${m}; the challan for ${m} (#${home.no}) has no room left, so split off to challan #${c.no} of ${c.date} (Rs ${inr(free(c))} left there)${headNote({ ...c, majorHead: headOf.get(c.no) ?? '' }, mh)}${lateNote(c, m)}` });
    }
  }

  // 2. the rest. Passes, most certain first:
  //    a. with a section breakup on the challans: by month + section, using that section's share
  //    b. without: a challan whose amount EXACTLY equals a section's rows for the month
  //    c. a challan whose amount exactly equals all of the month's rows (per major head)
  //    d. only ONE challan can take the month's rows -> that one (balance noted)
  //    otherwise: an exception (ambiguous / too large / no challan) - never a guess.
  //    Major head: the payee's first; if no challan fits, the other one (SOP rule 11: tax deposited
  //    under the other head is reported as deposited), with a note.
  const anyBreakup = challans.some(c => c.breakup);
  const pending = () => rows.filter(r => r.challanNo === null && !out.some(m => m.row === r.row));
  const groupBy = (rs: RowIn[], withCode: boolean) => {
    const g = new Map<string, RowIn[]>();
    for (const r of rs) { const k = `${monthKey(r.dateDeducted)}|${majorHeadFor(r.pan)}|${withCode ? r.code : '*'}`; g.set(k, [...(g.get(k) ?? []), r]); }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  // A challan can only pay tax already deducted: its date must be on/after the LATEST deduction in the group.
  let groupFrom = '';
  const candidates = (month: string, code: string, mhWanted: string, otherHead: boolean) => {
    const due = dueDate(`${month}-01`);
    return challans.filter(c => c.date >= (groupFrom || `${month}-01`))
      .filter(c => !c.majorHead || !mhWanted || (otherHead ? c.majorHead !== mhWanted : c.majorHead === mhWanted))
      .filter(c => code === '*' || !c.breakup || (c.breakup[code] ?? 0) > 0)
      .sort((a, b) => (a.date <= due) === (b.date <= due) ? a.date.localeCompare(b.date) : (a.date <= due ? -1 : 1));
  };

  // A pass groups the pending rows (by month, optionally section, optionally payee major head) and
  // either looks for an EXACT amount (challan, or its section share) or the EARLIEST challan that
  // can take the rows. Earliest = the first deposit after the deduction; a tie on that date is
  // ambiguous and is never decided here.
  const runPass = (withCode: boolean, withHead: boolean, mode: 'exact' | 'fit') => {
    const g = new Map<string, RowIn[]>();
    for (const r of pending()) {
      const k = `${monthKey(r.dateDeducted)}|${withHead ? majorHeadFor(r.pan) : ''}|${withCode ? r.code : '*'}`;
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    for (const [k, grp] of [...g.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [month, mh, code] = k.split('|');
      const total = r2(grp.reduce((a, r) => a + r.tax, 0));
      groupFrom = grp.map(r => r.dateDeducted).sort().at(-1)!;
      for (const other of withHead ? [false, true] : [false]) {
        // a challan with a breakup can only serve a single-section group, from that section's share
        const cands = candidates(month, code, mh, other).filter(c => code !== '*' || !c.breakup);
        const cap = (c: ChallanIn) => capacity(c, c.breakup ? code : '*');
        let pick: ChallanIn | undefined, how = '';
        if (mode === 'exact') {
          const exact = cands.filter(c => Math.abs(cap(c) - total) <= 0.5);
          const first = exact.filter(c => c.date === exact[0]?.date);
          if (first.length === 1) { pick = first[0]; how = pick.breakup ? `its section ${code} share equals these rows exactly` : 'challan amount equals these rows exactly'; }
        } else {
          const fits = cands.filter(c => cap(c) + 0.5 >= total).sort((a, b) => a.date.localeCompare(b.date));
          const first = fits.filter(c => c.date === fits[0]?.date);
          if (first.length === 1) { pick = first[0]; how = `first challan after the deduction that can take these rows; Rs ${inr(r2(cap(pick) - total))} left${pick.breakup ? ` in its section ${code} share` : ''} - balance for other forms or rows`; }
          else if (first.length > 1) {
            const msg = `${describe(month, mh, code, grp, total)}: challans ${first.map(c => '#' + c.no).join(', ')} (same date ${first[0].date}) could each take these rows. Add the section breakup / major head on the challans, or choose (needs a decision).`;
            exceptions.push({ kind: 'too-large', rows: grp.map(r => r.row), challans: first.map(c => c.no), message: msg });
            for (const r of grp) out.push({ row: r.row, challanNo: null, status: 'exception', reason: msg });
            break;
          }
        }
        if (pick) {
          for (const r of grp) {
            const rmh = majorHeadFor(r.pan);
            use(pick, pick.breakup ? r.code : '*', r.tax);
            out.push({ row: r.row, challanNo: pick.no, status: 'matched',
              reason: `${describe(month, mh, code, grp, total)} -> challan #${pick.no} of ${pick.date}; ${how}${headNote(pick, rmh)}${lateNote(pick, month)}` });
          }
          break;
        }
      }
    }
  };
  runPass(true, false, 'exact');      // a section's rows for the month = the challan (or its section share)
  runPass(true, true, 'exact');       // ... per payee major head
  runPass(false, false, 'exact');     // all the month's rows = the challan
  runPass(false, true, 'exact');      // ... per payee major head
  runPass(true, true, 'fit');         // earliest challan (section share) that can take a section's rows
  runPass(false, true, 'fit');        // earliest challan that can take the month's rows

  // v2.1: money kept for another return (24Q salary etc.) is never borrowed. Where rows are left over,
  // the message below points at challans whose kept share may be wrong (receipt split vs the other return).
  const keptHint = (from: string) => {
    const ks = challans.filter(c => c.date >= from && reserved(c) > 1);
    return ks.length ? ` Money kept for other returns, not used: ${ks.map(c => `#${c.no} Rs ${inr(reserved(c))}${hasOther(c) ? ' (used by other forms, as entered)' : ` (receipt share for section ${Object.keys(c.breakup!).filter(k => !codesHere.has(k)).join(', ')})`}`).join('; ')}. If the other return (e.g. 24Q) used less than that, enter what it used under "Used by other forms" for that challan.` : '';
  };

  // whatever is left: no challan, or too large for any one challan
  for (const [k, grp] of groupBy(pending(), anyBreakup)) {
    const [month, mh, code] = k.split('|');
    const total = r2(grp.reduce((a, r) => a + r.tax, 0));
    groupFrom = grp.map(r => r.dateDeducted).sort().at(-1)!;
    const cands = [...candidates(month, code, mh, false), ...candidates(month, code, mh, true)];
    const msg = cands.length
      ? `${describe(month, mh, code, grp, total)}: no single challan has enough left for this return (most left: Rs ${inr(r2(Math.max(0, ...cands.map(c => free(c)))))}). A short deposit, a challan missing from the sheet, or a wrong split with another return - needs a decision.${keptHint(groupFrom)}`
      : `${describe(month, mh, code, grp, total)}: no challan dated on or after ${groupFrom}${code !== '*' ? ` covering section ${code}` : ''}.Add the challan, or decide how this is to be paid (needs a decision).`;
    exceptions.push({ kind: cands.length ? 'too-large' : 'no-challan', rows: grp.map(r => r.row), challans: [...new Set(cands.map(c => c.no))], message: msg });
    for (const r of grp) out.push({ row: r.row, challanNo: null, status: 'exception', reason: msg });
  }

  // 3. per-challan summary: use, balance, interest on late deposit
  const rowByNo = new Map(rows.map(r => [r.row, r]));
  const useSummary: ChallanUse[] = challans.map(c => {
    const mine = out.filter(m => m.challanNo === c.no && m.status !== 'exception').map(m => rowByNo.get(m.row)!);
    const usedHere = r2(mine.reduce((a, r) => a + r.tax, 0));
    const interestDue = Math.round(mine.reduce((a, r) => a + r.tax * 0.015 * lateMonths(r.dateDeducted, c.date), 0));
    const notes: string[] = [];
    const balance = r2(c.tax - usedHere);
    const limit = limitOf(c), left = r2(limit - usedHere);
    if (!mine.length) notes.push('not used by this return (may belong to another form or quarter)');
    else if (left > 1) notes.push(`Rs ${inr(left)} of this return's share not used - must be used by another form, or is excess`);
    if (reserved(c) > 1) notes.push(hasOther(c) ? `Rs ${inr(reserved(c))} used by other forms (as entered) - kept out` : `Rs ${inr(reserved(c))} kept for section ${Object.keys(c.breakup!).filter(k => !codesHere.has(k)).join(', ')} (another return, per the receipt)`);
    if (left < -0.5) {
      notes.push(`this return uses Rs ${inr(usedHere)}, more than the Rs ${inr(limit)} it may use`);
      exceptions.push({ kind: 'over-limit', rows: mine.map(r => r.row), challans: [c.no], message: `Challan #${c.no} of ${c.date}: rows linked to it total Rs ${inr(usedHere)}, but only Rs ${inr(limit)} of it is for this return (Rs ${inr(reserved(c))} is for other returns). Move rows to another challan, or correct "Used by other forms".` });
    }
    if (c.breakup && mine.length && !hasOther(c)) {
      const diff = Object.entries(c.breakup).filter(([k]) => codesHere.has(k)).map(([k, v]) => [k, r2(mine.filter(r => r.code === k).reduce((a, r) => a + r.tax, 0) - v)] as const).filter(([, d]) => Math.abs(d) > 1);
      if (diff.length) notes.push(`rows by section differ from the challan's section breakup (${diff.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${inr(d)}`).join(', ')}) - allowed, but check`);
    }
    if (c.breakup) {
      const bsum = r2(Object.values(c.breakup).reduce((a, b) => a + b, 0));
      if (Math.abs(bsum - c.tax) > 1) notes.push(`section breakup adds to Rs ${inr(bsum)}, challan tax is Rs ${inr(c.tax)}`);
    }
    if (interestDue > c.interest + 1) {
      notes.push(`late deposit: interest due about Rs ${inr(interestDue)}, paid Rs ${inr(c.interest)}`);
      exceptions.push({ kind: 'interest-short', rows: mine.map(r => r.row), challans: [c.no], message: `Challan #${c.no} of ${c.date}: interest on late deposit about Rs ${inr(interestDue)} (1.5% a month or part), challan shows Rs ${inr(c.interest)}. Pay the shortfall or check the dates.` });
    }
    const limitFrom = hasOther(c) ? 'other-forms' as const : c.breakup ? 'breakup' as const : 'whole' as const;
    return { no: c.no, tax: c.tax, usedHere, balance, forThisReturn: limit, left, limitFrom, interestPaid: c.interest, interestDue, notes };
  });
  // split not known: a challan used here with money left over and nothing saying whether another return uses it
  const unknown = useSummary.filter(u => u.usedHere > 0 && u.limitFrom === 'whole' && u.left > 1000);
  if (unknown.length) exceptions.push({ kind: 'split-unknown', rows: [], challans: unknown.map(u => u.no),
    message: `Challan(s) ${unknown.map(u => `#${u.no} (Rs ${inr(u.left)} left)`).join(', ')}: nothing shows whether another return (e.g. 24Q salary) also uses ${unknown.length > 1 ? 'these challans' : 'this challan'}, so the split may be wrong. Upload the challan receipt PDFs or the other return's sheet, or enter "Used by other forms" (0 if none).` });
  out.sort((a, b) => a.row - b.row);
  return { rows: out, challans: useSummary, exceptions };
}

// ---------------------------------------------------------------- workbook helpers
/** Blank input workbook with the Phase 2 section column and the Phase 3 challan columns. */
export function makeTemplateFull(form: Form): Uint8Array {
  const wb = XLSX.read(makeTemplateWithSection(form), { type: 'array' });
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Challans'], { header: 1 })[0] ?? []) as string[];
  wb.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([[...hdr, MAJOR_HEAD_COLUMN, BREAKUP_COLUMN, OTHER_FORMS_COLUMN]]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

const serialToYmd = (v: unknown): Ymd => {
  if (typeof v === 'number') { const d = new Date(Math.floor(v) * 86400000 + Date.UTC(1899, 11, 30)); return d.toISOString().slice(0, 10); }
  const s = String(v ?? '').trim(); const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  throw new Error(`Cannot read date "${s}"`);
};
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(String(v).replace(/,/g, '')));

/** Read challans and rows for matching. Section codes must already be filled (Phase 2 applySections). */
/**
 * Tax column check (v1.5): Tax should be about Amount x Rate % / 100. A Tax equal to Amount x Rate
 * (the /100 left out of a formula) makes every row 100 times too big - that stops matching.
 * Other differences over Rs 1 are only warnings (lower deduction, rounding to rupees, short deduction).
 */
export function checkTaxColumn(rows: { row: number; amount: number; rate: number; tax: number }[]): { problems: string[]; warnings: string[] } {
  const hundred = rows.filter(r => r.amount > 0 && r.rate > 0 && r.tax > 0 && Math.abs(r.tax - r.amount * r.rate) <= Math.max(1, r.amount * r.rate * 0.001));
  const other = rows.filter(r => r.amount > 0 && r.rate > 0 && !hundred.includes(r) && Math.abs(r.tax - r.amount * r.rate / 100) > 1);
  const problems: string[] = [];
  if (hundred.length) {
    const e = hundred[0];
    problems.push(`Tax looks like Amount x Rate % without dividing by 100 on ${hundred.length} row(s) - e.g. row ${e.row}: ${inr(e.amount)} x ${e.rate} = ${inr(e.tax)}, but the tax should be about ${inr(r2(e.amount * e.rate / 100))}. Correct the Tax column (if it is a formula, e.g. =G2*H2/100) and upload again. Put the tax actually deducted, as in the books.`);
  }
  const warnings = other.slice(0, 20).map(r => `Row ${r.row}: Tax ${inr(r.tax)} differs from Amount x Rate % (${inr(r2(r.amount * r.rate / 100))}) - fine if it is the tax actually deducted (lower deduction, rounding); otherwise correct it`);
  if (other.length > 20) warnings.push(`... and ${other.length - 20} more row(s) like this`);
  return { problems, warnings };
}

export function readForMatching(data: ArrayBuffer | Uint8Array): { challans: ChallanIn[]; rows: RowIn[]; problems: string[]; warnings: string[] } {
  const wb = XLSX.read(data, { type: 'array' });
  const grid = (sh: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sh], { header: 1, raw: true, defval: null });
  const problems: string[] = [];
  const cg = grid('Challans'), ch = (cg[0] ?? []).map(v => String(v ?? '').trim());
  const ci = (h: string) => ch.indexOf(h);
  const challans: ChallanIn[] = [];
  cg.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    try {
      challans.push({
        no: Number(r[ci('Challan #')]), bsr: String(r[ci('BSR code')] ?? '').padStart(7, '0'),
        serial: String(r[ci('Challan serial no.')] ?? '').padStart(5, '0'), date: serialToYmd(r[ci('Date deposited')]),
        tax: num(r[ci('Tax')]), interest: num(r[ci('Interest')]), fee: num(r[ci('Fee')]), others: num(r[ci('Others')]),
        majorHead: ci(MAJOR_HEAD_COLUMN) >= 0 ? String(r[ci(MAJOR_HEAD_COLUMN)] ?? '').trim().padStart(4, '0').replace(/^0000$/, '') : '',
        breakup: ci(BREAKUP_COLUMN) >= 0 ? parseBreakup(r[ci(BREAKUP_COLUMN)]) : null,
        otherForms: ci(OTHER_FORMS_COLUMN) >= 0 && r[ci(OTHER_FORMS_COLUMN)] !== null && r[ci(OTHER_FORMS_COLUMN)] !== '' ? num(r[ci(OTHER_FORMS_COLUMN)]) : null,
      });
    } catch (e) { problems.push(`Challans row ${k + 2}: ${(e as Error).message}`); }
  });
  const dg = grid('Deductees'), dh = (dg[0] ?? []).map(v => String(v ?? '').trim());
  const di = (h: string) => dh.indexOf(h);
  const rows: RowIn[] = [];
  dg.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    const code = String(r[di('Section code')] ?? '').trim();
    if (!/^\d{4}$/.test(code)) { problems.push(`Deductees row ${k + 2}: section code missing - work out section codes first`); return; }
    try {
      const cn = r[di('Challan #')];
      rows.push({ row: k + 2, pan: String(r[di('PAN')] ?? '').trim().toUpperCase(), name: String(r[di('Name')] ?? '').trim(), code,
        dateDeducted: serialToYmd(r[di('Date deducted')]), tax: num(r[di('Tax')]),
        challanNo: cn === null || cn === '' ? null : Number(cn) });
    } catch (e) { problems.push(`Deductees row ${k + 2}: ${(e as Error).message}`); }
  });
  const amt = di('Amount'), rate = di('Rate %');
  const tc = amt >= 0 && rate >= 0 ? checkTaxColumn(dg.slice(1).map((r, k) => ({ row: k + 2, amount: num(r[amt]), rate: num(r[rate]), tax: num(r[di('Tax')]) })).filter(r => r.amount || r.tax))
    : { problems: [], warnings: [] };
  return { challans, rows, problems: [...tc.problems, ...problems], warnings: tc.warnings };
}

// ---------------------------------------------------------------- the other return's use of each challan (v2.1)
export interface OtherFormUse { bsr: string; date: Ymd; serial: string; amount: number }
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const keyOf = (u: { bsr: string; date: Ymd; serial: string }) => `${u.bsr.padStart(7, '0')}|${u.date}|${String(Number(u.serial)).padStart(5, '0')}`;

/**
 * How much of each challan another return of the same quarter claims, read from that return's sheet:
 *  - a Compu-TDS 24Q / 26Q / 27Q import sheet: rows with "Total Tax deposited" and "Challan Detail"
 *    like "1  (1234567, 07-Sep-2026, 00001)" (e.g. the 24Q sheet's Challan_adjustment), or
 *  - this tool's input workbook for the other form (Challans + Deductees with "Challan #" filled).
 * Amounts are summed per challan (BSR, date, serial).
 */
export function readOtherFormUse(data: ArrayBuffer | Uint8Array): { uses: OtherFormUse[]; problems: string[] } {
  const wb = XLSX.read(data, { type: 'array' });
  const sums = new Map<string, OtherFormUse>();
  const add = (u: OtherFormUse) => { const k = keyOf(u); const o = sums.get(k); if (o) o.amount = r2(o.amount + u.amount); else sums.set(k, { ...u, bsr: u.bsr.padStart(7, '0'), serial: String(Number(u.serial)).padStart(5, '0') }); };
  // a. Compu-TDS sheets
  for (const sn of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, raw: true, defval: null });
    const h = g.findIndex(r => r.some(v => /challan detail/i.test(String(v ?? ''))) && r.some(v => /tax deposited/i.test(String(v ?? ''))));
    if (h < 0) continue;
    const cDet = g[h].findIndex(v => /challan detail/i.test(String(v ?? '')));
    const cAmt = g[h].findIndex(v => /total tax deposited/i.test(String(v ?? ''))) >= 0 ? g[h].findIndex(v => /total tax deposited/i.test(String(v ?? ''))) : g[h].findIndex(v => /tax deposited/i.test(String(v ?? '')));
    for (const r of g.slice(h + 1)) {
      const m = String(r[cDet] ?? '').match(/\(\s*(\d{7})\s*,\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s*,\s*(\d{1,5})\s*\)/);
      if (!m || !MON[m[3].toLowerCase()]) continue;
      add({ bsr: m[1], date: `${m[4]}-${MON[m[3].toLowerCase()]}-${m[2].padStart(2, '0')}`, serial: m[5], amount: num(r[cAmt]) });
    }
  }
  if (sums.size) return { uses: [...sums.values()], problems: [] };
  // b. this tool's input workbook for the other form
  if (wb.Sheets['Challans'] && wb.Sheets['Deductees']) {
    try {
      const m = readForMatching(data);
      const byNo = new Map(m.challans.map(c => [c.no, c]));
      const dg = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Deductees'], { header: 1, raw: true, defval: null });
      const dh = (dg[0] ?? []).map(v => String(v ?? '').trim());
      const cNo = dh.indexOf('Challan #'), cTax = dh.indexOf('Tax'), cDep = dh.indexOf('Tax deposited (blank = Tax)');
      for (const r of dg.slice(1)) {
        const c = byNo.get(Number(r[cNo]));
        if (!c) continue;
        const dep = cDep >= 0 && r[cDep] !== null && r[cDep] !== '' ? num(r[cDep]) : num(r[cTax]);
        add({ bsr: c.bsr, date: c.date, serial: c.serial, amount: dep });
      }
    } catch (e) { return { uses: [], problems: [(e as Error).message] }; }
    if (sums.size) return { uses: [...sums.values()], problems: [] };
  }
  return { uses: [], problems: ['No challan use found - expected a Compu-TDS sheet with "Challan Detail" and "Total Tax deposited" columns (e.g. the 24Q Challan_adjustment sheet), or this tool\'s input workbook for the other form with "Challan #" filled'] };
}

/**
 * Write "Used by other forms" on the Challans sheet: the given amounts (summed over the other returns
 * passed together) for matching challans; challans not mentioned are left as they are.
 */
export function setOtherForms(data: ArrayBuffer | Uint8Array, uses: OtherFormUse[]): { bytes: Uint8Array; matched: { no: number; amount: number }[]; notOnSheet: OtherFormUse[] } {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Challans'];
  const g = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const hdr = (g[0] ?? []).map(v => String(v ?? '').trim());
  let col = hdr.indexOf(OTHER_FORMS_COLUMN);
  if (col < 0) { col = hdr.length; ws[XLSX.utils.encode_cell({ r: 0, c: col })] = { t: 's', v: OTHER_FORMS_COLUMN };
    const rg = XLSX.utils.decode_range(ws['!ref']!); rg.e.c = Math.max(rg.e.c, col); ws['!ref'] = XLSX.utils.encode_range(rg); }
  const total = new Map<string, number>();
  for (const u of uses) total.set(keyOf(u), r2((total.get(keyOf(u)) ?? 0) + u.amount));
  const challans = readForMatching(data).challans;
  const matched: { no: number; amount: number }[] = [];
  const hit = new Set<string>();
  challans.forEach(c => {
    const k = keyOf(c), amt = total.get(k);
    if (amt === undefined) return;
    hit.add(k);
    const r = g.findIndex((row, i) => i > 0 && Number(row[hdr.indexOf('Challan #')]) === c.no);
    if (r < 0) return;
    ws[XLSX.utils.encode_cell({ r, c: col })] = { t: 'n', v: amt };
    matched.push({ no: c.no, amount: amt });
  });
  return { bytes: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), matched, notOnSheet: uses.filter(u => !hit.has(keyOf(u))) };
}

/** Set (or clear, with null) "Used by other forms" for one challan. */
export function setOtherFormsFor(data: ArrayBuffer | Uint8Array, challanNo: number, amount: number | null): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Challans'];
  const g = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const hdr = (g[0] ?? []).map(v => String(v ?? '').trim());
  let col = hdr.indexOf(OTHER_FORMS_COLUMN);
  if (col < 0) { col = hdr.length; ws[XLSX.utils.encode_cell({ r: 0, c: col })] = { t: 's', v: OTHER_FORMS_COLUMN };
    const rg = XLSX.utils.decode_range(ws['!ref']!); rg.e.c = Math.max(rg.e.c, col); ws['!ref'] = XLSX.utils.encode_range(rg); }
  const r = g.findIndex((row, i) => i > 0 && Number(row[hdr.indexOf('Challan #')]) === challanNo);
  if (r < 0) throw new Error(`Challan #${challanNo} is not on the Challans sheet`);
  const cell = XLSX.utils.encode_cell({ r, c: col });
  if (amount === null) delete ws[cell]; else ws[cell] = { t: 'n', v: amount };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** Write the matched challan numbers into the Deductees "Challan #" column (approved rows only). */
export function applyChallanMatches(data: ArrayBuffer | Uint8Array, matches: { row: number; challanNo: number }[]): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Deductees'];
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[];
  const c = hdr.indexOf('Challan #');
  for (const { row, challanNo } of matches) ws[XLSX.utils.encode_cell({ r: row - 1, c })] = { t: 'n', v: challanNo };
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
