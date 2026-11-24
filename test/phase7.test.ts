/**
 * v2.2 tests: the firm's set-off rule. Every challan needs its split by section (receipt or typed);
 * this return's sections are one pool used across sections, months and top-ups; another return's
 * share (e.g. 1002 salary) only up to what the user allows; offers with the smallest amount that
 * links every row; tax in whole rupees. Invented figures only.
 * Run from the repo root:  node test/phase7.test.ts
 */
import * as XLSX from 'xlsx';
import { APPROVED_COLUMN, BREAKUP_COLUMN, approvalOptions, matchChallans, openGroups, makeTemplateFull, parseBreakup, readForMatching, setApproved, setChallanSplit, type ChallanIn, type RowIn } from '../src/challanMatch.ts';
import { roundTax } from '../src/app/rates.ts';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const ch = (no: number, date: string, tax: number, extra: Partial<ChallanIn> = {}): ChallanIn =>
  ({ no, bsr: '1234567', serial: String(no).padStart(5, '0'), date, tax, interest: 0, fee: 0, others: 0, majorHead: '', breakup: null, ...extra });
let n = 1;
const row = (pan: string, code: string, date: string, tax: number, challanNo: number | null = null): RowIn => ({ row: ++n, pan, name: `Payee ${n}`, code, dateDeducted: date, tax, challanNo });
const IND = 'ABCPK1234Z';
const links = (r: ReturnType<typeof matchChallans>) => r.rows.map(x => x.challanNo ?? x.status).join(',');
const F = { form: '140' as const };

// 1. a challan with no receipt / split: flagged split-missing (blocks), rows still previewed
n = 1;
let r = matchChallans([ch(1, '2026-08-07', 20000)], [row(IND, '1023', '2026-07-31', 12000)], F);
check(links(r) === '1' && r.exceptions.some(e => e.kind === 'split-missing' && e.challans[0] === 1) && r.challans[0].limitFrom === 'missing', 'no split: split-missing flagged');
r = matchChallans([ch(1, '2026-08-07', 20000, { breakup: { THIS: 20000 } })], [row(IND, '1023', '2026-07-31', 12000)], F);
check(!r.exceptions.length && r.challans[0].pool === 20000, '"all for this return" (this=20000): no flag');
check(JSON.stringify(parseBreakup('1002=5000; this=3000; other=2000')) === '{"1002":5000,"THIS":3000,"OTHER":2000}', 'split text: section codes, this, other');

// 2. this return's money is one pool across its sections (by form), including sections with no rows
n = 1;
r = matchChallans([ch(1, '2026-08-07', 30000, { breakup: { 1002: 20000, 1023: 2000, 1027: 8000 } })], [row(IND, '1023', '2026-07-31', 9000)], F);
check(links(r) === '1' && r.challans[0].pool === 10000 && r.challans[0].otherShare === 20000 && !r.offers.length,
  '1023 rows (9,000) use the 1023 + 1027 shares (10,000) - both Form 140 sections; 1002 salary kept out');

// 3. excess this-return money on another challan is used before anything is asked
n = 1;
r = matchChallans([ch(1, '2026-08-07', 50000, { breakup: { 1002: 45000, 1023: 5000 } }), ch(2, '2026-10-30', 9000, { breakup: { 1023: 9000 } })],
  [row(IND, '1023', '2026-07-31', 5000), row(IND, '1023', '2026-07-31', 4000)], F);
check(links(r) === '1,2' && !r.offers.length && r.challans[0].takenFromOther === 0, 'second row goes to the top-up challan\'s own money; salary share untouched, nothing offered');

// 4. still short: the salary share is offered, never taken; the smallest amount that links every row
n = 1;
const sal = [ch(1, '2026-08-07', 100000, { majorHead: '0021', breakup: { 1002: 90000, 1023: 10000 } })];
const rows4 = [row(IND, '1023', '2026-07-31', 8000), row(IND, '1023', '2026-07-31', 3500)];
r = matchChallans(sal, rows4, F);
check(links(r) === '1,exception' && r.shortTax === 3500 && r.offers[0]?.available === 90000 && r.challans[0].takenFromOther === 0, 'short Rs 3,500: offered, not taken');
const opt = approvalOptions(sal, rows4, F);
check(opt.length === 1 && opt[0].amount === 1500 && opt[0].clearsAll, `smallest approval that links every row: Rs ${opt[0]?.amount} (8,000 + 3,500 - 10,000)`);
r = matchChallans([{ ...sal[0], approved: opt[0].amount }], rows4, F);
check(links(r) === '1,1' && r.challans[0].takenFromOther === 1500 && /Rs 88,500 left for that return/.test(r.challans[0].notes.join()), 'after the user allows it: all linked, Rs 88,500 left for the salary return');
r = matchChallans([{ ...sal[0], approved: 50000 }], rows4, F);
check(r.challans[0].takenFromOther === 1500 && r.challans[0].approved === 50000, 'allowing more than needed: only what the rows use is taken (1,500), the rest stays with salary');

// 5. a challan dated before the short rows is not offered
n = 1;
r = matchChallans([ch(1, '2026-07-07', 50000, { breakup: { 1002: 50000 } }), ch(2, '2026-09-07', 1000, { breakup: { 1023: 1000 } })],
  [row(IND, '1023', '2026-08-31', 4000)], F);
check(r.shortTax === 4000 && !r.offers.length, 'salary challan dated before the deduction: not offered');

// 6. typed-in link beyond the limit: over-limit
n = 1;
r = matchChallans([ch(1, '2026-08-07', 100000, { breakup: { 1002: 90000, 1023: 10000 } })], [row(IND, '1023', '2026-07-31', 12000, 1)], F);
check(r.exceptions.some(e => e.kind === 'over-limit') && r.challans[0].left === -2000, 'typed-in challan beyond this return\'s money: over-limit');

// 7. workbook: split and approval written and read back; a split that does not add up is refused
const tpl = XLSX.read(makeTemplateFull('140'));
const chHdr = XLSX.utils.sheet_to_json<string[]>(tpl.Sheets['Challans'], { header: 1 })[0];
check(chHdr.includes(BREAKUP_COLUMN) && chHdr.includes(APPROVED_COLUMN), 'template has the split and approval columns');
tpl.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([chHdr, chHdr.map(h => ({ 'Challan #': 1, 'BSR code': '1234567', 'Challan serial no.': '00001', 'Date deposited': '07/08/2026', Tax: 100000, Interest: 0, Fee: 0, Others: 0 } as Record<string, unknown>)[h] ?? null)]);
let wb = new Uint8Array(XLSX.write(tpl, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
let refused = '';
try { setChallanSplit(wb, 1, { 1002: 50000, 1023: 10000 }); } catch (e) { refused = (e as Error).message; }
check(/adds up to Rs 60,000/.test(refused), 'split that does not add up to the challan: refused');
wb = setApproved(setChallanSplit(wb, 1, { 1002: 90000, 1023: 10000 }), 1, 2500);
const back = readForMatching(wb).challans[0];
check(JSON.stringify(back.breakup) === '{"1002":90000,"1023":10000}' && back.approved === 2500, 'split and approval saved in the workbook and read back');
check(readForMatching(setApproved(wb, 1, null)).challans[0].approved === null, 'approval cleared');

// 8. tax in whole rupees
const tz = XLSX.read(makeTemplateFull('140'));
const dHdr = XLSX.utils.sheet_to_json<string[]>(tz.Sheets['Deductees'], { header: 1 })[0];
tz.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet([dHdr, dHdr.map(h => ({ PAN: IND, Name: 'P', 'Section code': '1023', Amount: 27108.3, 'Rate %': 1, Tax: 271.083, 'Date deducted': '31/07/2026' } as Record<string, unknown>)[h] ?? null)]);
const zb = new Uint8Array(XLSX.write(tz, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
const rounded = roundTax(zb);
check(rounded.rows === 1 && readForMatching(rounded.bytes).rows[0].tax === 271, 'tax rounded to rupees');
check(roundTax(rounded.bytes).rows === 0, 'whole-rupee tax: unchanged');

// 9. v2.3: open rows in groups, each with a suggestion that adds up; applying them links everything
n = 1;
const g9ch = [ch(1, '2026-08-07', 60000, { majorHead: '0021', breakup: { 1002: 50000, 1023: 10000 } }),
  ch(2, '2026-09-07', 40000, { majorHead: '0021', breakup: { 1002: 35000, 1031: 5000 } }),
  ch(3, '2026-09-07', 3000, { majorHead: '0020', breakup: { 1031: 3000 } })];
const g9rows = [row(IND, '1023', '2026-07-31', 9000), row(IND, '1023', '2026-07-31', 2500), row(IND, '1031', '2026-08-31', 4000),
  row(IND, '1031', '2026-08-31', 1800), row('ABCCK1234Z', '1031', '2026-08-31', 3500)];
const g9 = matchChallans(g9ch, g9rows, F);
const groups = openGroups(g9ch, g9rows, g9);
check(groups.length > 0 && groups.reduce((a, g) => a + g.rows.length, 0) === g9.rows.filter(x => x.challanNo === null).length,
  `open rows grouped: ${groups.map(g => `${g.month} ${g.head} ${g.code} x${g.rows.length}`).join('; ')}`);
check(groups.every(g => g.suggest && g.suggest.fromOther >= 0), `each group has a suggestion: ${groups.map(g => `#${g.suggest?.no} +${g.suggest?.fromOther}${g.suggest?.otherHead ? ' other head' : ''}`).join('; ')}`);
const extra = new Map<number, number>();
for (const g of groups) if (g.suggest) extra.set(g.suggest.no, (extra.get(g.suggest.no) ?? 0) + g.suggest.fromOther);
const applied = g9ch.map(c => ({ ...c, approved: extra.get(c.no) ?? null }));
const linkedRows = g9rows.map(r => { const g = groups.find(x => x.rows.includes(r.row)); return g?.suggest ? { ...r, challanNo: g.suggest.no } : r; });
const after = matchChallans(applied, linkedRows, F);
check(after.rows.every(x => x.challanNo !== null) && !after.exceptions.some(e => ['over-limit', 'given-mismatch', 'split-missing'].includes(e.kind)),
  'applying every suggestion (links + the approvals it lists) links all rows, nothing over a limit');
check(after.rows.some(x => /SOP rule 11/.test(x.reason)) || !groups.some(g => g.suggest?.otherHead), 'a company row linked to a 0021 challan is allowed with the SOP rule 11 note');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
