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
 * Set-off rule (v2.2, the firm's rule): every challan needs its split by section - from the challan
 *  receipt, or typed in (a challan without one is flagged split-missing and blocks the return).
 *  The sections that belong to this form (section map) are this return's money, used across
 *  sections, months and top-ups. The share of sections of other forms (e.g. 1002 salary, 1057, 1073)
 *  is used only up to what the user has approved ("Allowed from other returns' share"); when rows are
 *  short, the result lists the challans whose other-return share could cover them (offers) - the
 *  tool never takes it by itself. A challan is never used beyond this limit, not even by Re 1.
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
import { SECTION_MAP, makeTemplateWithSection } from './sectionCodes.ts';

export const MAJOR_HEAD_COLUMN = 'Major head (0020 company / 0021 non-company)';
export const BREAKUP_COLUMN = 'Section breakup (code=amount; ...)';
export const APPROVED_COLUMN = "Allowed from other returns' share (approved)";

export interface ChallanIn {
  no: number; bsr: string; serial: string; date: Ymd;
  tax: number; interest: number; fee: number; others: number;
  majorHead: string;                          // '0020' | '0021' | '' (not given)
  breakup: Record<string, number> | null;     // section code (or THIS / OTHER) -> tax, if given
  approved?: number | null;                   // part of the other returns' share the user allowed this return to use
}
export interface RowIn {
  row: number; pan: string; name: string; code: string; dateDeducted: Ymd; tax: number;
  challanNo: number | null;                   // typed in the workbook, if any
}
export interface RowMatch { row: number; challanNo: number | null; status: 'given' | 'matched' | 'exception'; reason: string }
export interface ChallanUse {
  no: number; tax: number; usedHere: number; balance: number;
  forThisReturn: number;                       // the limit for this return: its own sections + approved
  left: number;                                // forThisReturn - usedHere
  otherShare: number;                          // share of other returns' sections on the split (e.g. 1002 salary)
  otherSections: string[];                     // those sections
  approved: number;                            // part of otherShare allowed for this return (by the user)
  takenFromOther: number;                      // of that, actually used by this return's rows
  limitFrom: 'split' | 'missing';              // split known (receipt or typed) / missing
  pool: number;                                // this return's own sections on the split
  interestPaid: number; interestDue: number; notes: string[];
}
export interface MatchException {
  kind: 'too-large' | 'no-challan' | 'duplicate' | 'given-mismatch' | 'interest-short' | 'over-limit' | 'split-missing';
  rows: number[]; challans: number[]; message: string;
}
/** A challan whose other-return share could cover rows left without a challan - only with the user's approval. */
export interface ShortfallOffer { no: number; available: number; suggest: number; sections: string[]; rows: number }
export interface MatchResult {
  rows: RowMatch[]; challans: ChallanUse[]; exceptions: MatchException[];
  shortTax: number;                            // tax of rows left without a challan
  offers: ShortfallOffer[];
}

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
    const m = part.trim().match(/^(\d{4}|this|other)\s*[=:]\s*([\d.]+)$/i);
    if (!m) throw new Error(`Section breakup "${part.trim()}" should look like 1023=5000 (or this=5000 / other=5000)`);
    const k = /^\d/.test(m[1]) ? m[1] : m[1].toUpperCase();
    out[k] = (out[k] ?? 0) + Number(m[2]);
  }
  return out;
}

/** Breakup as text for the workbook column ("1002=50000; 1023=4000"). */
export const formatBreakup = (b: Record<string, number>) => Object.entries(b).map(([k, v]) => `${k === 'THIS' ? 'this' : k === 'OTHER' ? 'other' : k}=${v}`).join('; ');

// ---------------------------------------------------------------- matching
export function matchChallans(challans: ChallanIn[], rows: RowIn[], opts: { form?: Form } = {}): MatchResult {
  const used = new Map<string, number>();                       // `${challan}|${code}` -> amount used
  const capKey = (c: ChallanIn, code: string) => `${c.no}|${code}`;
  const usedTotal = new Map<number, number>();
  const use = (c: ChallanIn, code: string, amt: number) => {
    used.set(capKey(c, code), (used.get(capKey(c, code)) ?? 0) + amt);
    usedTotal.set(c.no, (usedTotal.get(c.no) ?? 0) + amt);
  };
  // v2.2: this return's money on a challan = the split's sections of this form (any section); the
  // other forms' share only up to what the user approved. No split: the whole tax, for a preview only
  // (the challan is flagged split-missing and the return cannot be built until the split is given).
  const codesHere = new Set(rows.map(r => r.code));
  const thisForm = (k: string) => k === 'THIS' || (k !== 'OTHER' && (opts.form ? (SECTION_MAP[k]?.forms ?? []).includes(opts.form) || codesHere.has(k) : codesHere.has(k)));
  const pool = (c: ChallanIn) => (c.breakup ? r2(Object.entries(c.breakup).filter(([k]) => thisForm(k)).reduce((a, [, v]) => a + v, 0)) : c.tax);
  const otherSections = (c: ChallanIn) => (c.breakup ? Object.keys(c.breakup).filter(k => !thisForm(k)) : []);
  const otherShare = (c: ChallanIn) => (c.breakup ? r2(Math.max(0, c.tax - pool(c))) : 0);
  const approvedOf = (c: ChallanIn) => r2(Math.min(Math.max(0, Number(c.approved) || 0), otherShare(c)));
  const limitOf = (c: ChallanIn) => r2(Math.min(c.tax, pool(c) + approvedOf(c)));
  const reserved = (c: ChallanIn) => r2(c.tax - limitOf(c));
  const free = (c: ChallanIn) => r2(limitOf(c) - (usedTotal.get(c.no) ?? 0));
  // a section's own share left (used only to recognise an EXACT match; capacity is this return's whole money)
  const secLeft = (c: ChallanIn, code: string) => (c.breakup && code !== '*' ? r2((c.breakup[code] ?? 0) - (used.get(capKey(c, code)) ?? 0)) : free(c));
  const capacity = (c: ChallanIn, _code: string) => free(c);
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
    }
    if (problems.length) {
      out.push({ row: r.row, challanNo: r.challanNo, status: 'exception', reason: problems.join('; ') });
      exceptions.push({ kind: 'given-mismatch', rows: [r.row], challans: c ? [c.no] : [], message: `Row ${r.row} (${r.name}): ${problems.join('; ')}.` });
    } else {
      use(c!, r.code, r.tax);
      // v2.3: a challan of the other major head is allowed, as deposited (SOP rule 11), with a note - as in the automatic split
      const mh = majorHeadFor(r.pan);
      const head = c!.majorHead && mh && c!.majorHead !== mh ? `; challan is major head ${c!.majorHead} although the payee needs ${mh} - reported as deposited (SOP rule 11), check` : '';
      out.push({ row: r.row, challanNo: c!.no, status: 'given', reason: `challan #${c!.no} as linked in the workbook${head}` });
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
        // this return's money on a challan serves any of its sections; a section share only marks an exact match
        const cands = candidates(month, code, mh, other);
        const cap = (c: ChallanIn) => (mode === 'exact' && code !== '*' && c.breakup ? Math.min(secLeft(c, code), free(c)) : capacity(c, code));
        let pick: ChallanIn | undefined, how = '';
        if (mode === 'exact') {
          const exact = cands.filter(c => Math.abs(cap(c) - total) <= 0.5);
          const first = exact.filter(c => c.date === exact[0]?.date);
          if (first.length === 1) { pick = first[0]; how = pick.breakup && code !== '*' ? `its section ${code} share equals these rows exactly` : 'the amount for this return equals these rows exactly'; }
        } else {
          const fits = cands.filter(c => cap(c) + 0.5 >= total).sort((a, b) => a.date.localeCompare(b.date));
          const first = fits.filter(c => c.date === fits[0]?.date);
          if (first.length === 1) { pick = first[0]; how = `first challan after the deduction that can take these rows; Rs ${inr(r2(cap(pick) - total))} of this return's money left on it`; }
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
            use(pick, r.code, r.tax);
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

  // money of other returns' sections is never taken here; rows left over get offers (below) for the user to approve
  // whatever is left: no challan, or too large for any one challan
  for (const [k, grp] of groupBy(pending(), anyBreakup)) {
    const [month, mh, code] = k.split('|');
    const total = r2(grp.reduce((a, r) => a + r.tax, 0));
    groupFrom = grp.map(r => r.dateDeducted).sort().at(-1)!;
    const cands = [...candidates(month, code, mh, false), ...candidates(month, code, mh, true)];
    const msg = cands.length
      ? `${describe(month, mh, code, grp, total)}: no challan has enough of this return's money left (most left: Rs ${inr(r2(Math.max(0, ...cands.map(c => free(c)))))}). Allow part of another return's share on a challan, add a missing challan, or a short deposit - needs a decision.`
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
    if (!c.breakup) notes.push('no receipt or section split - enter how this challan was paid');
    if (!mine.length) notes.push('not used by this return (may belong to another form or quarter)');
    else if (left > 1) notes.push(`Rs ${inr(left)} of this return's money not used - excess, or for another form`);
    const oth = otherShare(c), appr = approvedOf(c), osec = otherSections(c).map(k => (k === 'OTHER' ? 'other returns' : k)).join(', ');
    const taken = r2(Math.min(oth, Math.max(0, usedHere - pool(c))));
    if (oth > 0.5) notes.push(appr > 0.5
      ? `Rs ${inr(taken)} of the section ${osec} share (Rs ${inr(oth)}) used for this return on your approval (allowed up to Rs ${inr(appr)}) - Rs ${inr(r2(oth - taken))} left for that return`
      : `Rs ${inr(oth)} for section ${osec} (another return) - kept out`);
    if (left < -0.5) {
      notes.push(`this return uses Rs ${inr(usedHere)}, more than the Rs ${inr(limit)} it may use`);
      exceptions.push({ kind: 'over-limit', rows: mine.map(r => r.row), challans: [c.no], message: `Challan #${c.no} of ${c.date}: rows linked to it total Rs ${inr(usedHere)}, but only Rs ${inr(limit)} of it is for this return (Rs ${inr(reserved(c))} is for other returns). Move rows to another challan, or allow part of the other returns' share.` });
    }
    if (c.breakup && mine.length) {
      const diff = Object.entries(c.breakup).filter(([k]) => thisForm(k) && k !== 'THIS').map(([k, v]) => [k, r2(mine.filter(r => r.code === k).reduce((a, r) => a + r.tax, 0) - v)] as const).filter(([, d]) => Math.abs(d) > 1);
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
    const limitFrom = c.breakup ? 'split' as const : 'missing' as const;
    return { no: c.no, tax: c.tax, usedHere, balance, forThisReturn: limit, left, otherShare: oth, otherSections: otherSections(c), approved: appr, takenFromOther: taken, limitFrom, pool: pool(c), interestPaid: c.interest, interestDue, notes };
  });
  // split missing: the return cannot be built until every challan's split is known
  const missing = challans.filter(c => !c.breakup);
  if (missing.length) exceptions.push({ kind: 'split-missing', rows: [], challans: missing.map(c => c.no),
    message: `Challan(s) ${missing.map(c => `#${c.no} (${c.date}, Rs ${inr(c.tax)})`).join(', ')}: no receipt or section split. Upload the challan receipt, or enter how the challan was paid - all for this return, or the amount for each section.` });
  // rows left without a challan: challans whose other-return share could cover them, for the user to allow
  const openRows = out.filter(m => m.status === 'exception' && m.challanNo === null).map(m => rowByNo.get(m.row)!).filter(Boolean);
  const shortTax = r2(openRows.reduce((a, r) => a + r.tax, 0));
  const offers: ShortfallOffer[] = [];
  if (openRows.length) for (const c of [...challans].sort((a, b) => a.date.localeCompare(b.date))) {
    const available = r2(otherShare(c) - approvedOf(c));
    if (available <= 0.5) continue;
    const coverable = openRows.filter(r => r.dateDeducted <= c.date);
    const need = r2(coverable.reduce((a, r) => a + r.tax, 0));
    if (need <= 0) continue;
    offers.push({ no: c.no, available, suggest: Math.ceil(Math.min(available, need)), sections: otherSections(c), rows: coverable.length });
  }
  out.sort((a, b) => a.row - b.row);
  return { rows: out, challans: useSummary, exceptions, shortTax, offers };
}

// ---------------------------------------------------------------- workbook helpers
/** Blank input workbook with the Phase 2 section column and the Phase 3 challan columns. */
export function makeTemplateFull(form: Form): Uint8Array {
  const wb = XLSX.read(makeTemplateWithSection(form), { type: 'array' });
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Challans'], { header: 1 })[0] ?? []) as string[];
  wb.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([[...hdr, MAJOR_HEAD_COLUMN, BREAKUP_COLUMN, APPROVED_COLUMN]]);
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
        approved: ci(APPROVED_COLUMN) >= 0 && r[ci(APPROVED_COLUMN)] !== null && r[ci(APPROVED_COLUMN)] !== '' ? num(r[ci(APPROVED_COLUMN)]) : null,
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

// ---------------------------------------------------------------- per-challan split and approval (v2.2)
function setChallanCell(data: ArrayBuffer | Uint8Array, challanNo: number, header: string, value: string | number | null): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Challans'];
  const g = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const hdr = (g[0] ?? []).map(v => String(v ?? '').trim());
  let col = hdr.indexOf(header);
  if (col < 0) {
    col = hdr.length; ws[XLSX.utils.encode_cell({ r: 0, c: col })] = { t: 's', v: header };
    const rg = XLSX.utils.decode_range(ws['!ref']!); rg.e.c = Math.max(rg.e.c, col); ws['!ref'] = XLSX.utils.encode_range(rg);
  }
  const r = g.findIndex((row, i) => i > 0 && Number(row[hdr.indexOf('Challan #')]) === challanNo);
  if (r < 0) throw new Error(`Challan #${challanNo} is not on the Challans sheet`);
  const cell = XLSX.utils.encode_cell({ r, c: col });
  if (value === null || value === '') delete ws[cell];
  else ws[cell] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** Set (or clear) a challan's split by section. It must add up to the challan's tax. */
export function setChallanSplit(data: ArrayBuffer | Uint8Array, challanNo: number, split: Record<string, number> | null): Uint8Array {
  if (split) {
    const c = readForMatching(data).challans.find(x => x.no === challanNo);
    if (!c) throw new Error(`Challan #${challanNo} is not on the Challans sheet`);
    const sum = r2(Object.values(split).reduce((a, b) => a + b, 0));
    if (Math.abs(sum - c.tax) > 0.5) throw new Error(`The split adds up to Rs ${inr(sum)} but challan #${challanNo}'s tax is Rs ${inr(c.tax)}`);
    if (Object.values(split).some(v => !(v >= 0))) throw new Error('Amounts in the split cannot be negative');
  }
  return setChallanCell(data, challanNo, BREAKUP_COLUMN, split ? formatBreakup(split) : null);
}

/**
 * For each challan offered (rows short, other-return share available): the smallest amount to allow from
 * its other-return share so that every row gets a challan, and what that does to interest on late deposit.
 * Nothing is applied - the user chooses (the tool cannot know which challan's split was wrong).
 */
/**
 * Rows left without a challan, in groups (month, payee major head, section), each with why and a
 * suggested challan worked out by the rules: dated on/after the group's latest deduction, split known,
 * enough room once its other-return share is counted; preferring a challan that needs none of another
 * return's money, then the payee's major head, then the least other-return money, then the earliest.
 * Groups are taken in date order and each suggestion uses up what it takes, so suggestions add up.
 * Nothing is applied: using another return's share needs the user's OK (fromOther).
 */
export interface OpenGroup {
  key: string; month: string; code: string; head: string; rows: number[]; tax: number; latest: Ymd; why: string;
  suggest: { no: number; fromOther: number; sections: string[]; otherHead: boolean } | null;
}
export function openGroups(challans: ChallanIn[], rows: RowIn[], result: MatchResult): OpenGroup[] {
  const byRow = new Map(rows.map(r => [r.row, r]));
  const open = result.rows.filter(m => m.status === 'exception' && m.challanNo === null).map(m => byRow.get(m.row)!).filter(Boolean);
  const g = new Map<string, RowIn[]>();
  for (const r of open) { const k = `${monthKey(r.dateDeducted)}|${majorHeadFor(r.pan)}|${r.code}`; g.set(k, [...(g.get(k) ?? []), r]); }
  const use = new Map(result.challans.map(u => [u.no, u]));
  const left = new Map(result.challans.map(u => [u.no, Math.max(0, u.left)]));
  const avail = new Map(result.challans.map(u => [u.no, Math.max(0, r2(u.otherShare - u.approved))]));
  const groups = [...g.entries()].map(([key, rs]) => ({ key, rs, tax: r2(rs.reduce((a, r) => a + r.tax, 0)), latest: rs.map(r => r.dateDeducted).sort().at(-1)! }))
    .sort((a, b) => a.latest.localeCompare(b.latest) || b.tax - a.tax);
  return groups.map(({ key, rs, tax, latest }) => {
    const [month, head, code] = key.split('|');
    const dated = challans.filter(c => c.date >= latest && use.get(c.no)?.limitFrom === 'split');
    const cands = dated.filter(c => (left.get(c.no) ?? 0) + (avail.get(c.no) ?? 0) + 0.5 >= tax).map(c => {
      const fromOther = r2(Math.max(0, tax - (left.get(c.no) ?? 0)));
      return { c, fromOther, otherHead: !!(c.majorHead && head && c.majorHead !== head) };
    }).sort((a, b) => Number(a.fromOther > 0) - Number(b.fromOther > 0) || Number(a.otherHead) - Number(b.otherHead) || a.fromOther - b.fromOther || a.c.date.localeCompare(b.c.date));
    const best = cands[0];
    if (best) {
      left.set(best.c.no, r2(Math.max(0, (left.get(best.c.no) ?? 0) - tax)));
      avail.set(best.c.no, r2((avail.get(best.c.no) ?? 0) - best.fromOther));
    }
    const mostLeft = Math.max(0, ...dated.map(c => use.get(c.no)?.left ?? 0));
    const why = !challans.some(c => c.date >= latest)
      ? `no challan dated on or after ${latest}`
      : `this return's own money on challans dated on or after ${latest} is used up (most left Rs ${inr(r2(mostLeft))})`;
    return { key, month, code, head, rows: rs.map(r => r.row), tax, latest, why,
      suggest: best ? { no: best.c.no, fromOther: best.fromOther, sections: use.get(best.c.no)?.otherSections ?? [], otherHead: best.otherHead } : null };
  });
}

export interface ApprovalOption { no: number; amount: number; clearsAll: boolean; openAfter: number; interestShort: number }
export function approvalOptions(challans: ChallanIn[], rows: RowIn[], opts: { form?: Form } = {}): ApprovalOption[] {
  const base = matchChallans(challans, rows, opts);
  const short = (r: MatchResult) => r.exceptions.filter(e => e.kind === 'interest-short').reduce((a, e) => {
    const c = r.challans.find(u => u.no === e.challans[0]); return a + (c ? Math.max(0, c.interestDue - c.interestPaid) : 0);
  }, 0);
  const out: ApprovalOption[] = [];
  for (const o of base.offers) {
    const c = challans.find(x => x.no === o.no)!;
    const run = (extra: number) => matchChallans(challans.map(x => (x.no === o.no ? { ...x, approved: r2((Number(c.approved) || 0) + extra) } : x)), rows, opts);
    const full = run(o.available);
    if (full.shortTax > 0) { out.push({ no: o.no, amount: Math.ceil(o.available), clearsAll: false, openAfter: full.rows.filter(x => x.challanNo === null).length, interestShort: short(full) }); continue; }
    let lo = 0, hi = Math.ceil(o.available);
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (run(mid).shortTax === 0) hi = mid; else lo = mid; }
    const best = run(hi);
    out.push({ no: o.no, amount: hi, clearsAll: best.shortTax === 0, openAfter: best.rows.filter(x => x.challanNo === null).length, interestShort: short(best) });
  }
  return out.sort((a, b) => Number(b.clearsAll) - Number(a.clearsAll) || a.interestShort - b.interestShort || a.amount - b.amount);
}

/** Record (or clear) how much of a challan's other-return share the user allowed this return to use. */
export function setApproved(data: ArrayBuffer | Uint8Array, challanNo: number, amount: number | null): Uint8Array {
  if (amount !== null && !(amount >= 0)) throw new Error('The allowed amount cannot be negative');
  return setChallanCell(data, challanNo, APPROVED_COLUMN, amount);
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
