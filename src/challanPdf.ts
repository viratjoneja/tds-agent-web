/**
 * Phase 4a — read challan receipts (PDF) into the Challans sheet.
 *
 * The e-filing portal's "Challan Receipt" (ITNS 281) is a text PDF with fixed labels, including a
 * section-wise table with the 4-digit codes. So it is read by RULES, in the browser - nothing is
 * sent anywhere. Every read is cross-checked (section amounts = tax; tax breakup = receipt total);
 * a receipt that fails is not used.
 *
 * Gemini is only a fallback for a receipt in another layout: maskReceiptText() removes the TAN, PAN,
 * name, CIN and bank reference first, and geminiChallanRequest() builds the request. Scanned
 * (image-only) PDFs cannot be masked, so they are refused - type those challans in.
 *
 * New module — does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import { BREAKUP_COLUMN, MAJOR_HEAD_COLUMN } from './challanMatch.ts';
import type { Ymd } from './protean.ts';

export interface ChallanReceipt {
  bsr: string; serial: string; tenderDate: Ymd; depositDate: Ymd | null; cin: string;
  majorHead: string; minorHead: string;
  tax: number; surcharge: number; cess: number; interest: number; penalty: number; fee: number; others: number; total: number;
  breakup: Record<string, number>;   // section code -> tax + surcharge + cess for that section
  source: 'rules' | 'gemini';
}
export interface ReadResult { ok: boolean; receipt: ChallanReceipt | null; problems: string[] }

// ---------------------------------------------------------------- text from the PDF (pdf.js)
/** Minimal shape of pdf.js used here, so browser and Node builds both fit. */
interface PdfJs { getDocument(src: { data: Uint8Array; useSystemFonts?: boolean; disableFontFace?: boolean }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }> } }

/** Text of a PDF, rebuilt line by line (items grouped by their vertical position). */
export async function pdfText(data: Uint8Array, pdfjs: PdfJs): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      const key = [...rows.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
      rows.set(key, [...(rows.get(key) ?? []), { x: it.transform[4], s: it.str }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) out.push(rows.get(y)!.sort((a, b) => a.x - b.x).map(r => r.s).join(' '));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- the rules
const money = (s: string | undefined) => (s === undefined ? NaN : Number(s.replace(/[₹,\s]/g, '')));
const ymdFromDmy = (d: string) => { const [dd, mm, yy] = d.split(/[/-]/); return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; };
const MON: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

export function parseChallanReceipt(text: string): ReadResult {
  const t = text.replace(/ /g, ' ');
  const one = (re: RegExp) => t.match(re)?.[1]?.trim();
  const problems: string[] = [];
  if (!/Challan Receipt/i.test(t) || !/BSR\s*code/i.test(t)) return { ok: false, receipt: null, problems: ['Not an e-filing portal challan receipt (layout not recognised)'] };

  const bsr = one(/BSR\s*code\s*:\s*(\d{7})/i) ?? '';
  const serial = one(/Challan\s*No\.?\s*:\s*(\d{1,5})/i) ?? '';
  const tender = one(/Tender\s*Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const dep = t.match(/Date\s*of\s*Deposit\s*:\s*(\d{2})-([A-Za-z]{3})-(\d{4})/i);
  const majorHead = one(/Major\s*Head\s*:[^\n]*?\((00\d{2})\)/i) ?? '';
  const minorHead = one(/Minor\s*Head\s*:[^\n]*?\((\d{3})\)/i) ?? '';
  const cin = one(/CIN\s*:\s*([0-9A-Z]{14,20})/i) ?? '';
  const brk = (label: string) => money(t.match(new RegExp(`\\b${label}\\s+₹\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'))?.[1]);
  const tax = brk('A\\s+Tax'), surcharge = brk('B\\s+Surcharge'), cess = brk('C\\s+Education\\s+Cess'), interest = brk('D\\s+Interest'),
    penalty = brk('E\\s+Penalty'), fee = brk('F\\s+Fee[^₹\\n]*'), others = brk('G\\s+Others');
  const total = money(t.match(/Total\s*\(A\+B\+C\+D\+E\+F\+G\)\s*₹\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
  const amount = money(t.match(/Amount\s*\(in\s*Rs\.?\)\s*:\s*₹\s*([\d,]+(?:\.\d+)?)/i)?.[1]);

  // section-wise table: "<code> ₹ tax ₹ surcharge ₹ cess ₹ total" (code is 1001-1092)
  const breakup: Record<string, number> = {};
  for (const m of t.matchAll(/\b(10\d{2})\s+₹\s*([\d,]+)\s+₹\s*([\d,]+)\s+₹\s*([\d,]+)\s+₹\s*([\d,]+)/g))
    breakup[m[1]] = (breakup[m[1]] ?? 0) + money(m[5]);

  if (!/^\d{7}$/.test(bsr)) problems.push('BSR code not found');
  if (!serial) problems.push('Challan number not found');
  if (!tender) problems.push('Tender date not found');
  if (!majorHead) problems.push('Major head code not found');
  for (const [k, v] of Object.entries({ tax, interest, fee, others, total })) if (Number.isNaN(v)) problems.push(`${k} not found in the tax breakup`);
  const bsum = Object.values(breakup).reduce((a, b) => a + b, 0);
  const abc = tax + (surcharge || 0) + (cess || 0);
  if (!Object.keys(breakup).length) problems.push('Section-wise table not found');
  else if (Math.abs(bsum - abc) > 0.5) problems.push(`Section amounts add to ${bsum}, tax + surcharge + cess is ${abc} - the table was not read completely`);
  if (!Number.isNaN(total) && Math.abs(abc + (interest || 0) + (penalty || 0) + (fee || 0) + (others || 0) - total) > 0.5) problems.push('Tax breakup does not add up to the total');
  if (!Number.isNaN(amount) && !Number.isNaN(total) && Math.abs(amount - total) > 0.5) problems.push(`Amount ${amount} differs from the breakup total ${total}`);

  if (problems.length) return { ok: false, receipt: null, problems };
  return { ok: true, problems: [], receipt: {
    bsr, serial: serial.padStart(5, '0'), tenderDate: ymdFromDmy(tender!), cin, majorHead, minorHead,
    depositDate: dep ? `${dep[3]}-${MON[dep[2].toUpperCase()]}-${dep[1]}` : null,
    tax: abc, surcharge: surcharge || 0, cess: cess || 0, interest: interest || 0, penalty: penalty || 0, fee: fee || 0, others: others || 0,
    total, breakup, source: 'rules',
  } };
}

/** Read several receipt PDFs; duplicates (same BSR + date + serial) are reported once. */
export async function readChallanPdfs(files: { name: string; data: Uint8Array }[], pdfjs: PdfJs):
  Promise<{ name: string; result: ReadResult; text: string }[]> {
  const out: { name: string; result: ReadResult; text: string }[] = [];
  for (const f of files) {
    let text = '';
    try { text = await pdfText(f.data, pdfjs); } catch (e) { out.push({ name: f.name, text: '', result: { ok: false, receipt: null, problems: [`Could not open the PDF: ${(e as Error).message}`] } }); continue; }
    if (text.replace(/\s/g, '').length < 50) { out.push({ name: f.name, text, result: { ok: false, receipt: null, problems: ['No text in this PDF (scanned image?). It cannot be masked, so it is not sent to AI - type this challan in.'] } }); continue; }
    out.push({ name: f.name, text, result: parseChallanReceipt(text) });
  }
  const seen = new Map<string, string>();
  for (const o of out) {
    const r = o.result.receipt; if (!r) continue;
    const k = `${r.bsr}|${r.tenderDate}|${r.serial}`;
    if (seen.has(k)) { o.result = { ok: false, receipt: null, problems: [`Same challan as ${seen.get(k)} - not added twice`] }; } else seen.set(k, o.name);
  }
  return out;
}

/** Put read receipts on the Challans sheet (numbered after any challans already there). */
export function addChallansToWorkbook(data: ArrayBuffer | Uint8Array, receipts: ChallanReceipt[]): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Challans'];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const hdr = (grid[0] ?? []).map(v => String(v ?? '')) as string[];
  for (const h of [MAJOR_HEAD_COLUMN, BREAKUP_COLUMN]) if (!hdr.includes(h)) hdr.push(h);
  const body = grid.slice(1).filter(r => r.some(v => v !== null && v !== ''));
  let next = Math.max(0, ...body.map(r => Number(r[hdr.indexOf('Challan #')]) || 0)) + 1;
  for (const r of [...receipts].sort((a, b) => a.tenderDate.localeCompare(b.tenderDate))) {
    const row: unknown[] = new Array(hdr.length).fill(null);
    const set = (h: string, v: unknown) => { row[hdr.indexOf(h)] = v; };
    const [y, m, d] = r.tenderDate.split('-');
    set('Challan #', next++); set('BSR code', r.bsr); set('Challan serial no.', r.serial); set('Date deposited', `${d}/${m}/${y}`);
    set('Tax', r.tax); set('Interest', r.interest); set('Fee', r.fee); set('Others', r.others + r.penalty); set('Minor head', r.minorHead || '200');
    set(MAJOR_HEAD_COLUMN, r.majorHead);
    set(BREAKUP_COLUMN, Object.entries(r.breakup).map(([c, v]) => `${c}=${v}`).join('; '));
    body.push(row);
  }
  wb.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([hdr, ...body]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

// ---------------------------------------------------------------- Gemini fallback (masked)
/** Remove what identifies the deductor or a person before any text leaves the browser. */
export function maskReceiptText(text: string): string {
  return text
    .replace(/\b[A-Z]{4}\d{5}[A-Z]\b/g, '[TAN]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]')
    .replace(/^(\s*(Name|Deductor|Collector|Taxpayer|Assessee)[^:\n]*:).*$/gim, '$1 [NAME]')
    .replace(/^(\s*CIN\s*:).*$/gim, '$1 [CIN]')
    .replace(/^(\s*Bank\s*Reference[^:\n]*:).*$/gim, '$1 [REF]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .replace(/\b\d{10}\b/g, '[NUMBER]');
}

/** Request for Gemini (responseMimeType 'application/json' + this schema). The text must already be masked. */
export function geminiChallanRequest(maskedText: string) {
  if (/\b[A-Z]{5}\d{4}[A-Z]\b|\b[A-Z]{4}\d{5}[A-Z]\b/.test(maskedText)) throw new Error('Text is not masked - refusing to build the request');
  return {
    systemInstruction: 'You read Indian income-tax challan receipts (TDS/TCS, ITNS 281). Return ONLY the JSON asked for. Never guess: use null for anything not printed in the text. Amounts in rupees as numbers. Dates as DD/MM/YYYY exactly as printed.',
    prompt: `Extract the challan details from this receipt text (identifiers have been replaced by placeholders):\n\n${maskedText}`,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        bsr: { type: 'STRING', nullable: true }, challanNo: { type: 'STRING', nullable: true }, tenderDate: { type: 'STRING', nullable: true },
        majorHead: { type: 'STRING', nullable: true, description: '4 digits, e.g. 0020 or 0021' }, minorHead: { type: 'STRING', nullable: true },
        tax: { type: 'NUMBER', nullable: true }, surcharge: { type: 'NUMBER', nullable: true }, cess: { type: 'NUMBER', nullable: true },
        interest: { type: 'NUMBER', nullable: true }, penalty: { type: 'NUMBER', nullable: true }, fee: { type: 'NUMBER', nullable: true },
        others: { type: 'NUMBER', nullable: true }, total: { type: 'NUMBER', nullable: true },
        sections: { type: 'ARRAY', items: { type: 'OBJECT', properties: { code: { type: 'STRING' }, amount: { type: 'NUMBER' } }, required: ['code', 'amount'] } },
      },
      required: ['bsr', 'challanNo', 'tenderDate', 'tax', 'total', 'sections'],
    },
  };
}

/** Check Gemini's answer with the same cross-checks as the rules; only a clean answer is usable. */
export function fromGemini(json: string): ReadResult {
  let o: Record<string, unknown>;
  try { o = JSON.parse(json); } catch { return { ok: false, receipt: null, problems: ['AI answer was not valid JSON'] }; }
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  const sections = Array.isArray(o.sections) ? (o.sections as { code: string; amount: number }[]) : [];
  const fake = [
    'Challan Receipt', `BSR code : ${o.bsr ?? ''}`, `Challan No : ${o.challanNo ?? ''}`, `Tender Date : ${o.tenderDate ?? ''}`,
    `Major Head : x (${o.majorHead ?? ''})`, `Minor Head : x (${o.minorHead ?? '200'})`,
    ...sections.map(s => `${s.code} ₹ ${s.amount} ₹ 0 ₹ 0 ₹ ${s.amount}`),
    `A Tax ₹ ${n('tax')}`, `B Surcharge ₹ ${n('surcharge')}`, `C Education Cess ₹ ${n('cess')}`, `D Interest ₹ ${n('interest')}`,
    `E Penalty ₹ ${n('penalty')}`, `F Fee ₹ ${n('fee')}`, `G Others ₹ ${n('others')}`, `Total (A+B+C+D+E+F+G) ₹ ${n('total')}`,
  ].join('\n');
  const r = parseChallanReceipt(fake);
  if (r.receipt) r.receipt.source = 'gemini';
  return r;
}
