/**
 * Phase 2 tests: section codes from the section as written in the working.
 * Run from the repo root:  node test/phase2.test.ts
 * Spellings below are the kinds seen in real Q2 workings (sheet titles, loose codes); PANs are made up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { buildStatement, encodeReturn, type Form } from '../src/protean.ts';
import { readInputWorkbook } from '../src/inputWorkbook.ts';
import { applySections, makeTemplateWithSection, resolveSection, SECTION_TEXT_COLUMN, suggestSections } from '../src/sectionCodes.ts';

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

const IND = 'ABCPK1234Z', FIRM = 'ABCFK1234Z', CO = 'ABCCK1234Z';
type Case = [string, string, number | null, Form, string | undefined, string];   // text, pan, rate, form, deductorType, expected
const cases: Case[] = [
  // contract: payee type from PAN
  ['194C', IND, 1, '140', undefined, '1023'], ['194 C', FIRM, 2, '140', undefined, '1024'], ['94C', CO, 2, '140', undefined, '1024'],
  ['CONTT. 194 C', IND, 1, '140', undefined, '1023'], ['Contractor', FIRM, 2, '140', undefined, '1024'],
  ['Job work', IND, 1, '140', undefined, '1023'], ['194C', '', 1, '140', undefined, 'choose'],
  // fees
  ['194J(b)', IND, 10, '140', undefined, '1027'], ['194JB', FIRM, 10, '140', undefined, '1027'], ['194J(a)', CO, 2, '140', undefined, '1026'],
  ['PROFF. 194 J', IND, 10, '140', undefined, '1027'], ['194J', CO, 2, '140', undefined, '1026'], ['194J', IND, 10, '140', undefined, '1027'],
  ['194J director sitting fee', IND, 10, '140', undefined, '1028'], ['Technical services', CO, 2, '140', undefined, '1026'], ['194J', IND, null, '140', undefined, 'choose'],
  // rent
  ['RENT BUILDING 194 I', IND, 10, '140', undefined, '1009'], ['194I(a)', CO, 2, '140', undefined, '1008'], ['194-I(b)', IND, 10, '140', undefined, '1009'],
  ['Rent of machinery', CO, 2, '140', undefined, '1008'], ['194I', IND, null, '140', undefined, 'choose'],
  // others
  ['194h', IND, 2, '140', undefined, '1006'], ['94Q', CO, 0.1, '140', undefined, '1031'], ['PURCHASE GOODS 194 Q', CO, 0.1, '140', undefined, '1031'],
  ['94T', IND, 10, '140', undefined, '1067'], ['Partner remuneration', IND, 10, '140', undefined, '1067'], ['194A', IND, 10, '140', undefined, '1022'],
  ['194A bank interest', IND, 10, '140', undefined, 'choose'], ['Sec. 194 Q', CO, 0.1, '140', undefined, '1031'],
  // ITA 2025 references
  ['393(1)-6(i).D(a)', CO, 2, '140', undefined, '1023'], ['393(1)-6(i)', IND, 1, '140', undefined, '1023'], ['393(3)-7', IND, 10, '140', undefined, '1067'],
  ['393(1)-6(iii).D(b)', IND, 10, '140', undefined, '1027'], ['393(1)-8(ii)', CO, 0.1, '140', undefined, '1031'],
  // codes given
  ['1024', FIRM, 2, '140', undefined, '1024'], ['394(1)-4~1073', FIRM, 2, '143', undefined, '1073'],
  // salary: from the deductor type
  ['SALARY 92B', IND, null, '138', 'K', '1002'], ['192', IND, null, '138', 'A', '1003'], ['Salary', IND, null, '138', 'S', '1001'],
  ['392', IND, null, '138', undefined, 'choose'],
  // TCS
  ['206C(1) scrap', FIRM, 2, '143', undefined, '1073'], ['Sale of scrap', FIRM, 2, '143', undefined, '1073'], ['394(1)-4', FIRM, 2, '143', undefined, '1073'],
  ['206C(1F) motor vehicle', IND, 1, '143', undefined, '1075'], ['206C', IND, 1, '143', undefined, 'choose'],
  // wrong form / unsupported / unknown -> error, never a guess
  ['194IA', IND, 1, '140', undefined, 'error'], ['194C', IND, 1, '143', undefined, 'error'], ['195', CO, 10, '140', undefined, 'error'],
  ['206C(1H)', CO, 0.1, '143', undefined, 'error'], ['Miscellaneous', IND, 1, '140', undefined, 'error'], ['194P', IND, null, '138', 'K', 'error'],
];
let ok = 0;
for (const [text, pan, rate, form, dt, want] of cases) {
  const r = resolveSection({ text, pan, rate, form, deductorType: dt });
  const got = r.status === 'choose' || r.status === 'error' ? r.status : r.code;
  if (got === want) ok++; else check(false, `"${text}" (${pan || 'no PAN'}, ${rate}%, Form ${form}) -> ${got} (${r.reason}); expected ${want}`);
}
check(ok === cases.length, `${ok}/${cases.length} section spellings resolved as expected`);

const r1 = resolveSection({ text: '393(1)-6(i).D(a)', pan: CO, rate: 2, form: '140' });
check(r1.code === '1023' && /SOP rule 11/.test(r1.rateNote), 'company at 2% under 1023 keeps 1023 and gets a rate note (SOP rule 11)');
const r2 = resolveSection({ text: '194C', pan: IND, rate: 1, form: '140' });
check(/individual\/HUF/.test(r2.reason), `every result says why: "${r2.reason}"`);
const r3 = resolveSection({ text: '194J', pan: IND, rate: null, form: '140' });
check(r3.options.map(o => o.code).join() === '1026,1027,1028', 'unclear 194J offers 1026 / 1027 / 1028 to choose from');

// workbook: template with the extra column, suggestions, apply -> core builds the same return as with codes typed in
const tpl = XLSX.read(makeTemplateWithSection('140'));
const hdr = XLSX.utils.sheet_to_json<string[]>(tpl.Sheets['Deductees'], { header: 1 })[0];
check(hdr[hdr.indexOf('Section code') + 1] === SECTION_TEXT_COLUMN, `template has "${SECTION_TEXT_COLUMN}" next to "Section code"`);

const src = XLSX.read(readFileSync(join(fx, 'f140.xlsx')));
const ws = src.Sheets['Deductees'];
const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
const ci = (grid[0] as string[]).indexOf('Section code');
const texts = ['194C', '194J(b)', 'PURCHASE GOODS 194 Q'];                 // what the working says for the 3 rows
grid[0].push(SECTION_TEXT_COLUMN);
grid.slice(1).forEach((r, k) => { r[ci] = null; r.push(texts[k]); });
src.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet(grid);
const noCodes = XLSX.write(src, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
check(readInputWorkbook(noCodes, '140', 2).missing.length === 3, 'without codes the core reader lists 3 rows to fill');
const sug = suggestSections(noCodes, '140');
check(sug.length === 3 && sug.every(s => s.result.status === 'auto'), `suggestions: ${sug.map(s => `${s.text} -> ${s.result.code}`).join(', ')}`);
const filled = applySections(noCodes, sug.map(s => ({ row: s.row, code: s.result.code })));
const inp = readInputWorkbook(filled, '140', 2);
const lines = buildStatement({ form: '140', deductor: inp.deductor!, challans: inp.challans, fyStart: 2026, quarter: 2,
  prevToken: '770000000000001', created: '2026-11-05' });
const expected = readFileSync(join(fx, 'f140.txt'));
const got = Buffer.from(encodeReturn(lines));
const same = expected.toString('latin1').split('\r\n').slice(1).join() === got.toString('latin1').split('\r\n').slice(1).join();
check(inp.missing.length === 0 && same, 'codes worked out from the section text give the same return as the hand-coded fixture');

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
