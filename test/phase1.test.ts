/**
 * Phase 1 tests: CSI checks and FVU result reader, on made-up files that copy the layout of real
 * Protean FVU 1.2 output. Run from the repo root:  node test/phase1.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatement, TARGET_FVU } from '../src/protean.ts';
import { readInputWorkbook } from '../src/inputWorkbook.ts';
import { reviewModel } from '../src/review.ts';
import { checkCsi, parseCsi } from '../src/csi.ts';
import { compareStatistics, readErrFile, readStatistics, readWarningFile } from '../src/fvuResult.ts';

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

// the made-up Form 143 return (1 challan dated 07-08-2026, 2 collectee rows)
const inp = readInputWorkbook(readFileSync(join(fx, 'f143.xlsx')), '143', 2);
const lines = buildStatement({ form: '143', deductor: inp.deductor!, challans: inp.challans, fyStart: 2026, quarter: 2,
  prevToken: '770000000000001', created: '2026-10-10' });

// --- CSI
const csiText = readFileSync(join(fx, 'ABCD12345E101026.csi'), 'latin1');
const csi = parseCsi(csiText, 'ABCD12345E101026 (1).csi');
check(csi.tan === 'ABCD12345E' && csi.challanCount === 2 && csi.encodedLines === 2, 'CSI header read: TAN, 2 challans, 2 encoded lines');
check(csi.downloadedOn === '2026-10-10', `download date from file name: ${csi.downloadedOn}`);
check(csi.validName === 'ABCD12345E101026.csi', `valid name for the FVU: ${csi.validName} (from "ABCD12345E101026 (1).csi")`);
let f = checkCsi(csi, lines, TARGET_FVU);
check(!f.some(x => x.level === 'error'), 'matching CSI: no errors');
check(f.some(x => x.level === 'info' && /Save the CSI as/.test(x.message)), 'suggests renaming the CSI');

f = checkCsi({ ...csi, tan: 'WXYZ98765A' }, lines, TARGET_FVU);
check(f.some(x => x.level === 'error' && /TAN WXYZ98765A/.test(x.message)), 'CSI for another TAN is an error');
f = checkCsi({ ...csi, downloadedOn: '2026-08-01' }, lines, TARGET_FVU);
check(f.some(x => x.level === 'error' && /before the challan/.test(x.message)), 'CSI downloaded before the challan date is an error');
f = checkCsi({ ...csi, downloadedOn: '2026-08-09' }, lines, TARGET_FVU);
check(f.some(x => x.level === 'warning' && /2 day/.test(x.message)), 'CSI downloaded 2 days after the challan is a warning');
f = checkCsi({ ...csi, challanCount: 0, encodedLines: 0 }, lines, TARGET_FVU);
check(f.some(x => x.level === 'warning' && /lists only 0/.test(x.message)), 'more challans in the return than in the CSI is a warning');
let threw = false; try { parseCsi('hello', 'x.csi'); } catch { threw = true; }
check(threw, 'a file that is not a CSI is rejected');

// --- FVU .err
const errs = readErrFile(readFileSync(join(fx, 'sample.err'), 'latin1'), lines);
check(errs.length === 3, `.err read: ${errs.length} errors`);
check(errs[0].code === 'T-FV-4092' && /^Challan 1, row 1: /.test(errs[0].where) && /4 decimal/.test(errs[0].hint), `error tied to its row: "${errs[0].where}"`);
check(/^Challan 1 \(BSR 1234567/.test(errs[1].where), `challan error tied to its challan: "${errs[1].where}"`);
check(errs[2].code === 'T_FV_6417' && /collectee code/.test(errs[2].hint), 'underscore-style codes (T_FV_6417) get their hint too');

// --- FVU warning file
const warns = readWarningFile(readFileSync(join(fx, 'sample_Electronic_Statement_Warning_File.html'), 'latin1'), lines);
check(warns.length === 1 && warns[0].code === 'T-FV-3141' && /not in the CSI/.test(warns[0].hint), 'warning file read: challan not in CSI, with hint');

// --- FVU statistics
const st = readStatistics(readFileSync(join(fx, 'sample_stats.html'), 'latin1'));
check(st['No. of Challans'] === '1' && st['No. of Party Records'] === '2', `statistics read: ${st['No. of Challans']} challan, ${st['No. of Party Records']} party records`);
const totals = reviewModel(lines).totals;
check(compareStatistics(st, totals).length === 0, 'statistics agree with the return totals');
check(compareStatistics({ ...st, 'No. of Party Records': '3' }, totals).length === 1, 'a difference in statistics is reported');

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
