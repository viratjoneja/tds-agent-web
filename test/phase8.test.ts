/**
 * v2.4 tests: data checks at upload, the late-deduction rule, and the formatted reports. Invented figures only.
 * Run from the repo root:  node test/phase8.test.ts
 */
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedLateDeductions, checkUpload, lateDeductionMonths, quarterRange } from '../src/dataChecks.ts';
import { makeTemplateFull, matchChallans, readForMatching } from '../src/challanMatch.ts';
import { readInputWorkbook } from '../src/inputWorkbook.ts';
import { buildStatement, checkStatement } from '../src/protean.ts';
import { reviewModel } from '../src/review.ts';
import { checksReport, fullReport, setoffReport } from '../src/app/report.ts';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

// a made-up workbook: one good row, one late deduction, and rows with mistakes
const tpl = XLSX.read(makeTemplateFull('140'));
const dh = XLSX.utils.sheet_to_json<string[]>(tpl.Sheets['Deductees'], { header: 1 })[0];
const row = (v: Record<string, unknown>) => dh.map(h => v[h] ?? null);
const base = { 'Section code': '1023', 'Section (as in working)': '1023', 'Rate %': 1 };
tpl.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet([dh,
  row({ ...base, PAN: 'ABCPA1111A', Name: 'Good Payee', 'Date paid / credited': '15/07/2026', 'Date deducted': '15/07/2026', Amount: 100000, Tax: 1000 }),
  row({ ...base, PAN: 'ABCPB2222B', Name: 'Late Payee', 'Date paid / credited': '10/06/2026', 'Date deducted': '24/07/2026', Amount: 48000, Tax: 480 }),
  row({ ...base, PAN: 'ABCP1234', Name: 'Bad PAN', 'Date paid / credited': '15/08/2026', 'Date deducted': '15/08/2026', Amount: 5000, Tax: 50 }),
  row({ ...base, PAN: 'ABCPD4444D', Name: 'Next Quarter', 'Date paid / credited': '05/10/2026', 'Date deducted': '05/10/2026', Amount: 5000, Tax: 50 }),
  row({ ...base, PAN: 'ABCPE5555E', Name: 'Too Much Tax', 'Date paid / credited': '20/09/2026', 'Date deducted': '20/09/2026', Amount: 500, Tax: 5000 }),
]);
const wbBytes = new Uint8Array(XLSX.write(tpl, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

// 1. data checks at upload
const r = checkUpload(wbBytes, 2026, 2);
const errRows = [...new Set(r.errors.map(e => e.row))].sort((a, b) => a - b);
check(r.rows === 5, `5 rows checked (got ${r.rows})`);
check(JSON.stringify(errRows) === '[4,5,6]', `rows 4 (PAN), 5 (next quarter), 6 (tax > amount) must be fixed (got ${JSON.stringify(errRows)})`);
check(r.errors.some(e => e.row === 5 && /later quarter/.test(e.fix)) && r.errors.some(e => e.row === 6 && /more than the amount/.test(e.message)), 'plain words and what to do for each');
check(r.late.length === 1 && r.late[0].row === 3 && r.late[0].months === 2 && r.late[0].interest === 10, `late deduction found: paid June, deducted July -> 2 months, about Rs 10 (got ${JSON.stringify(r.late)})`);
check(lateDeductionMonths('2026-07-05', '2026-07-31') === 0 && lateDeductionMonths('2026-06-29', '2026-08-31') === 3, 'late-deduction months: same month 0; June to August 3');
check(quarterRange(2026, 4).from === '2027-01-01' && quarterRange(2026, 4).to === '2027-03-31', 'Q4 is January to March of the next calendar year');

// 2. the frozen core flags the earlier payment date; the app treats it as a late deduction (Protean's FVU accepts it)
const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const inp = readInputWorkbook(readFileSync(join(fx, 'f140.xlsx')), '140', 2);
inp.challans[0].deductees[0].date_paid = '2026-06-10';
const lines = buildStatement({ form: '140', deductor: inp.deductor!, challans: inp.challans, fyStart: 2026, quarter: 2, prevToken: '770000000000001', created: '2026-11-05' });
const probs = checkStatement(lines, 2026, 2);
const split = allowedLateDeductions(probs, lines, 2026, 2);
check(probs.some(p => /field 19\) outside Q2/.test(p)) && split.blocking.length === 0 && split.late.length === 1 && /late deduction/.test(split.late[0]),
  `frozen core: ${probs.length} date problem(s); app: 0 blocking, 1 late deduction`);
const inp2 = readInputWorkbook(readFileSync(join(fx, 'f140.xlsx')), '140', 2);
inp2.challans[0].deductees[0].date_paid = '2026-10-10';
const lines2 = buildStatement({ form: '140', deductor: inp2.deductor!, challans: inp2.challans, fyStart: 2026, quarter: 2, prevToken: '770000000000001', created: '2026-11-05' });
check(allowedLateDeductions(checkStatement(lines2, 2026, 2), lines2, 2026, 2).blocking.length === 1, 'a payment AFTER the quarter still blocks');

// 3. reports open and have the expected sheets
const sheetNames = async (b: Uint8Array) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(b as unknown as ArrayBuffer); return wb.worksheets.map(w => w.name); };
const cr = await checksReport(r, { form: '140', fy: 2026, quarter: 2 });
check((await sheetNames(cr)).join() === 'Checks', 'data-check report: one Checks sheet');
const fxBook = readFileSync(join(fx, 'f140.xlsx'));
const m = readForMatching(fxBook);
const so = { challans: m.challans, rows: m.rows, result: matchChallans(m.challans, m.rows, { form: '140' }) };
const rv = reviewModel(buildStatement({ form: '140', deductor: inp2.deductor!, challans: readInputWorkbook(fxBook, '140', 2).challans, fyStart: 2026, quarter: 2, prevToken: '770000000000001', created: '2026-11-05' }));
const full = await fullReport({ meta: { deductor: rv.deductor, tan: rv.tan, form: '140', fy: 2026, quarter: 2 }, rv, setoff: so, workbook: new Uint8Array(fxBook), checks: null, problems: [], points: [], late: [], csi: [] });
const names = await sheetNames(full);
check(names.join() === 'Dashboard,Entries → challans,Challan set-off,Challan by section,Section × challan,Checks,Deductor', `full report sheets: ${names.join(', ')}`);
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(full as unknown as ArrayBuffer);
const entries = wb.getWorksheet('Entries → challans')!;
const hdr = (entries.getRow(4).values as unknown[]).map(String);
check(hdr.includes('Section') && hdr.includes('Nature') && hdr.includes('Challan') && hdr.includes('How linked') && entries.rowCount >= 4 + m.rows.length,
  `entries sheet maps every row (${m.rows.length}) to its section and challan`);
const so2 = await setoffReport({ meta: { form: '140', fy: 2026, quarter: 2 }, setoff: so, workbook: new Uint8Array(fxBook) });
check((await sheetNames(so2)).includes('Challan set-off'), 'set-off report from the challan step opens');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
