/**
 * Formatted Excel reports (ExcelJS, loaded only when a download is clicked).
 *  - fullReport: Dashboard, Entries -> challans (every row: section, challan, how it was linked),
 *    Challan set-off, Section x challan, Checks, Deductor.
 *  - setoffReport: the challan step's view (same sheets without the built return).
 *  - checksReport: the data checks at upload.
 * Display only: every figure comes from the engine (match result, review model, data checks).
 */
import * as XLSX from 'xlsx';
import type { ChallanIn, MatchResult, RowIn } from '../challanMatch.ts';
import type { DataCheckResult } from '../dataChecks.ts';
import { issueRecords, lateRecords } from '../dataChecks.ts';
import type { ReviewModel } from '../review.ts';
import { sectionName, sectionRef } from './sectionNames.ts';

type ExcelJSNs = typeof import('exceljs');
type WB = import('exceljs').Workbook;
type WS = import('exceljs').Worksheet;
async function excel(): Promise<ExcelJSNs> { const m = await import('exceljs'); return ((m as unknown as { default?: ExcelJSNs }).default ?? m) as ExcelJSNs; }

export interface ReportMeta { deductor?: string; tan?: string; form: string; fy: number; quarter: number; file?: string }
export interface SetOff { challans: ChallanIn[]; rows: RowIn[]; result: MatchResult }

// ---------------------------------------------------------------- look
const C = {
  navy: 'FF1F3A5F', blue: 'FF1F4FD6', blueSoft: 'FFE8EEFC', green: 'FF157347', greenSoft: 'FFE6F4EA', amber: 'FF9A6200', amberSoft: 'FFFFF4E0',
  red: 'FFB42318', redSoft: 'FFFDECEA', grey: 'FF667085', band: 'FFF6F7F9', line: 'FFD9DEE7', white: 'FFFFFFFF', purple: 'FF6D4BC3', purpleSoft: 'FFF0EBFB', teal: 'FF0F766E', tealSoft: 'FFE6F6F4',
};
const INR = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';
const INR2 = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
const FORM_NAME: Record<string, string> = { '138': 'Form 138 (24Q, salary)', '140': 'Form 140 (26Q, non-salary)', '141': 'Form 141', '143': 'Form 143 (27EQ, TCS)', '144': 'Form 144 (27Q, non-residents)' };
const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
const thin = { style: 'thin' as const, color: { argb: C.line } };
const box = { top: thin, left: thin, bottom: thin, right: thin };
const dmy = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : d ?? '');
const secFull = (k: string) => (/^\d{4}$/.test(k) ? `${sectionName(k)} (${k})` : sectionName(k));

function title(ws: WS, text: string, sub: string, cols: number) {
  ws.mergeCells(1, 1, 1, cols); ws.mergeCells(2, 1, 2, cols);
  const t = ws.getCell(1, 1); t.value = text; t.font = { bold: true, size: 15, color: { argb: C.white } }; t.fill = fill(C.navy); t.alignment = { vertical: 'middle', indent: 1 };
  const s = ws.getCell(2, 1); s.value = sub; s.font = { size: 10, color: { argb: C.grey } }; s.alignment = { indent: 1 };
  ws.getRow(1).height = 28;
}
function heading(ws: WS, row: number, text: string, cols: number, color = C.blue) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1); c.value = text; c.font = { bold: true, size: 12, color: { argb: color } };
  c.border = { bottom: { style: 'medium', color: { argb: color } } };
  ws.getRow(row).height = 20;
}
export interface Col { header: string; key: string; width?: number; fmt?: string; wrap?: boolean }
/** A banded table with a coloured header, borders and number formats. Returns the last row used. */
function table(ws: WS, top: number, cols: Col[], rows: Record<string, unknown>[], opts: { filter?: boolean; total?: string[]; rowFill?: (r: Record<string, unknown>) => string | undefined; headFill?: string } = {}): number {
  const head = ws.getRow(top);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1); if (!c.key.startsWith('_')) cell.value = c.header;
    cell.font = { bold: true, color: { argb: C.white }, size: 10 }; cell.fill = fill(opts.headFill ?? C.navy);
    cell.alignment = { vertical: 'middle', horizontal: c.fmt ? 'right' : 'left', wrapText: true }; cell.border = box;
    if (c.width) { const col = ws.getColumn(i + 1); col.width = Math.max(col.width ?? 0, c.width); }
  });
  head.height = 30;
  if (!rows.length) { const c0 = ws.getCell(top + 1, 1); c0.value = 'None'; c0.font = { color: { argb: C.green }, size: 10 }; return top + 1; }
  rows.forEach((r, k) => {
    const row = ws.getRow(top + 1 + k);
    const rf = opts.rowFill?.(r) ?? (k % 2 ? C.band : undefined);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1); const v = r[c.key];
      if (!c.key.startsWith('_')) cell.value = (v === undefined ? null : v) as import('exceljs').CellValue;
      if (c.fmt) cell.numFmt = c.fmt;
      cell.alignment = { vertical: 'top', wrapText: !!c.wrap };
      cell.border = box; if (rf) cell.fill = fill(rf);
      cell.font = { size: 10 };
    });
  });
  let last = top + rows.length;
  if (opts.total && rows.length) {
    last++;
    const row = ws.getRow(last);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (i === 0) cell.value = 'Total';
      else if (c.key.startsWith('_')) { /* part of a merged cell */ }
      else if (opts.total!.includes(c.key)) { const L = colLetter(i + 1); cell.value = { formula: `SUM(${L}${top + 1}:${L}${top + rows.length})` }; cell.numFmt = c.fmt ?? INR; }
      cell.font = { bold: true, size: 10 }; cell.fill = fill(C.blueSoft); cell.border = box;
    });
  }
  if (opts.filter && rows.length) ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top + rows.length, column: cols.length } };
  return last;
}
const colLetter = (n: number) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
function dataBar(ws: WS, ref: string, argb = 'FF5B8DEF') {
  ws.addConditionalFormatting({ ref, rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb }, gradient: false } as never] });
}
function heat(ws: WS, ref: string) {
  ws.addConditionalFormatting({ ref, rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: 'FFBFD3FA' }, { argb: 'FF3B6FE0' }] } as never] });
}
/** A KPI tile: label over a big value, 3 columns wide, 3 rows tall. */
function tile(ws: WS, row: number, col: number, label: string, value: string | number, colour: string, soft: string, fmt?: string, note?: string) {
  ws.mergeCells(row, col, row, col + 2); ws.mergeCells(row + 1, col, row + 1, col + 2); ws.mergeCells(row + 2, col, row + 2, col + 2);
  const a = ws.getCell(row, col), b = ws.getCell(row + 1, col), c = ws.getCell(row + 2, col);
  a.value = label.toUpperCase(); a.font = { bold: true, size: 9, color: { argb: colour } };
  b.value = value; b.font = { bold: true, size: 18, color: { argb: colour } }; if (fmt) b.numFmt = fmt;
  c.value = note ?? ''; c.font = { size: 9, color: { argb: C.grey } };
  for (const x of [a, b, c]) { x.fill = fill(soft); x.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }; }
  a.border = { top: { style: 'thick', color: { argb: colour } } };
}
function status(ws: WS, row: number, label: string, ok: boolean, text: string, warn = false) {
  ws.mergeCells(row, 1, row, 3); ws.mergeCells(row, 4, row, 12);
  const a = ws.getCell(row, 1), b = ws.getCell(row, 4);
  const [fg, bg, mark] = ok ? [C.green, C.greenSoft, '✔'] : warn ? [C.amber, C.amberSoft, '!'] : [C.red, C.redSoft, '✖'];
  a.value = `${mark}  ${label}`; a.font = { bold: true, color: { argb: fg }, size: 10 }; a.fill = fill(bg);
  b.value = text; b.font = { size: 10, color: { argb: fg } }; b.fill = fill(bg); b.alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(row).height = Math.max(18, 15 * Math.ceil(text.length / 120) + 4);
}

// ---------------------------------------------------------------- data from the workbook the user uploaded
/** Amount, rate and date paid per workbook row (the match result has tax and date deducted). */
function rowExtras(workbook?: Uint8Array): Map<number, { amount: number; rate: number; paid: string; sectionText: string }> {
  const out = new Map<number, { amount: number; rate: number; paid: string; sectionText: string }>();
  if (!workbook) return out;
  const wb = XLSX.read(workbook, { type: 'array' });
  const g = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Deductees'], { header: 1, raw: true, defval: null });
  const h = ((g[0] ?? []) as unknown[]).map(v => String(v ?? '').trim());
  const ix = (n: string) => h.indexOf(n);
  const toDate = (v: unknown) => (typeof v === 'number' ? new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) : String(v ?? ''));
  g.slice(1).forEach((r, k) => out.set(k + 2, { amount: Number(r[ix('Amount')]) || 0, rate: Number(r[ix('Rate %')]) || 0, paid: toDate(r[ix('Date paid / credited')]), sectionText: String(r[ix('Section (as in working)')] ?? '') }));
  return out;
}

// ---------------------------------------------------------------- sheets
function sheetEntries(wb: WB, meta: ReportMeta, so: SetOff, extras: ReturnType<typeof rowExtras>, late: Map<number, number>) {
  const ws = wb.addWorksheet('Entries → challans', { properties: { tabColor: { argb: C.blue } } });
  title(ws, 'Every entry: its section and the challan that pays it', `${meta.deductor ?? ''} ${meta.tan ? `(${meta.tan})` : ''} · ${FORM_NAME[meta.form] ?? `Form ${meta.form}`} · FY ${meta.fy}-${String(meta.fy + 1).slice(2)} · Q${meta.quarter}`, 19);
  const ch = new Map(so.challans.map(c => [c.no, c]));
  const res = new Map(so.result.rows.map(r => [r.row, r]));
  const rows = so.rows.map(r => {
    const m = res.get(r.row), c = m?.challanNo ? ch.get(m.challanNo) : undefined, x = extras.get(r.row);
    const how = !m ? '' : m.status === 'exception' ? 'NOT LINKED' : /approval|allowed/i.test(m.reason) ? 'Linked - other return\'s share, approved' : m.status === 'given' ? 'Linked by you' : 'Matched by the rules';
    return {
      row: r.row, name: r.name, pan: r.pan, type: /^[A-Z]{3}C/.test(r.pan) ? 'Company' : 'Non-company',
      ref: sectionRef(r.code), sname: sectionName(r.code).replace(sectionRef(r.code), '').trim(), code: r.code,
      paid: dmy(x?.paid), ded: dmy(r.dateDeducted), amount: x?.amount ?? null, rate: x?.rate ?? null, tax: r.tax,
      serial: c?.serial ?? '', date: dmy(c?.date), bsr: c?.bsr ?? '', head: c?.majorHead ?? '', how, reason: m?.reason ?? '',
      late: late.get(r.row) ?? null,
    };
  });
  const cols: Col[] = [
    { header: 'Row', key: 'row', width: 6 }, { header: 'Payee', key: 'name', width: 28 }, { header: 'PAN', key: 'pan', width: 12 }, { header: 'Payee type', key: 'type', width: 12 },
    { header: 'Section', key: 'ref', width: 16 }, { header: 'Nature', key: 'sname', width: 26, wrap: true }, { header: 'Code', key: 'code', width: 7 },
    { header: 'Paid / credited', key: 'paid', width: 12 }, { header: 'Deducted', key: 'ded', width: 11 }, { header: 'Amount', key: 'amount', width: 14, fmt: INR2 },
    { header: 'Rate %', key: 'rate', width: 7, fmt: '0.00' }, { header: 'Tax', key: 'tax', width: 11, fmt: INR2 },
    { header: 'Challan', key: 'serial', width: 9 }, { header: 'Challan date', key: 'date', width: 12 }, { header: 'BSR', key: 'bsr', width: 9 }, { header: 'Major head', key: 'head', width: 8 },
    { header: 'How linked', key: 'how', width: 22, wrap: true }, { header: 'Late-deduction interest (about)', key: 'late', width: 12, fmt: INR }, { header: 'Why this challan', key: 'reason', width: 60, wrap: true },
  ];
  const last = table(ws, 4, cols, rows, { filter: true, total: ['amount', 'tax', 'late'],
    rowFill: r => (r.how === 'NOT LINKED' ? C.redSoft : String(r.how).includes('approved') ? C.purpleSoft : r.late ? C.amberSoft : undefined) });
  ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 3 }];
  ws.getCell(last + 2, 1).value = 'Colours: purple = paid from another return\'s share with your approval · amber = late deduction · red = no challan yet.';
  ws.getCell(last + 2, 1).font = { italic: true, size: 9, color: { argb: C.grey } };
}

function sheetSetoff(wb: WB, meta: ReportMeta, so: SetOff) {
  const ws = wb.addWorksheet('Challan set-off', { properties: { tabColor: { argb: C.teal } } });
  title(ws, 'How each challan is set off', `Split by section from the challan receipts (or as entered) · this return's money first; another return's share only with approval`, 12);
  const u = new Map(so.result.challans.map(x => [x.no, x]));
  const rows = so.challans.map(c => {
    const x = u.get(c.no)!;
    return { serial: c.serial, date: dmy(c.date), bsr: c.bsr, head: c.majorHead, tax: c.tax, pool: x.pool, other: x.otherShare,
      osec: x.otherSections.map(secFull).join('; '), approved: x.approved || null, used: x.usedHere, fromOther: x.takenFromOther || null,
      leftHere: Math.max(0, x.left), leftOther: Math.round((x.otherShare - x.takenFromOther) * 100) / 100, interest: c.interest, idue: x.interestDue };
  });
  const cols: Col[] = [
    { header: 'Challan', key: 'serial', width: 9 }, { header: 'Date', key: 'date', width: 11 }, { header: 'BSR', key: 'bsr', width: 9 }, { header: 'Head', key: 'head', width: 6 },
    { header: 'Tax', key: 'tax', width: 13, fmt: INR }, { header: "This return's money", key: 'pool', width: 13, fmt: INR }, { header: "Other returns' share", key: 'other', width: 13, fmt: INR },
    { header: 'Other sections', key: 'osec', width: 34, wrap: true }, { header: 'Allowed by you', key: 'approved', width: 11, fmt: INR },
    { header: 'Used by this return', key: 'used', width: 13, fmt: INR }, { header: '…of which from other share', key: 'fromOther', width: 12, fmt: INR },
    { header: 'Left for this return', key: 'leftHere', width: 11, fmt: INR }, { header: 'Left for other returns', key: 'leftOther', width: 13, fmt: INR },
    { header: 'Interest paid', key: 'interest', width: 10, fmt: INR }, { header: 'Interest due (about)', key: 'idue', width: 10, fmt: INR },
  ];
  const last = table(ws, 4, cols, rows, { total: ['tax', 'pool', 'other', 'approved', 'used', 'fromOther', 'leftHere', 'leftOther', 'interest', 'idue'],
    rowFill: r => (Number(r.fromOther) > 0 ? C.purpleSoft : undefined) });
  if (rows.length) { dataBar(ws, `J5:J${4 + rows.length}`, 'FF3B6FE0'); dataBar(ws, `M5:M${4 + rows.length}`, 'FF8A94A6'); }
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  void last;
  // challan x section: the split against the rows linked
  const ws2 = wb.addWorksheet('Challan by section', { properties: { tabColor: { argb: C.teal } } });
  title(ws2, 'Each challan by section: the split on the challan against the rows linked to it', 'Rows may use any of this return\'s sections on a challan (one pool), so differences between sections are allowed - they are shown for checking.', 8);
  const bySec: Record<string, unknown>[] = [];
  for (const c of so.challans) {
    const mine = so.result.rows.filter(m => m.challanNo === c.no && m.status !== 'exception').map(m => so.rows.find(x => x.row === m.row)!).filter(Boolean);
    const codes = [...new Set([...Object.keys(c.breakup ?? {}), ...mine.map(x => x.code)])].sort();
    for (const k of codes) {
      const split = c.breakup?.[k] ?? 0, linked = mine.filter(x => x.code === k).reduce((a, x) => a + x.tax, 0);
      bySec.push({ serial: c.serial, date: dmy(c.date), sec: secFull(k), split, rows: mine.filter(x => x.code === k).length, linked, diff: Math.round((linked - split) * 100) / 100,
        note: k === 'THIS' || k === 'OTHER' ? '' : Math.abs(linked - split) < 1 ? 'matches' : split === 0 ? 'rows on a section not on the challan' : linked === 0 ? 'kept for that return / not used' : linked > split ? 'more than the split' : 'less than the split' });
    }
  }
  table(ws2, 4, [
    { header: 'Challan', key: 'serial', width: 9 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Section', key: 'sec', width: 46, wrap: true }, { header: 'On the challan', key: 'split', width: 13, fmt: INR },
    { header: 'Rows', key: 'rows', width: 6 }, { header: 'Rows linked (tax)', key: 'linked', width: 13, fmt: INR }, { header: 'Difference', key: 'diff', width: 11, fmt: INR }, { header: 'Note', key: 'note', width: 26, wrap: true },
  ], bySec, { filter: true, rowFill: x => (x.note === 'matches' ? C.greenSoft : String(x.note).startsWith('kept') ? C.band : x.note === 'rows on a section not on the challan' ? C.amberSoft : undefined), headFill: C.teal });
  ws2.views = [{ state: 'frozen', ySplit: 4 }];
}

function sheetMatrix(wb: WB, so: SetOff) {
  const ws = wb.addWorksheet('Section × challan', { properties: { tabColor: { argb: C.purple } } });
  const used = so.result.rows.filter(m => m.challanNo && m.status !== 'exception');
  const byRow = new Map(so.rows.map(r => [r.row, r]));
  const codes = [...new Set(used.map(m => byRow.get(m.row)?.code ?? ''))].filter(Boolean).sort();
  const chs = so.challans.filter(c => used.some(m => m.challanNo === c.no));
  title(ws, 'Tax of this return by section and challan', 'Darker = more tax. Totals by section (right) and by challan (bottom).', chs.length + 3);
  const head = ws.getRow(4);
  ['Section', ...chs.map(c => `${c.serial}\n${dmy(c.date)}`), 'Total'].forEach((h, i) => {
    const cell = head.getCell(i + 1); cell.value = h; cell.font = { bold: true, color: { argb: C.white }, size: 10 }; cell.fill = fill(C.purple);
    cell.alignment = { wrapText: true, horizontal: i ? 'right' : 'left', vertical: 'middle' }; cell.border = box;
  });
  head.height = 32; ws.getColumn(1).width = 46;
  codes.forEach((k, ri) => {
    const row = ws.getRow(5 + ri);
    row.getCell(1).value = secFull(k); row.getCell(1).border = box; row.getCell(1).font = { size: 10 };
    chs.forEach((c, ci) => {
      const v = used.filter(m => m.challanNo === c.no && byRow.get(m.row)?.code === k).reduce((a, m) => a + (byRow.get(m.row)?.tax ?? 0), 0);
      const cell = row.getCell(2 + ci); cell.value = v || null; cell.numFmt = INR; cell.border = box; ws.getColumn(2 + ci).width = 13;
    });
    const t = row.getCell(chs.length + 2); t.value = { formula: `SUM(B${5 + ri}:${colLetter(chs.length + 1)}${5 + ri})` }; t.numFmt = INR; t.font = { bold: true }; t.border = box; t.fill = fill(C.purpleSoft);
  });
  const tr = ws.getRow(5 + codes.length);
  tr.getCell(1).value = 'Total'; tr.getCell(1).font = { bold: true };
  for (let ci = 0; ci <= chs.length; ci++) {
    const L = colLetter(2 + ci); const cell = tr.getCell(2 + ci);
    cell.value = { formula: `SUM(${L}5:${L}${4 + codes.length})` }; cell.numFmt = INR; cell.font = { bold: true }; cell.fill = fill(C.purpleSoft); cell.border = box;
  }
  if (codes.length && chs.length) heat(ws, `B5:${colLetter(chs.length + 1)}${4 + codes.length}`);
  ws.getColumn(chs.length + 2).width = 14;
  ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 1 }];
}

function sheetChecks(wb: WB, meta: ReportMeta, c: { problems: string[]; points: string[]; late: string[]; csi: { level: string; message: string }[]; checks?: DataCheckResult | null }) {
  const ws = wb.addWorksheet('Checks', { properties: { tabColor: { argb: C.amber } } });
  title(ws, 'Checks and points to review', `${FORM_NAME[meta.form] ?? `Form ${meta.form}`} · Q${meta.quarter} · red = must be fixed · amber = check · grey = for information`, 8);
  let r = 4;
  const list = (head: string, items: string[], soft: string, colour: string) => {
    heading(ws, r, `${head} (${items.length})`, 8, colour); r++;
    if (!items.length) { ws.getCell(r, 1).value = 'None'; ws.getCell(r, 1).font = { color: { argb: C.green } }; r += 2; return; }
    for (const it of items) { ws.mergeCells(r, 1, r, 8); const cell = ws.getCell(r, 1); cell.value = it; cell.fill = fill(soft); cell.alignment = { wrapText: true, vertical: 'top' }; cell.font = { size: 10 }; ws.getRow(r).height = it.length > 120 ? 30 : 16; r++; }
    r++;
  };
  list('Problems - must be fixed', c.problems, C.redSoft, C.red);
  list('Points to review', [...c.points, ...c.late], C.amberSoft, C.amber);
  list('CSI', c.csi.map(x => x.message), C.band, C.grey);
  if (c.checks) {
    const issues = issueRecords(c.checks), late = lateRecords(c.checks);
    heading(ws, r, `Data checks on the workbook (${issues.length})`, 8, C.red); r++;
    r = table(ws, r, [{ header: 'Level', key: 'Level', width: 9 }, { header: 'Row', key: 'Row', width: 6 }, { header: 'Payee', key: 'Name', width: 26 }, { header: 'PAN', key: 'PAN', width: 12 },
      { header: 'Field', key: 'Field', width: 16 }, { header: 'Value', key: 'Value', width: 12 }, { header: 'Problem', key: 'Problem', width: 40, wrap: true }, { header: 'What to do', key: 'What to do', width: 50, wrap: true }],
      issues, { rowFill: x => (x.Level === 'Must fix' ? C.redSoft : C.amberSoft) }) + 2;
    heading(ws, r, `Late deductions (${late.length}) - interest for late deduction, about 1% a month or part`, 8, C.amber); r++;
    table(ws, r, [{ header: 'Row', key: 'Row', width: 6 }, { header: 'Payee', key: 'Name', width: 26 }, { header: 'PAN', key: 'PAN', width: 12 }, { header: 'Section', key: 'Section', width: 16 },
      { header: 'Paid / credited', key: 'Date paid / credited', width: 12 }, { header: 'Deducted', key: 'Date deducted', width: 12 }, { header: 'Tax', key: 'Tax', width: 11, fmt: INR },
      { header: 'Months', key: 'Months', width: 8 }, { header: 'Interest (about)', key: 'Interest (about, 1% a month)', width: 12, fmt: INR }].map(x => (x.key === 'Section' ? { ...x, width: 40, wrap: true } : x)),
      late.map(l => ({ ...l, Section: secFull(String(l.Section)) })), { total: ['Tax', 'Interest (about, 1% a month)'], headFill: C.amber });
  }
}

function sheetDeductor(wb: WB, rv: ReviewModel) {
  const ws = wb.addWorksheet('Deductor', { properties: { tabColor: { argb: C.grey } } });
  title(ws, 'Deductor details in the return', `${rv.deductor} (${rv.tan})`, 3);
  table(ws, 4, [{ header: 'Field', key: 'field', width: 8 }, { header: 'Item', key: 'label', width: 40 }, { header: 'Value', key: 'value', width: 60, wrap: true }],
    rv.deductorDetails as unknown as Record<string, unknown>[]);
}

function sheetDashboard(wb: WB, meta: ReportMeta, d: { rv?: ReviewModel; so?: SetOff | null; problems: string[]; points: string[]; lateInterest: number; lateCount: number; extras: ReturnType<typeof rowExtras> }) {
  const ws = wb.addWorksheet('Dashboard', { properties: { tabColor: { argb: C.navy } }, views: [{ showGridLines: false }] });
  for (let i = 1; i <= 12; i++) ws.getColumn(i).width = 12;
  title(ws, `TDS return report - ${meta.deductor ?? ''}${meta.tan ? ` (${meta.tan})` : ''}`,
    `${FORM_NAME[meta.form] ?? `Form ${meta.form}`} · FY ${meta.fy}-${String(meta.fy + 1).slice(2)} · Q${meta.quarter}${meta.file ? ` · ${meta.file}` : ''} · prepared ${new Date().toLocaleDateString('en-IN')} - draft for review, not tax advice`, 12);
  const so = d.so, rows = so?.rows ?? [];
  const tax = rows.reduce((a, r) => a + r.tax, 0);
  const amount = rows.reduce((a, r) => a + (d.extras.get(r.row)?.amount ?? 0), 0);
  const pans = new Set(rows.map(r => r.pan)).size;
  const chTotal = so?.challans.reduce((a, c) => a + c.tax, 0) ?? 0;
  const used = so?.result.challans.reduce((a, c) => a + c.usedHere, 0) ?? 0;
  const leftOther = so?.result.challans.reduce((a, c) => a + (c.otherShare - c.takenFromOther), 0) ?? 0;
  const fromOther = so?.result.challans.reduce((a, c) => a + c.takenFromOther, 0) ?? 0;
  const open = so?.result.rows.filter(m => m.challanNo === null).length ?? 0;
  tile(ws, 4, 1, 'Deductee rows', d.rv?.totals.deducteeRows ?? rows.length, C.blue, C.blueSoft, undefined, `${pans} PANs`);
  tile(ws, 4, 4, 'Amount paid / credited', d.rv?.totals.amountPaid ?? amount, C.navy, C.band, INR);
  tile(ws, 4, 7, 'Tax deducted', d.rv?.totals.taxDeducted ?? tax, C.teal, C.tealSoft, INR, `deposited Rs ${Math.round(d.rv?.totals.taxDeposited ?? used).toLocaleString('en-IN')}`);
  tile(ws, 4, 10, 'Challans', so?.challans.length ?? d.rv?.totals.challans ?? 0, C.purple, C.purpleSoft, undefined, `total Rs ${Math.round(chTotal).toLocaleString('en-IN')}`);
  tile(ws, 8, 1, 'Used by this return', used, C.blue, C.blueSoft, INR, fromOther ? `incl. Rs ${Math.round(fromOther).toLocaleString('en-IN')} approved from other share` : 'only this return\'s money');
  tile(ws, 8, 4, 'Left for other returns', leftOther, C.grey, C.band, INR, 'e.g. salary (24Q) - see Challan set-off');
  tile(ws, 8, 7, 'Late deductions', d.lateCount, d.lateCount ? C.amber : C.green, d.lateCount ? C.amberSoft : C.greenSoft, undefined, d.lateCount ? `interest about Rs ${Math.round(d.lateInterest).toLocaleString('en-IN')}` : 'none');
  tile(ws, 8, 10, 'Rows without challan', open, open ? C.red : C.green, open ? C.redSoft : C.greenSoft, undefined, open ? 'link them at step 4' : 'all linked');
  let r = 12;
  heading(ws, r, 'Status', 12, C.navy); r++;
  status(ws, r++, 'Problems', d.problems.length === 0, d.problems.length ? `${d.problems.length} to fix - see the Checks sheet` : 'None - the return can be built');
  status(ws, r++, 'Points to review', d.points.length === 0, d.points.length ? `${d.points.length} - ${d.points[0].length > 150 ? d.points[0].slice(0, 150) + '…' : d.points[0]}${d.points.length > 1 ? ` (and ${d.points.length - 1} more - see the Checks sheet)` : ''}` : 'None', true);
  status(ws, r++, 'Challan links', open === 0, open ? `${open} row(s) still need a challan` : 'Every row has a challan, within each challan\'s money for this return');
  r++;
  // by section
  heading(ws, r, 'By section', 12); r++;
  const secs = [...new Set(rows.map(x => x.code))].sort().map(k => {
    const rs = rows.filter(x => x.code === k);
    const t = rs.reduce((a, x) => a + x.tax, 0);
    return { sec: secFull(k), rows: rs.length, pans: new Set(rs.map(x => x.pan)).size, amount: rs.reduce((a, x) => a + (d.extras.get(x.row)?.amount ?? 0), 0), tax: t, share: tax ? t / tax : 0 };
  }).sort((a, b) => b.tax - a.tax);
  const secTop = r;
  ws.mergeCells(r, 1, r, 5);
  const last = table(ws, r, [{ header: 'Section', key: 'sec', width: 12 }, { header: '', key: '_1' }, { header: '', key: '_2' }, { header: '', key: '_3' }, { header: '', key: '_4' },
    { header: 'Rows', key: 'rows' }, { header: 'PANs (total: distinct)', key: 'pans' }, { header: 'Amount', key: 'amount', fmt: INR }, { header: 'Tax', key: 'tax', fmt: INR }, { header: 'Share', key: 'share', fmt: '0%' }], secs, { total: ['rows', 'amount', 'tax'] });
  if (secs.length) { const pc = ws.getCell(last, 7); pc.value = pans; }
  for (let i = 0; i < secs.length; i++) ws.mergeCells(secTop + 1 + i, 1, secTop + 1 + i, 5);
  ws.mergeCells(last, 1, last, 5);
  if (secs.length) dataBar(ws, `J${secTop + 1}:J${secTop + secs.length}`, 'FF0F766E');
  r = last + 2;
  // by month
  heading(ws, r, 'By month of deduction', 12); r++;
  const months = [...new Set(rows.map(x => x.dateDeducted.slice(0, 7)))].sort().map(m => {
    const rs = rows.filter(x => x.dateDeducted.startsWith(m));
    return { m: new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }), rows: rs.length, amount: rs.reduce((a, x) => a + (d.extras.get(x.row)?.amount ?? 0), 0), tax: rs.reduce((a, x) => a + x.tax, 0) };
  });
  const mTop = r;
  const mLast = table(ws, r, [{ header: 'Month', key: 'm', width: 12 }, { header: 'Rows', key: 'rows' }, { header: 'Amount', key: 'amount', fmt: INR }, { header: 'Tax', key: 'tax', fmt: INR }], months, { total: ['rows', 'amount', 'tax'] });
  if (months.length) dataBar(ws, `D${mTop + 1}:D${mTop + months.length}`, 'FF3B6FE0');
  r = mLast + 2;
  if (so) {
    heading(ws, r, 'Challans: this return / other returns', 12); r++;
    const cTop = r;
    const cr = so.challans.map(c => { const x = so.result.challans.find(u => u.no === c.no)!; return { c: `${c.serial} · ${dmy(c.date)}`, tax: c.tax, used: x.usedHere, other: Math.round((x.otherShare - x.takenFromOther) * 100) / 100, left: Math.max(0, x.left) }; });
    ws.mergeCells(r, 1, r, 2);
    const cLast = table(ws, r, [{ header: 'Challan', key: 'c' }, { header: '', key: '_' }, { header: 'Tax', key: 'tax', fmt: INR }, { header: 'This return', key: 'used', fmt: INR }, { header: 'Other returns', key: 'other', fmt: INR }, { header: 'Unused', key: 'left', fmt: INR }],
      cr, { total: ['tax', 'used', 'other', 'left'] });
    for (let i = 0; i < cr.length; i++) ws.mergeCells(cTop + 1 + i, 1, cTop + 1 + i, 2);
    ws.mergeCells(cLast, 1, cLast, 2);
    if (cr.length) { dataBar(ws, `D${cTop + 1}:D${cTop + cr.length}`, 'FF3B6FE0'); dataBar(ws, `E${cTop + 1}:E${cTop + cr.length}`, 'FF8A94A6'); }
  }
}

// ---------------------------------------------------------------- entry points
async function book(): Promise<WB> { const E = await excel(); const wb = new E.Workbook(); wb.creator = 'TDS / TCS Return Builder'; wb.created = new Date(); return wb; }
const bytes = async (wb: WB) => new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);

/** Full report after the return is built (Review / Download steps). */
export async function fullReport(a: { meta: ReportMeta; rv: ReviewModel; setoff: SetOff | null; workbook?: Uint8Array; checks?: DataCheckResult | null;
  problems: string[]; points: string[]; late: string[]; csi: { level: string; message: string }[] }): Promise<Uint8Array> {
  const wb = await book();
  const extras = rowExtras(a.workbook);
  const lateMap = new Map((a.checks?.late ?? []).map(l => [l.row, l.interest]));
  sheetDashboard(wb, a.meta, { rv: a.rv, so: a.setoff, problems: a.problems, points: [...a.points, ...a.late], lateInterest: (a.checks?.late ?? []).reduce((x, l) => x + l.interest, 0), lateCount: a.checks?.late.length ?? 0, extras });
  if (a.setoff) { sheetEntries(wb, a.meta, a.setoff, extras, lateMap); sheetSetoff(wb, a.meta, a.setoff); sheetMatrix(wb, a.setoff); }
  sheetChecks(wb, a.meta, { problems: a.problems, points: a.points, late: a.late, csi: a.csi, checks: a.checks });
  sheetDeductor(wb, a.rv);
  return bytes(wb);
}

/** The challan step's report (before the return is built). */
export async function setoffReport(a: { meta: ReportMeta; setoff: SetOff; workbook?: Uint8Array; checks?: DataCheckResult | null }): Promise<Uint8Array> {
  const wb = await book();
  const extras = rowExtras(a.workbook);
  const lateMap = new Map((a.checks?.late ?? []).map(l => [l.row, l.interest]));
  const pts = a.setoff.result.exceptions.map(e => e.message);
  sheetDashboard(wb, a.meta, { so: a.setoff, problems: [], points: pts, lateInterest: (a.checks?.late ?? []).reduce((x, l) => x + l.interest, 0), lateCount: a.checks?.late.length ?? 0, extras });
  sheetSetoff(wb, a.meta, a.setoff); sheetEntries(wb, a.meta, a.setoff, extras, lateMap); sheetMatrix(wb, a.setoff);
  return bytes(wb);
}

/** Data checks at upload. */
export async function checksReport(checks: DataCheckResult, meta: ReportMeta): Promise<Uint8Array> {
  const wb = await book();
  sheetChecks(wb, meta, { problems: [], points: [], late: [], csi: [], checks });
  return bytes(wb);
}
