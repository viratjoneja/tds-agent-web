/**
 * Phase 1 — read back what Protean's FVU reported, and point at the row to fix.
 *
 * Inputs (whichever the user uploads from the FVU output folder):
 *   <name>.err                                   caret text, one line per error (file NOT valid)
 *   <name>_Electronic_Statement_Warning_File.html warnings (file valid, but read them)
 *   <name>.html                                   statistics report (file valid)
 * plus the return lines, so each error/warning is tied to its challan / deductee / employee.
 *
 * New module — does not change the frozen core.
 */
export interface FvuIssue {
  kind: 'error' | 'warning';
  line: number;                    // line in the return file (0 = whole file)
  record: string;                  // FH / BH / CD / DD / SD / S16 / C6A as found in our file
  field: string;                   // FVU's field name or record label
  code: string;                    // e.g. T-FV-4092
  description: string;             // FVU's own text
  where: string;                   // our plain description of the row
  hint: string;                    // what usually fixes it ('' if unknown code)
}

/** Fixes learned from live FVU 1.2 runs (tds-agent Q2 / Q4 testing, Nov 2026). */
export const KNOWN_FIXES: Record<string, string> = {
  'T-FV-4092': 'Rate of deduction must have 4 decimal places. The tool writes this correctly - if you see it, the file was edited by hand.',
  'T-FV-6417': 'Form 143: give a collectee code (01-10) on every row, for residents too.',
  'T-FV-4319': 'No valid PAN: set "tax deducted at higher rate" to Y for this employee.',
  'T-FV-4015': "Employment 'to' date: cannot be in the future and must fall in the financial year. Q4 returns validate only after 31 March.",
  'T-FV-4014': "Employment 'from' date: cannot be in the future and must fall in the financial year.",
  'T-FV-3040': 'Challan date cannot be in the future - check the date, or validate after it.',
  'T-FV-3141': 'This challan is not in the CSI file. Download a fresh CSI (banks take days to report), then check the BSR code, date, serial number and amount against the challan counterfoil.',
  'T-FV-4026': 'Income under salaries is wrong: standard deduction cannot exceed the salary; income cannot be negative.',
  'T-FV-4028': 'Gross total income is wrong or negative - check salary, house property and other income.',
  'T-FV-4031': 'Taxable income is wrong: Chapter VI-A deductions cannot exceed gross total income.',
  'T-FV-4032': 'Income tax cannot be negative.',
  'T-FV-6354': 'New regime: leave HRA exemption and travel concession blank.',
  'T-FV-2092': 'Batch total of gross total income does not add up - usually caused by an invalid salary record; fix those first.',
};
const normCode = (c: string) => c.replace(/_/g, '-').toUpperCase();
const hintFor = (code: string) => KNOWN_FIXES[normCode(code)] ?? '';

function describe(lines: string[], lineNo: number): { record: string; where: string } {
  const f = (lines[lineNo - 1] ?? '').split('^');
  const rt = f[1] ?? '';
  const dmy = (d: string) => (d && d.length === 8 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : d);
  if (rt === 'CD') return { record: rt, where: `Challan ${f[3]} (BSR ${f[14]}, ${dmy(f[18])}, serial ${f[16]}, amount ${f[11]})` };
  if (rt === 'DD') return { record: rt, where: `Challan ${f[4]}, row ${f[3]}: ${f[8]} (${f[7]}), section ${f[14]}, tax ${f[23]}` };
  if (rt === 'SD') return { record: rt, where: `Employee ${f[3]}: ${f[8]} (${f[6]})` };
  if (rt === 'S16' || rt === 'C6A') return { record: rt, where: `Employee ${f[3]}, ${rt === 'S16' ? 'section 16' : 'Chapter VI-A'} line ${f[4]} (${f[5]})` };
  if (rt === 'BH') return { record: rt, where: 'Deductor / batch header' };
  if (rt === 'FH') return { record: rt, where: 'File header' };
  return { record: rt || '?', where: lineNo ? `Line ${lineNo}` : 'Whole file' };
}

/** <name>.err: "line^Regular^field^challan no^record no^code^description" per error. */
export function readErrFile(text: string, returnLines: string[]): FvuIssue[] {
  return text.split(/\r?\n/).filter(l => l.trim()).map(l => {
    const p = l.split('^');
    const codeIdx = p.findIndex(x => /^T[-_]FV[-_]\d+/i.test(x.trim()));
    const line = Number(p[0]) || 0;
    const code = codeIdx >= 0 ? p[codeIdx].trim() : '';
    const d = describe(returnLines, line);
    return { kind: 'error' as const, line, record: d.record, field: (p[2] ?? '').trim(), code,
      description: codeIdx >= 0 ? p.slice(codeIdx + 1).join('^').trim() : l.trim(), where: d.where, hint: hintFor(code) };
  });
}

const cellText = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cellText(c[1])));
}

/** <name>_Electronic_Statement_Warning_File.html: a table, one row per warning. */
export function readWarningFile(html: string, returnLines: string[]): FvuIssue[] {
  const rows = tableRows(html);
  const hi = rows.findIndex(r => r.some(c => /^Line no/i.test(c)));
  if (hi < 0) return [];
  const hdr = rows[hi].map(c => c.toLowerCase());
  const col = (re: RegExp) => hdr.findIndex(c => re.test(c));
  const [cLine, cType, cCode, cDesc] = [col(/^line no/), col(/^record type/), col(/^error code/), col(/^error desc/)];
  return rows.slice(hi + 1).filter(r => r.length >= hdr.length - 1 && r[cLine]).map(r => {
    const line = Number(r[cLine]) || 0, code = r[cCode] ?? '';
    const d = describe(returnLines, line);
    return { kind: 'warning' as const, line, record: d.record, field: r[cType] ?? '', code, description: r[cDesc] ?? '',
      where: d.where, hint: hintFor(code) };
  });
}

export interface FvuStatistics { [label: string]: string }
/** <name>.html statistics report: rows of labels, each followed by a row of values. */
export function readStatistics(html: string): FvuStatistics {
  const rows = tableRows(html).filter(r => r.some(c => c));
  const out: FvuStatistics = {};
  for (let i = 0; i + 1 < rows.length; i++) {
    const labels = rows[i], values = rows[i + 1];
    const looksLikeValues = values.every(v => /^[\d.,-]*$|^[A-Z0-9]{10}$|^(NA|Regular|Q\d|\d{4}-\d{2})$/.test(v) || v === '');
    if (labels.length > 1 && labels.length === values.length && looksLikeValues) {
      labels.forEach((l, k) => { out[l.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim()] = values[k]; });
      i++;
    }
  }
  return out;
}

/** Compare the FVU statistics with the return's own totals (from review.ts reviewModel totals). */
export function compareStatistics(stats: FvuStatistics, totals: { challans: number; deducteeRows: number; taxDeducted: number; challanTotal: number }): string[] {
  const out: string[] = [];
  const num = (k: string) => (stats[k] !== undefined ? Number(stats[k].replace(/,/g, '')) : NaN);
  const pairs: [string, number, string][] = [
    ['No. of Challans', totals.challans, 'challans'],
    ['Total Challan Amount', totals.challanTotal, 'total challan amount'],
    ['No. of Deductee Records', totals.deducteeRows, 'deductee rows'],
    ['No. of Party Records', totals.deducteeRows, 'collectee rows'],
  ];
  for (const [k, ours, label] of pairs) {
    const v = num(k);
    if (!Number.isNaN(v) && Math.abs(v - ours) > 0.005) out.push(`FVU shows ${label} ${v}, the return has ${ours}`);
  }
  return out;
}
