/**
 * Phase 3 tests: matching rows to challans by rules (made-up data copying real Q2 situations).
 * Run from the repo root:  node test/phase3.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { buildStatement, encodeReturn } from '../src/protean.ts';
import { readInputWorkbook } from '../src/inputWorkbook.ts';
import {
  applyChallanMatches, BREAKUP_COLUMN, dueDate, lateMonths, MAJOR_HEAD_COLUMN, makeTemplateFull, matchChallans,
  parseBreakup, readForMatching, type ChallanIn, type RowIn,
} from '../src/challanMatch.ts';

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const ch = (no: number, date: string, tax: number, extra: Partial<ChallanIn> = {}): ChallanIn =>
  ({ no, bsr: '1234567', serial: String(no).padStart(5, '0'), date, tax, interest: 0, fee: 0, others: 0, majorHead: '', breakup: null, ...extra });
let n = 1;
const row = (pan: string, code: string, date: string, tax: number, challanNo: number | null = null): RowIn =>
  ({ row: ++n, pan, name: `P${n}`, code, dateDeducted: date, tax, challanNo });
const IND = 'ABCPK1234Z', FIRM = 'ABCFK1234Z', CO = 'ABCCK1234Z';
const linkOf = (r: ReturnType<typeof matchChallans>) => r.rows.map(x => x.challanNo ?? x.status).join(',');

check(dueDate('2026-07-31') === '2026-08-07' && dueDate('2027-03-31') === '2027-04-30' && dueDate('2026-12-15') === '2027-01-07', 'due dates: 7th of next month, 30 April for March');
check(lateMonths('2026-07-31', '2026-08-07') === 0 && lateMonths('2026-07-31', '2026-08-17') === 2 && lateMonths('2026-07-15', '2026-10-13') === 4, 'late months: 0 on time; July deduction paid 17 Aug = 2; paid 13 Oct = 4');
check(JSON.stringify(parseBreakup('1023=5000; 1073=180000')) === '{"1023":5000,"1073":180000}' && parseBreakup('') === null, 'section breakup read');

// 1. one challan per month (no extra columns): earliest challan after the deduction
n = 1;
let r = matchChallans([ch(1, '2026-08-07', 3000), ch(2, '2026-09-07', 5000)],
  [row(IND, '1023', '2026-07-31', 1000), row(FIRM, '1027', '2026-07-31', 2000), row(IND, '1023', '2026-08-31', 5000)]);
check(linkOf(r) === '1,1,2' && !r.exceptions.length, `one challan per month: rows -> ${linkOf(r)}`);

// 2. a challan dated before the deduction cannot pay it (Aug salary deducted 31-Aug is not in the 7-Aug challan)
n = 1;
r = matchChallans([ch(1, '2026-08-07', 50000), ch(2, '2026-09-07', 50000)], [row(IND, '1002', '2026-08-31', 25000)]);
check(linkOf(r) === '2', 'challan dated before the deduction is not used');

// 3. shared challan with breakup (TCS paid with TDS): only the TCS share is used
n = 1;
r = matchChallans([ch(1, '2026-08-07', 300000, { majorHead: '0021', breakup: { 1023: 80000, 1073: 180000, 1002: 30000, 1027: 10000 } })],
  [row(FIRM, '1073', '2026-07-31', 180000)]);
check(linkOf(r) === '1' && /section 1073 share equals/.test(r.rows[0].reason), 'TCS row matched to its section share of a shared challan');
check(r.challans[0].balance === 120000 && /not used by this return/.test(r.challans[0].notes[0]), `balance left for the other forms: Rs ${r.challans[0].balance}`);

// 4. one challan per section (one challan for each section): exact amounts decide, even without a breakup
n = 1;
r = matchChallans([ch(1, '2026-08-06', 20000), ch(2, '2026-08-06', 6000), ch(3, '2026-08-06', 1500)],
  [row(IND, '1067', '2026-07-31', 10000), row(IND, '1067', '2026-07-31', 10000), row(FIRM, '1031', '2026-07-31', 6000), row(FIRM, '1006', '2026-07-31', 1500)]);
check(linkOf(r) === '1,1,2,3', `one challan per section matched by exact amounts: ${linkOf(r)}`);

// 5. company payee paid in a 0021 challan (seen in Q2): kept as deposited, with a note
n = 1;
r = matchChallans([ch(1, '2026-08-07', 5000, { majorHead: '0021', breakup: { 1023: 5000 } })],
  [row(CO, '1023', '2026-07-31', 2000), row(IND, '1023', '2026-07-31', 3000)]);
check(linkOf(r) === '1,1' && /major head 0021 although the payee needs 0020/.test(r.rows[0].reason), 'company payee in a 0021 challan: matched with an SOP rule 11 note');

// 6. two challans on the same date that could each take the rows (0020 + 0021, no major head given): not guessed
n = 1;
r = matchChallans([ch(1, '2026-08-07', 90000), ch(2, '2026-08-07', 90000)], [row(IND, '1023', '2026-07-31', 1000)]);
check(r.rows[0].status === 'exception' && r.exceptions.some(e => e.kind === 'duplicate'), 'two same-date challans that fit: left for a decision, possible duplicate flagged');

// 7. duplicate challan (seen in Q2): flagged; a later month with no later challan is left for a decision
n = 1;
r = matchChallans([ch(1, '2026-08-07', 20000, { majorHead: '0021' }), ch(2, '2026-08-07', 20000, { majorHead: '0021' })],
  [row(IND, '1023', '2026-09-30', 3000)]);
check(r.exceptions.some(e => e.kind === 'duplicate') && r.rows[0].status === 'exception' && /no challan dated on or after 2026-09-30/.test(r.rows[0].reason),
  'duplicate challans flagged; September rows with no later challan need a decision');

// 8. rows bigger than any challan: not guessed
n = 1;
r = matchChallans([ch(1, '2026-08-07', 1000)], [row(IND, '1023', '2026-07-31', 5000)]);
check(r.rows[0].status === 'exception' && r.exceptions[0].kind === 'too-large', 'rows larger than the challan: left for a decision');

// 9. late deposit: interest checked (July rows paid 17 Aug: 2 months x 1.5%)
n = 1;
r = matchChallans([ch(1, '2026-08-17', 30000, { interest: 800 })], [row(IND, '1023', '2026-07-31', 30000)]);
check(r.challans[0].interestDue === 900 && r.exceptions.some(e => e.kind === 'interest-short') && /after the due date/.test(r.rows[0].reason),
  `late deposit: interest due Rs ${r.challans[0].interestDue}, paid 800 -> shortfall flagged`);

// 10. challan typed in the workbook: kept if it fits, flagged if not
n = 1;
r = matchChallans([ch(1, '2026-08-07', 5000, { majorHead: '0020' })], [row(IND, '1023', '2026-07-31', 1000, 1), row(CO, '1024', '2026-09-30', 100, 1)]);
check(r.rows[0].status === 'exception' && /needs major head 0021/.test(r.rows[0].reason) && /before the month of deduction/.test(r.rows[1].reason),
  'typed-in challan checked: wrong major head and challan before the deduction month are flagged');

// 11. workbook round trip: template, read, match, apply -> the frozen core builds the same return as the hand-linked fixture
const tpl = XLSX.read(makeTemplateFull('140'));
const chHdr = XLSX.utils.sheet_to_json<string[]>(tpl.Sheets['Challans'], { header: 1 })[0];
check(chHdr.includes(MAJOR_HEAD_COLUMN) && chHdr.includes(BREAKUP_COLUMN), 'template has the major head and section breakup columns');
const src = XLSX.read(readFileSync(join(fx, 'f140.xlsx')));
const dg = XLSX.utils.sheet_to_json<unknown[]>(src.Sheets['Deductees'], { header: 1, raw: true, defval: null });
const cIdx = (dg[0] as string[]).indexOf('Challan #');
const original = dg.slice(1).map(r => r[cIdx]);
dg.slice(1).forEach(r => { r[cIdx] = null; });
src.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet(dg);
const noLinks = XLSX.write(src, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
const m = readForMatching(noLinks);
const res = matchChallans(m.challans, m.rows);
check(!m.problems.length && res.rows.every(x => x.status === 'matched'), `fixture without challan links: ${res.rows.map(x => x.challanNo).join(',')} (hand-linked: ${original.join(',')})`);
const linked = applyChallanMatches(noLinks, res.rows.map(x => ({ row: x.row, challanNo: x.challanNo! })));
const inp = readInputWorkbook(linked, '140', 2);
const lines = buildStatement({ form: '140', deductor: inp.deductor!, challans: inp.challans, fyStart: 2026, quarter: 2, prevToken: '770000000000001', created: '2026-11-05' });
const exp = readFileSync(join(fx, 'f140.txt')).toString('latin1').split('\r\n').slice(1).join();
check(Buffer.from(encodeReturn(lines)).toString('latin1').split('\r\n').slice(1).join() === exp, 'matched links give the same return as the hand-linked fixture');

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
