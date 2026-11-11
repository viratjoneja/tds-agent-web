/**
 * v2.0.1 tests: Rate % cells formatted as an Excel percentage (stored 0.02, shown 2%) are read as 2.
 * Invented figures only.
 * Run from the repo root:  node test/phase6.test.ts
 */
import * as XLSX from 'xlsx';
import { normaliseRates } from '../src/app/rates.ts';
import { suggestSections } from '../src/sectionCodes.ts';
import { readForMatching } from '../src/challanMatch.ts';
import { readInputWorkbook } from '../src/inputWorkbook.ts';
import { buildStatement, encodeReturn } from '../src/protean.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

function book(rates: { v: number; z?: string }[]): Uint8Array {
  const hdr = ['Challan #', 'PAN', 'Name', 'Section code', 'Date paid', 'Date deducted', 'Amount', 'Rate %', 'Tax'];
  const aoa: unknown[][] = [hdr, ...rates.map((r, i) => [null, 'ABCPK1234Z', `Payee ${i + 1}`, '1023', '2026-07-31', '2026-07-31', 100000, r.v,
    r.z ? 100000 * r.v : 100000 * r.v / 100])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  rates.forEach((r, i) => { if (r.z) ws[XLSX.utils.encode_cell({ r: i + 1, c: 7 })].z = r.z; });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Challan #', 'BSR code', 'Date', 'Serial', 'Tax', 'Interest', 'Fee', 'Others']]), 'Challans');
  XLSX.utils.book_append_sheet(wb, ws, 'Deductees');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

// 1. percent-formatted cells become plain rates; plain numbers untouched
const mixed = book([{ v: 0.02, z: '0%' }, { v: 0.01, z: '0.00%' }, { v: 0.001, z: '0.0%' }, { v: 2 }, { v: 0.1 }]);
const out = normaliseRates(mixed);
check(out.rows === 3, `3 percent cells converted (got ${out.rows})`);
const rates = suggestSections(out.bytes, '140').map(r => r.rate);
check(JSON.stringify(rates) === JSON.stringify([2, 1, 0.1, 2, 0.1]), `rates read as [2,1,0.1,2,0.1] (got ${JSON.stringify(rates)})`);
const notes = suggestSections(out.bytes, '140').map(r => r.result.rateNote);
check(notes[1] === '', `1% under 1023 gives no rate note (got "${notes[1]}")`);

// 2. a workbook with no percent cells comes back byte-identical
const plain = book([{ v: 1 }, { v: 2 }]);
const same = normaliseRates(plain);
check(same.rows === 0 && same.bytes === plain, 'no percent cells: same bytes returned');

// 3. Tax = Amount x 0.02 (correct in Excel) no longer looks like "not divided by 100"
const before = readForMatching(book([{ v: 0.02, z: '0%' }]));
const after = readForMatching(normaliseRates(book([{ v: 0.02, z: '0%' }])).bytes);
check(after.problems.length === 0 && after.warnings.length === 0, `after: no Tax-column problem or warning (got ${JSON.stringify([...after.problems, ...after.warnings])})`);
console.log(`      (before the fix the check said: ${JSON.stringify([...before.problems, ...before.warnings]).slice(0, 120)}...)`);

// 4. end to end: the made-up f140 fixture with its rates turned into Excel percentages builds the same return
const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const src = XLSX.read(readFileSync(join(fx, 'f140.xlsx')), { cellNF: true });
const ws = src.Sheets['Deductees'];
const rg = XLSX.utils.decode_range(ws['!ref']!);
const rc = Array.from({ length: rg.e.c + 1 }, (_, c) => ws[XLSX.utils.encode_cell({ r: 0, c })]?.v).indexOf('Rate %');
let pctCells = 0;
for (let r = 1; r <= rg.e.r; r++) {
  const cell = ws[XLSX.utils.encode_cell({ r, c: rc })];
  if (cell && typeof cell.v === 'number') { cell.v = cell.v / 100; cell.z = '0.00%'; delete cell.w; pctCells++; }
}
const pctBook = new Uint8Array(XLSX.write(src, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
if (process.argv[2]) writeFileSync(process.argv[2], pctBook);   // optional: save it for a browser check
const fixed = normaliseRates(pctBook);
check(fixed.rows === pctCells && pctCells > 0, `fixture: ${fixed.rows} of ${pctCells} percent cells converted`);
const build = (b: Uint8Array) => {
  const inp = readInputWorkbook(b, '140', 2);
  const lines = buildStatement({ form: '140', deductor: inp.deductor!, challans: inp.challans, fyStart: 2026, quarter: 2, prevToken: '770000000000001', created: '2026-11-05' });
  return Buffer.from(encodeReturn(lines)).toString('latin1').split('\r\n').slice(1).join();
};
const exp = readFileSync(join(fx, 'f140.txt')).toString('latin1').split('\r\n').slice(1).join();
check(build(fixed.bytes) === exp, 'percent-formatted fixture gives the same return as the accepted fixture');
check(build(pctBook) !== exp, 'without the fix the return would differ (rate 0.02 instead of 2)');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
