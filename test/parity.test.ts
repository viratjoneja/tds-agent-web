/**
 * Parity test: the frozen web core must keep producing byte-for-byte the same return files as
 * the tested Python tool (tds-agent 2.6.0, whose files Protean's FVU 1.2 accepted).
 * Run from the repo root:  node test/parity.test.ts
 * Golden files: test/fixtures (made-up data), produced by the Python tool and FROZEN here —
 * never regenerate them in this repo. (test/make_fixtures.py is kept only as a record of how
 * they were made; it needs the separate tds-agent repo.)
 * Optional real-data check (kept OUT of the repo):  node test/parity.test.ts <input.xlsx> <expected.txt> <form> <fy> <quarter> <rrr> [<prev.fvu>]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatement, checkStatement, deductorFromFvu, encodeReturn, type Form } from '../src/protean.ts';
import { readInputWorkbook } from '../src/inputWorkbook.ts';
import { reviewModel } from '../src/review.ts';
import cols from '../src/template_columns.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

function run(xlsx: string, expectedTxt: string, form: Form, fy: number, quarter: 1 | 2 | 3 | 4, rrr: string, prevFvu?: string) {
  const expected = readFileSync(expectedTxt);
  const created = (() => { const d = expected.toString('latin1').split('^')[4]; return `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`; })();
  const inp = readInputWorkbook(readFileSync(xlsx), form, quarter);
  if (inp.missing.length) { check(false, `${xlsx}: input problems ${inp.missing.join('; ')}`); return; }
  const deductor = inp.deductor ?? deductorFromFvu(readFileSync(prevFvu!, 'latin1')).deductor;
  const lines = buildStatement({ form, deductor, challans: inp.challans, fyStart: fy, quarter, prevToken: rrr, created,
    salary: inp.salary ?? undefined });
  const got = Buffer.from(encodeReturn(lines));
  let firstDiff = -1;
  for (let i = 0; i < Math.max(got.length, expected.length); i++) if (got[i] !== expected[i]) { firstDiff = i; break; }
  check(firstDiff === -1, `${xlsx.split(/[\\/]/).pop()}: ${lines.length} lines identical to Python` +
    (firstDiff >= 0 ? ` - first difference at byte ${firstDiff}: TS "${got.toString('latin1').slice(firstDiff - 30, firstDiff + 30)}" vs PY "${expected.toString('latin1').slice(firstDiff - 30, firstDiff + 30)}"` : ''));
  const probs = checkStatement(lines, fy, quarter);
  check(probs.length === 0, `${form} Q${quarter}: checks clean${probs.length ? ' - ' + probs.join(' | ') : ''}`);
  const rv = reviewModel(lines);
  check(rv.totals.deducteeRows === lines.filter(l => l.split('^')[1] === 'DD').length && rv.problems.length === 0,
    `${form} Q${quarter}: review model - ${rv.totals.deducteeRows} rows, tax ${rv.totals.taxDeducted}, ${rv.salary ? rv.salary.length + ' salary records, ' : ''}${rv.pointsToReview.length} point(s) to review`);
  const back = deductorFromFvu(lines.join('\n')).deductor;
  check(back.tan === deductor.tan && back.responsible_pan === deductor.responsible_pan, `${form}: deductor read back from header`);
}

// 1. the frozen core is still the tds-agent 2.6.0 core (layout for FVU 1.2)
import { AGENT_VERSION, TARGET_FVU } from '../src/protean.ts';
check(AGENT_VERSION === '2.6.0' && TARGET_FVU === '1.2', `frozen core is tds-agent ${AGENT_VERSION}, FVU ${TARGET_FVU} layout`);
check(Object.keys(cols).length === 6 && (cols.SALARY_COLS as unknown[]).length === 65, 'template_columns.json unchanged (6 groups, 65 salary columns)');

// 1b. the blank template made in the browser has the Python template's sheets and headings
import * as XLSX from 'xlsx';
import { makeTemplate } from '../src/inputWorkbook.ts';
for (const form of ['138', '140', '143'] as Form[]) {
  const pyBook = XLSX.read(readFileSync(join(fx, { '138': 'f138q2', '140': 'f140', '143': 'f143' }[form] + '.xlsx')));
  const tsBook = XLSX.read(makeTemplate(form));
  const heads = (b: XLSX.WorkBook, sh: string) => JSON.stringify((XLSX.utils.sheet_to_json(b.Sheets[sh], { header: 1 })[0] ?? []));
  const same = JSON.stringify(tsBook.SheetNames) === JSON.stringify(pyBook.SheetNames) &&
    tsBook.SheetNames.every(sh => sh === 'Codes' || heads(tsBook, sh) === heads(pyBook, sh));
  check(same, `Form ${form}: browser template has the same sheets and headings as the Python template (${tsBook.SheetNames.join(', ')})`);
}

// 2. golden fixtures
if (process.argv.length > 2) {
  const [xlsx, txt, form, fy, q, rrr, prev] = process.argv.slice(2);
  run(xlsx, txt, form as Form, Number(fy), Number(q) as 1 | 2 | 3 | 4, rrr, prev);
} else {
  const cases = JSON.parse(readFileSync(join(fx, 'cases.json'), 'utf8')) as { name: string; form: Form; quarter: 1 | 2 | 3 | 4; rrr: string }[];
  for (const c of cases) run(join(fx, `${c.name}.xlsx`), join(fx, `${c.name}.txt`), c.form, 2026, c.quarter, c.rrr);
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
