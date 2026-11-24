/**
 * v2.4 — data checks at upload, in plain words with the workbook row, and the late-deduction rule.
 *
 * Checks every Deductees row before section codes and challans:
 *  - PAN format (or PANNOTAVBL / PANINVALID / PANAPPLIED), amount above nil, tax not more than the amount;
 *  - date of deduction inside the quarter;
 *  - date paid / credited inside the financial year and not after the quarter.
 * A payment of an EARLIER quarter of the same year deducted in this quarter is a late deduction: it is
 * reported as it is (Protean FVU 1.2 accepts it - checked on a real return, Nov 2026) and flagged with
 * an estimate of interest for late deduction (1% a month or part, payment month to deduction month).
 *
 * The frozen core's own final check is stricter (both dates inside the quarter). allowedLateDeductions()
 * tells which of its date problems are such late deductions, so the app does not block on them.
 * New module - does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import type { Ymd } from './protean.ts';

export interface RowIssue { row: number; name: string; pan: string; field: string; value: string; message: string; fix: string }
export interface LateDeduction { row: number; name: string; pan: string; section: string; paid: Ymd; deducted: Ymd; tax: number; months: number; interest: number }
export interface DataCheckResult { errors: RowIssue[]; warnings: RowIssue[]; late: LateDeduction[]; rows: number }

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const PAN_WORDS = ['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'];
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(String(v).replace(/,/g, '')));
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Excel serial, dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd -> yyyy-mm-dd, or '' if it cannot be read. */
export function readDate(v: unknown): Ymd | '' {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const t = s(v);
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
const dmy = (d: string) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');

/** First and last day of a quarter of the financial year starting in April of fyStart. */
export function quarterRange(fyStart: number, quarter: number): { from: Ymd; to: Ymd; fyFrom: Ymd; fyTo: Ymd } {
  const q = ({ 1: ['04-01', '06-30'], 2: ['07-01', '09-30'], 3: ['10-01', '12-31'], 4: ['01-01', '03-31'] } as Record<number, string[]>)[quarter];
  const y = quarter === 4 ? fyStart + 1 : fyStart;
  return { from: `${y}-${q[0]}`, to: `${y}-${q[1]}`, fyFrom: `${fyStart}-04-01`, fyTo: `${fyStart + 1}-03-31` };
}
/** Months for interest on late deduction: from the month of payment to the month of deduction, part months as whole. */
export const lateDeductionMonths = (paid: Ymd, deducted: Ymd) => {
  const [y1, m1] = paid.split('-').map(Number), [y2, m2] = deducted.split('-').map(Number);
  return deducted.slice(0, 7) > paid.slice(0, 7) ? (y2 - y1) * 12 + (m2 - m1) + 1 : 0;
};

/** Check the Deductees sheet of an input workbook. */
export function checkUpload(data: ArrayBuffer | Uint8Array, fyStart: number, quarter: number): DataCheckResult {
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets['Deductees'];
  const out: DataCheckResult = { errors: [], warnings: [], late: [], rows: 0 };
  if (!ws) return out;
  const g = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const hdr = ((g[0] ?? []) as unknown[]).map(v => s(v));
  const col = (h: string) => hdr.indexOf(h);
  const [cPan, cName, cPaid, cDed, cAmt, cTax, cSec, cCode, cReason] =
    ['PAN', 'Name', 'Date paid / credited', 'Date deducted', 'Amount', 'Tax', 'Section (as in working)', 'Section code', 'Reason code (lower/no deduction)'].map(col);
  const q = quarterRange(fyStart, quarter);
  const Q = `Q${quarter} (${dmy(q.from)} to ${dmy(q.to)})`;
  g.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    out.rows++;
    const row = k + 2, name = s(r[cName]), pan = s(r[cPan]).toUpperCase();
    const issue = (list: RowIssue[], field: string, value: string, message: string, fix: string) => list.push({ row, name, pan, field, value, message, fix });
    if (!PAN_RE.test(pan) && !PAN_WORDS.includes(pan)) issue(out.errors, 'PAN', pan || '(blank)', 'PAN is not in the format AAAAA9999A', 'Correct the PAN, or put PANNOTAVBL if the payee has none (tax then at the higher rate).');
    const amt = num(r[cAmt]), tax = num(r[cTax]);
    if (!(amt > 0)) issue(out.errors, 'Amount', s(r[cAmt]) || '(blank)', 'Amount paid / credited is blank or nil', 'Enter the amount paid or credited.');
    if (Number.isNaN(tax)) issue(out.errors, 'Tax', '(blank)', 'Tax is blank', 'Enter the tax deducted (0 only with a lower / no deduction reason).');
    else if (amt > 0 && tax > amt + 0.005) issue(out.errors, 'Tax', String(tax), `Tax (${tax}) is more than the amount (${amt})`, 'Check the Tax and Amount columns - usually a column mix-up or a formula error.');
    else if (tax === 0 && !s(r[cReason])) issue(out.warnings, 'Tax', '0', 'Tax is nil with no reason code', 'Add the reason code for lower / no deduction, or enter the tax.');
    const paid = readDate(r[cPaid]), ded = readDate(r[cDed]);
    if (!paid) issue(out.errors, 'Date paid / credited', s(r[cPaid]) || '(blank)', 'Date paid / credited cannot be read', 'Enter it as a date (dd/mm/yyyy).');
    if (!ded) issue(out.errors, 'Date deducted', s(r[cDed]) || '(blank)', 'Date of deduction cannot be read', 'Enter it as a date (dd/mm/yyyy).');
    if (!paid || !ded) return;
    if (ded < q.from || ded > q.to) issue(out.errors, 'Date deducted', dmy(ded), `Tax was deducted outside ${Q}`,
      ded > q.to ? 'This row belongs to a later quarter\'s return - remove it here, or correct the date.' : 'This row belongs to an earlier quarter\'s return (or a revised one) - remove it here, or correct the date.');
    if (paid < q.fyFrom || paid > q.fyTo) issue(out.errors, 'Date paid / credited', dmy(paid), `Paid / credited outside the financial year ${q.fyFrom.slice(0, 4)}-${q.fyTo.slice(2, 4)}`, 'Correct the date - it must be within the year of this return.');
    else if (paid > q.to) issue(out.errors, 'Date paid / credited', dmy(paid), `Paid / credited after ${Q} ends`, 'A payment after the quarter belongs to the next quarter\'s return - remove it here, or correct the date.');
    else if (ded < paid) issue(out.warnings, 'Date deducted', dmy(ded), `Deducted (${dmy(ded)}) before the date paid / credited (${dmy(paid)})`, 'Fine if the tax was deducted on credit before payment; otherwise correct the dates.');
    const months = lateDeductionMonths(paid, ded);
    if (months > 0 && tax > 0) out.late.push({ row, name, pan, section: s(r[cCode]) || s(r[cSec]), paid, deducted: ded, tax, months, interest: Math.round(tax * 0.01 * months) });
  });
  return out;
}

/**
 * Which of the frozen core's "line N DD: date X (field 19) outside Q" problems are late deductions
 * (payment in an earlier quarter of the same year, deduction inside the quarter) - Protean's FVU accepts
 * those, so they are shown as points to review, not blocks. Everything else stays a problem.
 */
export function allowedLateDeductions(problems: string[], lines: string[], fyStart: number, quarter: number): { blocking: string[]; late: string[] } {
  const q = quarterRange(fyStart, quarter);
  const ymd = (d: string) => `${d.slice(4, 8)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
  const blocking: string[] = [], late: string[] = [];
  for (const p of problems) {
    const m = p.match(/^line (\d+) DD: date (\d{8}) \(field 19\) outside Q\d$/);
    if (!m) { blocking.push(p); continue; }
    const f = (lines[Number(m[1]) - 1] ?? '').split('^');
    const paid = ymd(m[2]), ded = f[26] ? ymd(f[26]) : '';
    if (f[1] === 'DD' && paid >= q.fyFrom && paid < q.from && ded >= q.from && ded <= q.to)
      late.push(`${f[8] ?? ''} (${f[7] ?? ''}): paid ${dmy(paid)}, deducted ${dmy(ded)} - late deduction, reported as it is (Protean's FVU accepts it); interest for late deduction applies`.trim());
    else blocking.push(p);
  }
  return { blocking, late };
}

/** For the report: rows of the result as plain records. */
export const issueRecords = (r: DataCheckResult) => [
  ...r.errors.map(i => ({ Level: 'Must fix', Row: i.row, Name: i.name, PAN: i.pan, Field: i.field, Value: i.value, Problem: i.message, 'What to do': i.fix })),
  ...r.warnings.map(i => ({ Level: 'Check', Row: i.row, Name: i.name, PAN: i.pan, Field: i.field, Value: i.value, Problem: i.message, 'What to do': i.fix })),
];
export const lateRecords = (r: DataCheckResult) => r.late.map(l => ({ Row: l.row, Name: l.name, PAN: l.pan, Section: l.section,
  'Date paid / credited': dmy(l.paid), 'Date deducted': dmy(l.deducted), Tax: l.tax, Months: l.months, 'Interest (about, 1% a month)': l.interest }));
export const r2x = r2;
