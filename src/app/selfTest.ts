/**
 * Runs in the browser when the app opens: proves this deployment is running the tested engine.
 *  1. The frozen core builds the made-up Form 140 fixture byte-for-byte as the Python tool did
 *     (the file Protean's FVU 1.2 accepts).
 *  2. The challan split rules give the expected links on a made-up late-payment case.
 * If either fails, the app refuses to download return files.
 */
import { AGENT_VERSION, TARGET_FVU, buildStatement, encodeReturn } from '../protean.ts';
import { readInputWorkbook } from '../inputWorkbook.ts';
import { matchChallans, type ChallanIn, type RowIn } from '../challanMatch.ts';
import f140xlsx from '../../test/fixtures/f140.xlsx?url';
import f140txt from '../../test/fixtures/f140.txt?url';

export interface SelfTest { ok: boolean; checks: { ok: boolean; name: string }[] }

export async function runSelfTest(): Promise<SelfTest> {
  const checks: { ok: boolean; name: string }[] = [];
  const add = (ok: boolean, name: string) => checks.push({ ok, name });
  add(AGENT_VERSION === '2.6.0' && TARGET_FVU === '1.2', `Frozen core ${AGENT_VERSION} for FVU ${TARGET_FVU}`);
  try {
    const [x, t] = await Promise.all([fetch(f140xlsx).then(r => r.arrayBuffer()), fetch(f140txt).then(r => r.arrayBuffer())]);
    const expected = new Uint8Array(t);
    const d = new TextDecoder('latin1').decode(expected).split('^')[4];
    const inp = readInputWorkbook(x, '140', 2);
    const got = encodeReturn(buildStatement({ form: '140', deductor: inp.deductor!, challans: inp.challans, fyStart: 2026, quarter: 2,
      prevToken: '770000000000001', created: `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}` }));
    add(got.length === expected.length && got.every((b, i) => b === expected[i]), 'Return file identical to the tested Python output (Form 140 sample)');
  } catch (e) { add(false, `Return file sample could not be built: ${(e as Error).message}`); }
  try {
    const ch = (no: number, date: string, tax: number, interest = 0): ChallanIn =>
      ({ no, bsr: '1234567', serial: String(no).padStart(5, '0'), date, tax, interest, fee: 0, others: 0, majorHead: '', breakup: null });
    let n = 1;
    const row = (pan: string, code: string, date: string, tax: number): RowIn => ({ row: ++n, pan, name: '', code, dateDeducted: date, tax, challanNo: null });
    const r = matchChallans(
      [ch(1, '2026-09-06', 50000), ch(2, '2026-09-06', 8000), ch(3, '2026-09-07', 30000, 900), ch(4, '2026-09-07', 6000, 270), ch(5, '2026-10-30', 5000, 500)],
      [row('ABCPK1234Z', '1023', '2026-07-31', 12000), row('ABCPK1234Z', '1023', '2026-07-31', 8000), row('ABCCK1234Z', '1031', '2026-07-31', 6000),
        row('ABCCK1234Z', '1006', '2026-07-31', 4000), row('ABCPK1234Z', '1023', '2026-08-31', 15000), row('ABCCK1234Z', '1024', '2026-08-31', 8000)]);
    add(r.rows.map(x => x.challanNo).join(',') === '3,3,4,5,1,2', 'Challan split rules (late payment, same-date pair, top-up)');
  } catch (e) { add(false, `Challan rules failed: ${(e as Error).message}`); }
  return { ok: checks.every(c => c.ok), checks };
}
