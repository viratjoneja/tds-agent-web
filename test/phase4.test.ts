/**
 * Phase 4 tests: challan receipt reader + masked AI proposals. All figures and identifiers are invented;
 * Gemini is never called (its answers are mocked).
 * Run from the repo root:  node test/phase4.test.ts
 */
import * as XLSX from 'xlsx';
import { addChallansToWorkbook, fromGemini, geminiChallanRequest, maskReceiptText, parseChallanReceipt } from '../src/challanPdf.ts';
import { assertMasked, applyProposals, checkProposals, geminiExceptionRequest, maskedPayload } from '../src/aiExceptions.ts';
import { makeTemplateFull, matchChallans, readForMatching, BREAKUP_COLUMN, MAJOR_HEAD_COLUMN, type ChallanIn, type RowIn } from '../src/challanMatch.ts';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

// ---------------------------------------------------------------- 4a: receipt text (invented, laid out like the portal receipt)
const receipt = (o: { serial?: string; tender?: string; t1?: string; t2?: string; tax?: string; int?: string; total?: string; amount?: string } = {}) => `
Challan Receipt
ITNS No. : 281
TAN : ABCD12345E
Name : MADE UP TRADERS PRIVATE LIMITED
Assessment Year : 2027-28
Financial Year : 2026-27
Major Head : Corporation Tax (0020)
Minor Head : TDS/TCS Payable by Taxpayer (200)
Amount (in Rs.) : ₹ ${o.amount ?? '12,345'}
Amount (in words) : Rupees Twelve Thousand Three Hundred Forty Five Only
CIN : 26080700012345BANK
Mode of Payment : Net Banking
Bank Name : Made Up Bank
Bank Reference Number : 0000ABC123
Date of Deposit : 07-Aug-2026
BSR code : 1234567
Challan No : ${o.serial ?? '00042'}
Tender Date : ${o.tender ?? '07/08/2026'}
TDS/TCS Section-Wise Payment Details
Section Tax Surcharge Cess Total
1023 ₹ ${o.t1 ?? '10,000'} ₹ 0 ₹ 0 ₹ ${o.t1 ?? '10,000'}
1073 ₹ ${o.t2 ?? '2,000'} ₹ 0 ₹ 0 ₹ ${o.t2 ?? '2,000'}
Tax Breakup Details (Amount In Rs.)
A Tax ₹ ${o.tax ?? '12,000'}
B Surcharge ₹ 0
C Education Cess ₹ 0
D Interest ₹ ${o.int ?? '345'}
E Penalty ₹ 0
F Fee under section 427 ₹ 0
G Others ₹ 0
Total (A+B+C+D+E+F+G) ₹ ${o.total ?? '12,345'}
`;
let r = parseChallanReceipt(receipt());
check(r.ok && r.receipt!.bsr === '1234567' && r.receipt!.serial === '00042' && r.receipt!.tenderDate === '2026-08-07' && r.receipt!.majorHead === '0020',
  'receipt read: BSR, serial, tender date, major head');
check(r.ok && r.receipt!.tax === 12000 && r.receipt!.interest === 345 && JSON.stringify(r.receipt!.breakup) === '{"1023":10000,"1073":2000}',
  'receipt read: tax, interest and section breakup');
r = parseChallanReceipt(receipt({ t2: '1,000' }));
check(!r.ok && /table was not read completely/.test(r.problems.join()), 'section amounts not adding up to tax: receipt refused');
r = parseChallanReceipt(receipt({ total: '12,000' }));
check(!r.ok && /does not add up/.test(r.problems.join()), 'breakup not adding to the total: receipt refused');
r = parseChallanReceipt('Form 16A acknowledgement for something else');
check(!r.ok && /not recognised/.test(r.problems[0]), 'other PDFs: not treated as a challan');

const masked = maskReceiptText(receipt());
check(!/ABCD12345E|MADE UP TRADERS|26080700012345BANK|0000ABC123/.test(masked) && /1023 ₹ 10,000/.test(masked), 'masked receipt text: TAN, name, CIN and bank reference removed; amounts kept');
let threw = false; try { geminiChallanRequest(receipt()); } catch { threw = true; }
check(threw, 'unmasked receipt text: Gemini request refused');
check(!!geminiChallanRequest(masked).responseSchema, 'masked receipt text: Gemini request built');
const g = fromGemini(JSON.stringify({ bsr: '1234567', challanNo: '42', tenderDate: '07/08/2026', majorHead: '0020', minorHead: '200', tax: 12000, interest: 345, total: 12345, sections: [{ code: '1023', amount: 10000 }, { code: '1073', amount: 2000 }] }));
check(g.ok && g.receipt!.source === 'gemini' && g.receipt!.serial === '00042', 'Gemini answer passes the same cross-checks');
check(!fromGemini(JSON.stringify({ bsr: '1234567', challanNo: '42', tenderDate: '07/08/2026', majorHead: '0020', tax: 12000, total: 99999, sections: [{ code: '1023', amount: 12000 }] })).ok,
  'Gemini answer that does not add up: refused');

// receipts onto the Challans sheet, then read back by the matcher
const wb = addChallansToWorkbook(makeTemplateFull('143'), [parseChallanReceipt(receipt()).receipt!, parseChallanReceipt(receipt({ serial: '00043', tender: '07/09/2026', t1: '0', t2: '3,000', tax: '3,000', int: '0', total: '3,000', amount: '3,000' })).receipt!]);
const back = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.read(wb).Sheets['Challans']);
check(back.length === 2 && back[0][MAJOR_HEAD_COLUMN] === '0020' && back[1][BREAKUP_COLUMN] === '1023=0; 1073=3000' && back[0]['Interest'] === 345,
  'receipts written to the Challans sheet with major head and section breakup');
check(readForMatching(wb).challans.length === 2, 'matcher reads the challans written from receipts');

// ---------------------------------------------------------------- 4b: masked proposals
const ch = (no: number, date: string, tax: number, extra: Partial<ChallanIn> = {}): ChallanIn =>
  ({ no, bsr: '1234567', serial: String(no).padStart(5, '0'), date, tax, interest: 0, fee: 0, others: 0, majorHead: '', breakup: null, ...extra });
let n = 1;
const row = (pan: string, code: string, date: string, tax: number): RowIn => ({ row: ++n, pan, name: `Payee ${n}`, code, dateDeducted: date, tax, challanNo: null });
const IND = 'ABCPK1234Z', CO = 'ABCCK1234Z';

// two same-date challans that both fit -> exception left by the rules
const challans = [ch(1, '2026-08-07', 9500), ch(2, '2026-08-07', 9600), ch(3, '2026-08-07', 9700)];   // three challans, same date, no major head: rules cannot choose
const rows = [row(IND, '1023', '2026-07-31', 4000), row(IND, '1023', '2026-07-31', 5000), row(CO, '1024', '2026-07-31', 9000)];
const res = matchChallans(challans, rows);
const payload = maskedPayload(challans, rows, res);
const ps = JSON.stringify(payload);
check(!/ABCPK1234Z|ABCCK1234Z|Payee|1234567|"serial"/.test(ps) && payload.rows.every(x => x.payee) , 'payload: no PAN, name, BSR or serial; payee type only');
let blocked = false; try { assertMasked({ rows: [{ pan: 'ABCPK1234Z' }] }); } catch { blocked = true; }
check(blocked, 'payload guard: anything that looks like a PAN stops the request');
check(!!geminiExceptionRequest(payload).responseSchema, 'exception request built from the masked payload');

const open = res.rows.filter(x => x.status === 'exception').map(x => x.row);
const answer = JSON.stringify({ proposals: [
  { rows: [2, 3], challan: 1, explanation: 'Non-company rows to the 0021 challan' },
  { rows: [4], challan: 2, explanation: 'Company row to the 0020 challan' },
  { rows: [99], challan: 1, explanation: 'made-up row' },
  { rows: [2], challan: 3, explanation: 'second link for row 2' },
] });
const checked = checkProposals(answer, challans, rows, res);
check(open.length === 3, `rules left ${open.length} rows open (same-date challans)`);
check(checked.proposals[0].verdict === 'accepted' && checked.proposals[1].verdict === 'accepted', 'sound proposals accepted after the rule checks');
check(checked.proposals[2].verdict === 'rejected' && /does not exist/.test(checked.proposals[2].checks[0]), 'a row that does not exist: rejected');
check(checked.proposals[3].verdict === 'rejected' && /two proposals/.test(checked.proposals[3].checks.join()), 'a row linked twice: rejected');
check(checkProposals('not json', challans, rows, res).problems.length === 1, 'bad AI answer: reported, nothing applied');

const applied = applyProposals(challans, rows, res, checked.proposals);
check(applied.result.rows.every(x => x.status !== 'exception') && applied.links.map(l => `${l.row}:${l.challanNo}`).join() === '2:1,3:1,4:2',
  `accepted proposals applied and re-checked by the rules: ${applied.links.map(l => `${l.row}->${l.challanNo}`).join(', ')}`);

// rule-bending proposal: duplicate challan used to fund a later month -> needs approval
n = 1;
const dupCh = [ch(1, '2026-08-07', 20000, { majorHead: '0021' }), ch(2, '2026-08-07', 20000, { majorHead: '0021' })];
const sepRows = [row(IND, '1023', '2026-09-30', 3000)];
const dupRes = matchChallans(dupCh, sepRows);
const dupChecked = checkProposals(JSON.stringify({ proposals: [{ rows: [2], challan: 2, explanation: 'Duplicate August deposit used for September' }] }), dupCh, sepRows, dupRes);
check(dupChecked.proposals[0].verdict === 'needs-approval' && dupChecked.proposals[0].checks.some(c => /before the deduction/.test(c)) && dupChecked.proposals[0].checks.some(c => /duplicate/.test(c)),
  'duplicate challan funding a later month: needs the user\'s approval, with the reasons');

// too much for a section share -> needs approval; too much for the challan -> rejected
n = 1;
const shCh = [ch(1, '2026-08-07', 10000, { majorHead: '0021', breakup: { 1023: 2000, 1073: 8000 } })];
const shRows = [row(IND, '1023', '2026-07-31', 3000)];
const shRes = matchChallans(shCh, shRows);
check(shRes.rows[0].status === 'matched' && /share for section 1073 \(another return\)/.test(shRes.rows[0].reason) && /check the other return/.test(shRes.challans[0].notes.join()),
  'no room in the shares for this return: the other share is used as a last resort, with a note to check that return');
n = 1;
const bigRows = [row(IND, '1023', '2026-07-31', 50000)];
const bigRes = matchChallans(shCh, bigRows);
check(checkProposals(JSON.stringify({ proposals: [{ rows: [2], challan: 1, explanation: 'x' }] }), shCh, bigRows, bigRes).proposals[0].verdict === 'rejected', 'more than the challan holds: rejected');

console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
