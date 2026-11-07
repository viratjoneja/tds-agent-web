/**
 * Read the agent's standard input workbook (the one `tds template` makes) into the writer's
 * data model. TypeScript port of load_input / load_salary / deductor_from_sheet in tds_cli.py.
 *
 * Sheets: Challans, Deductees, Deductor (optional), Salary (Q4) (Form 138 Q4 only).
 * Column headings come from template_columns.json, exported from the Python tool, so the
 * two never drift apart. Runs in the browser: pass the file's ArrayBuffer.
 */
import * as XLSX from 'xlsx';
import cols from './template_columns.json' with { type: 'json' };
import {
  type Challan, type Deductee, type Deductor, type Form, type SalaryDetail, type ViaItem, type Ymd,
  COLLECTEE_CODES, EMPLOYEE_CATEGORY, VIA_ORDER, VIA_WITH_QUALIFYING,
} from './protean.ts';

export const SALARY_SHEET: string = cols.SALARY_SHEET;
const DEDUCTOR_FIELDS = cols.DEDUCTOR_FIELDS as [string, string][];
const SALARY_COLS = cols.SALARY_COLS as [string, string][];

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const blank = (v: unknown) => v === null || v === undefined || v === '';
const num0 = (v: unknown): number => (blank(v) ? 0 : toNumber(v));
function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
  return n;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y: number, m: number, d: number): Ymd => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Excel date serial or text (dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, dd-Mon-yyyy, dd.mm.yyyy) -> 'YYYY-MM-DD'. */
export function toYmd(v: unknown): Ymd {
  if (typeof v === 'number') {                              // Excel serial: days since 1899-12-30
    const ms = Math.floor(v) * 86400000 + Date.UTC(1899, 11, 30);   // drop any time of day, like Python .date()
    const d = new Date(ms);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const t = s(v);
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1], t);
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3], t);
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MON[m[2].toLowerCase()]) return valid(+m[3], MON[m[2].toLowerCase()], +m[1], t);
  throw new Error(`Cannot read date ${JSON.stringify(t)} (use dd/mm/yyyy)`);
}
function valid(y: number, mo: number, d: number, raw: string): Ymd {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`Cannot read date ${JSON.stringify(raw)}`);
  return ymd(y, mo, d);
}

/** Rows of a sheet as {heading: value}, skipping fully blank rows (like the Python _rows). */
function rows(ws: XLSX.WorkSheet): Row[] {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
  if (!grid.length) return [];
  const hdr = (grid[0] as unknown[]).map(s);
  return grid.slice(1).filter(r => r.some(v => !blank(v))).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? null])));
}

/** Blank input workbook for `form`, same sheets and headings as `tds template` (returns .xlsx bytes). */
export function makeTemplate(form: Form): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.CHALLAN_COLS]), 'Challans');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([form === '143' ? [...cols.DEDUCTEE_COLS, ...cols.TCS_COLS] : cols.DEDUCTEE_COLS]), 'Deductees');
  if (form === '138') XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([SALARY_COLS.map(([h]) => h)]), SALARY_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Field', 'Value'],
    ["Leave this sheet empty to take details from last quarter's .fvu (--prev-fvu)"], ...DEDUCTOR_FIELDS.map(([label]) => [label])]), 'Deductor');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Collectee codes (Form 143)', ''],
    ...Object.entries(COLLECTEE_CODES), [], ['Section codes: 4-digit internal codes (see the section map)']]), 'Codes');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

export interface InputResult {
  challans: Challan[];
  deductor: Deductor | null;                // null = Deductor sheet empty: take it from last quarter's .fvu
  salary: SalaryDetail[] | null;            // Form 138 Q4 only
  missing: string[];                        // things the user must fill in before building
}

export function readInputWorkbook(data: ArrayBuffer | Uint8Array, form: Form, quarter: number): InputResult {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });   // 'array' works for ArrayBuffer and Uint8Array, in browser and Node
  const missing: string[] = [];
  for (const sh of ['Challans', 'Deductees']) if (!wb.Sheets[sh]) missing.push(`Sheet "${sh}" not found - use the template`);
  if (missing.length) return { challans: [], deductor: null, salary: null, missing };

  const byNo = new Map<number, Challan>();
  for (const r of rows(wb.Sheets['Challans'])) {
    const n = parseInt(s(r['Challan #']), 10);
    byNo.set(n, {
      bsr: s(r['BSR code']).padStart(7, '0'), challan_no: s(r['Challan serial no.']).padStart(5, '0'),
      date_deposited: toYmd(r['Date deposited']), tax: num0(r['Tax']), interest: num0(r['Interest']),
      fee: num0(r['Fee']), others: num0(r['Others']), minor_head: s(r['Minor head']) || '200', deductees: [],
    });
  }
  rows(wb.Sheets['Deductees']).forEach((r, k) => {
    const i = k + 2;
    try {
      const code = s(r['Section code']);
      if (!/^\d{4}$/.test(code)) missing.push(`Deductees row ${i}: section code ${JSON.stringify(code)}`);
      const dep = r['Tax deposited (blank = Tax)'];
      const x: Deductee = {
        pan: s(r['PAN']).toUpperCase(), name: s(r['Name']), section_code: code,
        date_paid: toYmd(r['Date paid / credited']), amount: toNumber(r['Amount']), tds: toNumber(r['Tax']),
        date_deducted: toYmd(r['Date deducted']), rate: blank(r['Rate %']) ? 0 : toNumber(r['Rate %']),
        deposited: blank(dep) ? null : toNumber(dep),
        remarks: s(r['Reason code (lower/no deduction)']), certificate_no: s(r['Certificate no.']),
      };
      if (form === '143') {
        x.non_resident = s(r['Non-resident (Y/N)']).toUpperCase().slice(0, 1) || 'N';
        x.opting_out = s(r['Opting out of tax regime (Y/N)']).toUpperCase().slice(0, 1) || 'N';
        x.collectee_code = s(r['Collectee code (01-10)']);
        x.permanent_establishment = s(r['Permanent establishment (Y/N, non-residents)']).toUpperCase().slice(0, 1);
        if (!x.collectee_code) missing.push(`Deductees row ${i}: collectee code`);
      }
      const n = parseInt(s(r['Challan #']), 10);
      const c = byNo.get(n);
      if (!c) missing.push(`Deductees row ${i}: challan #${n} not on Challans sheet`);
      else c.deductees.push(x);
    } catch (e) {
      missing.push(`Deductees row ${i}: ${(e as Error).message}`);
    }
  });
  const challans = [...byNo.keys()].sort((a, b) => a - b).map(k => byNo.get(k)!);

  let salary: SalaryDetail[] | null = null;
  if (form === '138' && quarter === 4) {
    const r = readSalary(wb);
    salary = r.salary; missing.push(...r.missing);
  }
  let deductor: Deductor | null = null;
  try { deductor = readDeductor(wb); } catch (e) { missing.push((e as Error).message); }
  return { challans, deductor, salary, missing };
}

function readDeductor(wb: XLSX.WorkBook): Deductor | null {
  const ws = wb.Sheets['Deductor'];
  if (!ws) return null;
  const labels = new Map(DEDUCTOR_FIELDS);
  const vals: Record<string, string> = {};
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  for (const r of grid.slice(1)) {
    const key = labels.get(s(r[0]));
    if (key && s(r[1])) vals[key] = s(r[1]);
  }
  if (!Object.keys(vals).length) return null;
  const need = ['tan', 'pan', 'name', 'deductor_type', 'rp_name', 'rp_pan'].filter(k => !(k in vals));
  if (need.length) throw new Error(`Deductor sheet is missing: ${need.join(', ')}`);
  const g = (k: string) => vals[k] ?? '';
  return {
    tan: g('tan').toUpperCase(), pan: g('pan').toUpperCase(), deductor_type: g('deductor_type'),
    responsible_designation: g('rp_designation'), responsible_pan: g('rp_pan').toUpperCase(), gstn: g('gstn'),
    entity: { name: g('name'), address1: g('address1'), address2: g('address2'), address3: g('address3'),
      address4: g('address4'), town: g('town'), state_code: g('state_code'), pin: g('pin'), email: g('email'),
      std_code: g('std_code'), phone: g('phone'), country: 'INDIA' },
    responsible: { name: g('rp_name'), address1: g('rp_address1'), address2: g('rp_address2'), address3: g('rp_address3'),
      address4: g('rp_address4'), town: g('rp_town'), state_code: g('rp_state_code'), pin: g('rp_pin'),
      email: g('rp_email'), std_code: g('rp_std_code'), phone: g('rp_phone'), country: 'INDIA' },
  };
}

const NON_NUMERIC = new Set(['pan', 'name', 'category', 'regime', 'employed_from', 'employed_to', 'taxable_income',
  'higher_rate', 'rent_over_1lakh', 'interest_to_lender', 'landlord_pans', 'landlord_names', 'lender_pans', 'lender_names']);

function readSalary(wb: XLSX.WorkBook): { salary: SalaryDetail[]; missing: string[] } {
  const ws = wb.Sheets[SALARY_SHEET];
  if (!ws) return { salary: [], missing: [`Form 138 Q4 needs the "${SALARY_SHEET}" sheet (one row per employee)`] };
  const out: SalaryDetail[] = [], missing: string[] = [];
  rows(ws).forEach((r, k) => {
    const i = k + 2, who = `${SALARY_SHEET} row ${i}`;
    const g: Record<string, unknown> = Object.fromEntries(SALARY_COLS.map(([h, key]) => [key, r[h] ?? null]));
    const regime = s(g.regime).toLowerCase();
    if (regime !== 'old' && regime !== 'new') { missing.push(`${who}: regime must be Old or New`); return; }
    const cat = s(g.category).toUpperCase().slice(0, 1);
    if (!(cat in EMPLOYEE_CATEGORY)) { missing.push(`${who}: category must be G, W, S or O`); return; }
    try {
      const via: ViaItem[] = [];
      for (const sec of VIA_ORDER) {
        const ded = r[`${sec} deductible`];
        if (blank(ded) && blank(r[`${sec} gross`])) continue;
        via.push({ section: sec, deductible: num0(ded), gross: num0(r[`${sec} gross`]),
          qualifying: VIA_WITH_QUALIFYING.has(sec) ? num0(r[`${sec} qualifying`]) : null });
      }
      const split = (v: unknown) => s(v).split(',').map(x => x.trim()).filter(Boolean);
      const pairs = (p: unknown, n: unknown): [string, string][] => {
        const ps = split(p), ns = split(n);
        return ps.map((x, j) => [x, ns[j] ?? '']);
      };
      const nums: Record<string, number> = {};
      for (const [, key] of SALARY_COLS) if (!NON_NUMERIC.has(key) && !key.startsWith('via:')) nums[key] = num0(g[key]);
      out.push({
        ...(nums as unknown as Partial<SalaryDetail>),
        pan: s(g.pan).toUpperCase(), name: s(g.name), category: cat, old_regime: regime === 'old',
        employed_from: toYmd(g.employed_from), employed_to: toYmd(g.employed_to), via,
        salary_17_1: nums.salary_17_1,
        taxable_income: blank(g.taxable_income) ? null : toNumber(g.taxable_income),
        higher_rate: s(g.higher_rate).toUpperCase().slice(0, 1) || 'N',
        rent_over_1lakh: s(g.rent_over_1lakh).toUpperCase().slice(0, 1) || 'N',
        landlords: pairs(g.landlord_pans, g.landlord_names),
        interest_to_lender: s(g.interest_to_lender).toUpperCase().slice(0, 1) || 'N',
        lenders: pairs(g.lender_pans, g.lender_names),
      });
    } catch (e) {
      missing.push(`${who}: ${(e as Error).message}`);
    }
  });
  return { salary: out, missing };
}
