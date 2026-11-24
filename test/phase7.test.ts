/**
 * v2.1 tests: strict challan limit for this return (other returns' use, receipt split), no borrowing
 * of salary money, split-unknown, over-limit, reading the other return's sheet, tax in whole rupees.
 * Invented figures only.
 * Run from the repo root:  node test/phase7.test.ts
 */
import * as XLSX from 'xlsx';
import { matchChallans, readForMatching, readOtherFormUse, setOtherForms, setOtherFormsFor, makeTemplateFull, OTHER_FORMS_COLUMN, type ChallanIn, type RowIn } from '../src/challanMatch.ts';
import { roundTax } from '../src/app/rates.ts';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const ch = (no: number, date: string, tax: number, extra: Partial<ChallanIn> = {}): ChallanIn =>
  ({ no, bsr: '1234567', serial: String(no).padStart(5, '0'), date, tax, interest: 0, fee: 0, others: 0, majorHead: '', breakup: null, ...extra });
let n = 1;
const row = (pan: string, code: string, date: string, tax: number, challanNo: number | null = null): RowIn => ({ row: ++n, pan, name: `Payee ${n}`, code, dateDeducted: date, tax, challanNo });
const IND = 'ABCPK1234Z';
const links = (r: ReturnType<typeof matchChallans>) => r.rows.map(x => x.challanNo ?? x.status).join(',');

// 1. shared salary challan, nothing known about the split: rows are linked but the tool asks (split-unknown)
n = 1;
let r = matchChallans([ch(1, '2026-08-07', 100000)], [row(IND, '1023', '2026-07-31', 12000)]);
check(links(r) === '1' && r.exceptions.some(e => e.kind === 'split-unknown' && e.challans[0] === 1), 'split not known (Rs 88,000 left, no receipt or other-form figure): flagged split-unknown');
r = matchChallans([ch(1, '2026-08-07', 12500)], [row(IND, '1023', '2026-07-31', 12000)]);
check(!r.exceptions.some(e => e.kind === 'split-unknown'), 'a few hundred rupees left: no split-unknown');
r = matchChallans([ch(1, '2026-08-07', 100000, { otherForms: 0 })], [row(IND, '1023', '2026-07-31', 12000)]);
check(!r.exceptions.length && r.challans[0].limitFrom === 'other-forms' && r.challans[0].left === 88000, '"Used by other forms" = 0 settles it: no exception');

// 2. other-forms figure is the limit, and overrides a wrong receipt split
n = 1;
r = matchChallans([ch(1, '2026-08-07', 100000, { breakup: { 1002: 90000, 1023: 10000 }, otherForms: 85000 })],
  [row(IND, '1023', '2026-07-31', 9000), row(IND, '1023', '2026-07-31', 6000)]);
check(links(r) === '1,1' && r.challans[0].forThisReturn === 15000 && !r.exceptions.length,
  'receipt says 90,000 salary but the 24Q used 85,000: this return may use 15,000 and both rows fit');
r = matchChallans([ch(1, '2026-08-07', 100000, { otherForms: 95000 })], [row(IND, '1023', '2026-07-31', 9000)]);
check(links(r) === 'exception' && /no single challan has enough left for this return/.test(r.rows[0].reason) && /#1 Rs 95,000 \(used by other forms, as entered\)/.test(r.rows[0].reason),
  'rows beyond the limit: not linked, the message names the money kept for the other return');

// 3. a challan wholly for another return (e.g. 27Q section 1057) is never used
n = 1;
r = matchChallans([ch(1, '2026-08-07', 50000, { breakup: { 1057: 50000 } }), ch(2, '2026-08-07', 20000, { breakup: { 1023: 20000 } })],
  [row(IND, '1023', '2026-07-31', 15000)]);
check(links(r) === '2' && r.challans[0].usedHere === 0 && r.challans[0].forThisReturn === 0, 'challan wholly for section 1057 (another form): not used');

// 4. a challan typed in the workbook beyond its limit: over-limit, blocks
n = 1;
r = matchChallans([ch(1, '2026-08-07', 100000, { otherForms: 90000 })], [row(IND, '1023', '2026-07-31', 12000, 1)]);
check(r.exceptions.some(e => e.kind === 'over-limit') && r.challans[0].left === -2000, 'typed-in challan beyond its limit for this return: over-limit flagged');

// 5. reading the other return: a Compu-TDS style sheet ("Challan Detail" + "Total Tax deposited")
const compu = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(compu, XLSX.utils.aoa_to_sheet([
  [null, 'Please do not Cut/Copy/Paste'],
  ['Serial No.', 'PAN of the employee', 'Name of Employee', 'Total Tax deposited Rs.', 'Challan Detail\n\n[Sr No (BSR, Date, Challan No.)]'],
  ['313', '315', '316', '324', ''],
  [1, 'ABCPE1111A', 'Employee A', 40000, '1  (1234567, 07-Aug-2026, 00001)'],
  [2, 'ABCPE2222B', 'Employee B', 45000, '1  (1234567, 07-Aug-2026, 00001)'],
  [3, 'ABCPE3333C', 'Employee C', 30000, '2  (1234567, 07-Sep-2026, 00002)'],
]), 'Challan_adjustment');
const compuBytes = new Uint8Array(XLSX.write(compu, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
const read = readOtherFormUse(compuBytes);
check(!read.problems.length && read.uses.length === 2 && read.uses.find(u => u.serial === '00001')?.amount === 85000 && read.uses.find(u => u.serial === '00002')?.date === '2026-09-07',
  `Compu-TDS 24Q sheet read: ${read.uses.map(u => `${u.serial} ${u.date} ${u.amount}`).join('; ')}`);

// 6. ... written onto this return's Challans sheet; then matching uses it
const tpl = XLSX.read(makeTemplateFull('140'));
const chHdr = XLSX.utils.sheet_to_json<string[]>(tpl.Sheets['Challans'], { header: 1 })[0];
const dHdr = XLSX.utils.sheet_to_json<string[]>(tpl.Sheets['Deductees'], { header: 1 })[0];
const chRow = (vals: Record<string, unknown>) => chHdr.map(h => vals[h] ?? null);
const dRow = (vals: Record<string, unknown>) => dHdr.map(h => vals[h] ?? null);
tpl.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([chHdr,
  chRow({ 'Challan #': 1, 'BSR code': '1234567', 'Challan serial no.': '00001', 'Date deposited': '07/08/2026', Tax: 100000, Interest: 0, Fee: 0, Others: 0 }),
  chRow({ 'Challan #': 2, 'BSR code': '1234567', 'Challan serial no.': '00002', 'Date deposited': '07/09/2026', Tax: 45000, Interest: 0, Fee: 0, Others: 0 })]);
tpl.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet([dHdr,
  dRow({ PAN: IND, Name: 'Payee', 'Section code': '1023', 'Date paid / credited': '31/07/2026', Amount: 1500000, 'Rate %': 1, Tax: 15000, 'Date deducted': '31/07/2026' }),
  dRow({ PAN: IND, Name: 'Payee', 'Section code': '1023', 'Date paid / credited': '31/08/2026', Amount: 1500000, 'Rate %': 1, Tax: 15000, 'Date deducted': '31/08/2026' })]);
const wbBytes = new Uint8Array(XLSX.write(tpl, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
const set = setOtherForms(wbBytes, read.uses);
const m = readForMatching(set.bytes);
check(set.matched.map(x => `${x.no}:${x.amount}`).join() === '1:85000,2:30000' && m.challans.map(c => c.otherForms).join() === '85000,30000',
  `"${OTHER_FORMS_COLUMN}" written and read back: ${m.challans.map(c => c.otherForms).join(', ')}`);
r = matchChallans(m.challans, m.rows);
check(links(r) === '1,2' && !r.exceptions.length && r.challans.map(c => c.left).join() === '0,0', 'matching within the limits: July 15,000 on #1 (100,000 - 85,000), August 15,000 on #2 (45,000 - 30,000)');
const cleared = readForMatching(setOtherFormsFor(set.bytes, 2, null)).challans;
check(cleared[0].otherForms === 85000 && cleared[1].otherForms === null, 'one challan\'s figure cleared, the other kept');

// 7. reading the other return from this tool's own input workbook (another form, rows linked)
const otherWb = XLSX.read(set.bytes);
const og = XLSX.utils.sheet_to_json<unknown[]>(otherWb.Sheets['Deductees'], { header: 1, defval: null });
og[1][dHdr.indexOf('Challan #')] = 1; og[2][dHdr.indexOf('Challan #')] = 1;
otherWb.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet(og);
const own = readOtherFormUse(new Uint8Array(XLSX.write(otherWb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
check(own.uses.length === 1 && own.uses[0].serial === '00001' && own.uses[0].amount === 30000, 'this tool\'s input workbook for the other form: 30,000 on challan 00001');

// 8. tax in whole rupees
const pz = XLSX.read(wbBytes);
const pg = XLSX.utils.sheet_to_json<unknown[]>(pz.Sheets['Deductees'], { header: 1, defval: null });
pg[1][dHdr.indexOf('Tax')] = 271.083; pg[2][dHdr.indexOf('Tax')] = 555.5;
pz.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet(pg);
const rounded = roundTax(new Uint8Array(XLSX.write(pz, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
check(rounded.rows === 2 && readForMatching(rounded.bytes).rows.map(x => x.tax).join() === '271,556', `tax rounded to rupees: ${readForMatching(rounded.bytes).rows.map(x => x.tax).join(', ')}`);
check(roundTax(wbBytes).rows === 0 && roundTax(wbBytes).bytes === wbBytes, 'whole-rupee tax: workbook unchanged');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
