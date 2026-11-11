/**
 * v1.5 tests: month plan, automatic split, Tax column check. Invented figures copying a real pattern
 * (one month paid late with interest AFTER the next month was paid on time; same-date 0020/0021 pairs
 * with no major head; a top-up challan; a salary share on a shared challan).
 * Run from the repo root:  node test/phase5.test.ts
 */
import { checkTaxColumn, matchChallans, type ChallanIn, type RowIn } from '../src/challanMatch.ts';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const ch = (no: number, date: string, tax: number, extra: Partial<ChallanIn> = {}): ChallanIn =>
  ({ no, bsr: '1234567', serial: String(no).padStart(5, '0'), date, tax, interest: 0, fee: 0, others: 0, majorHead: '', breakup: null, ...extra });
let n = 1;
const row = (pan: string, code: string, date: string, tax: number): RowIn => ({ row: ++n, pan, name: `Payee ${n}`, code, dateDeducted: date, tax, challanNo: null });
const IND = 'ABCPK1234Z', CO = 'ABCCK1234Z';
const links = (r: ReturnType<typeof matchChallans>) => r.rows.map(x => x.challanNo ?? x.status).join(',');

// 1. July paid LATE on 7 Sep (with interest), August paid on time on 6 Sep; no major heads given
const challans = [
  ch(1, '2026-09-06', 50000),                    // August, non-company (larger of the pair) - rest is for another form
  ch(2, '2026-09-06', 8000),                     // August, company (smaller of the pair)
  ch(3, '2026-09-07', 30000, { interest: 900 }), // July, late: 900 = 1.5% x 3 months x 20,000
  ch(4, '2026-09-07', 6000, { interest: 270 }),  // July, late, company
  ch(5, '2026-10-30', 5000, { interest: 500 }),  // top-up, not tied to one month
];
n = 1;
const rows = [
  row(IND, '1023', '2026-07-31', 12000), row(IND, '1023', '2026-07-31', 8000),   // July non-company
  row(CO, '1031', '2026-07-31', 6000), row(CO, '1006', '2026-07-31', 4000),      // July company: 10,000 > challan #4
  row(IND, '1023', '2026-08-31', 15000), row(CO, '1024', '2026-08-31', 8000),    // August
];
let r = matchChallans(challans, rows);
check(links(r) === '3,3,4,5,1,2', `month plan + split: rows -> ${links(r)} (expected 3,3,4,5,1,2)`);
check(r.rows.every(x => x.status === 'matched') && !r.exceptions.some(e => e.kind === 'too-large' || e.kind === 'no-challan'), 'nothing left for a decision');
check(/the challan for 2026-07 \(paid late, with interest\)/.test(r.rows[0].reason), 'July rows go to the late challan with interest, not the earlier on-time one');
check(/smaller of the two challans of 2026-09-06\) taken as 0020/.test(r.rows[5].reason), 'same-date pair without major head: smaller taken as 0020, with a note');
check(/no room left, so split off to challan #5/.test(r.rows[3].reason), 'overflow split off to the top-up challan');
check(!r.exceptions.some(e => e.kind === 'interest-short'), `interest checks out (due ${r.challans.map(c => c.interestDue).join('/')})`);

// the old rule (earliest challan after the deduction) would have sent July to 6 Sep - make sure it does not
check(!r.rows.slice(0, 4).some(x => x.challanNo === 1 || x.challanNo === 2), 'July rows not put in the 6 Sep (August) challans');

// 2. company rows with no room in a 0020 challan: the 0021 challan is used as a last resort (SOP rule 11, noted)
n = 1;
r = matchChallans([ch(1, '2026-08-07', 5000, { majorHead: '0020' }), ch(2, '2026-08-07', 20000, { majorHead: '0021' })],
  [row(CO, '1031', '2026-07-31', 7000), row(IND, '1023', '2026-07-31', 10000)]);
check(links(r) === '2,2' && /major head 0021 although the payee needs 0020/.test(r.rows[0].reason), 'company row too big for the 0020 challan: put in the 0021 challan with an SOP rule 11 note');

// 3. salary share on a shared challan is kept for Form 138 - and used only as a last resort, with a note
n = 1;
const sal = ch(1, '2026-08-07', 100000, { majorHead: '0021', breakup: { 1002: 90000, 1023: 10000 } });
r = matchChallans([sal], [row(IND, '1023', '2026-07-31', 6000), row(IND, '1023', '2026-07-31', 4000)]);
check(links(r) === '1,1' && r.challans[0].balance === 90000 && !/check the other return/.test(r.challans[0].notes.join()), 'rows within the challan\'s own share: salary share left untouched');
n = 1;
r = matchChallans([sal], [row(IND, '1023', '2026-07-31', 10000), row(IND, '1023', '2026-07-31', 2000)]);
check(links(r) === '1,1' && /share for section 1002 \(another return\)/.test(r.rows[1].reason) && /check the other return/.test(r.challans[0].notes.join()),
  'rows beyond the challan\'s own share: salary share used as a last resort, flagged on the row and the challan');

// 4. section breakup different from the rows: allowed, noted on the challan
n = 1;
r = matchChallans([ch(1, '2026-08-07', 10000, { majorHead: '0021', breakup: { 1023: 4000, 1031: 6000 } })],
  [row(IND, '1023', '2026-07-31', 5000), row(IND, '1031', '2026-07-31', 5000)]);
check(links(r) === '1,1' && /differ from the challan's section breakup \(1023 \+1,000, 1031 -1,000\)/.test(r.challans[0].notes.join()), 'section split differs from the challan: matched, difference noted');

// 5. Tax column check
const t1 = checkTaxColumn([{ row: 2, amount: 13000, rate: 2, tax: 26000 }, { row: 3, amount: 5000, rate: 1, tax: 5000 }]);
check(t1.problems.length === 1 && /2 row\(s\)/.test(t1.problems[0]) && /should be about 260/.test(t1.problems[0]), 'Tax = Amount x Rate (no /100): stopped with a plain message');
const t2 = checkTaxColumn([{ row: 2, amount: 13000, rate: 2, tax: 260.4 }, { row: 3, amount: 13000, rate: 2, tax: 200 }]);
check(!t2.problems.length && t2.warnings.length === 1 && /Row 3/.test(t2.warnings[0]), 'rounding within Rs 1 is fine; a different tax is a warning only');

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
