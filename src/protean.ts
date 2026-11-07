/**
 * Protean (NSDL) e-TDS/TCS return file writer — TypeScript port of
 * plugins/tds-agent/skills/tds-quarter/scripts/protean_writer.py (tds-agent 2.6.0 and later).
 *
 * Builds the caret-separated regular statement that Protean's free RPU writes with
 * "Create File", for Form 138 (TDS on salary, incl. Q4 salary details), Form 140
 * (TDS other than salary) and Form 143 (TCS). Validate the result with Protean's FVU
 * on the user's own PC — the FVU is Protean's Java software and cannot run in a browser.
 *
 * Pure functions, no I/O, no network: safe to run entirely in the browser so client
 * PANs / TANs / salaries never leave the user's machine.
 *
 * PARITY: output must be byte-for-byte identical to the Python writer. Run
 *   node web/test/parity.test.ts
 * after any change. Dates are 'YYYY-MM-DD' strings (no Date objects, no time zones).
 */

export const AGENT_VERSION = '2.6.0';
export const WRITER_NAME = 'TDSAGENT';      // FH field 10
export const TARGET_FVU = '1.2';            // FVU version this layout was taken from

export const FH_FIELDS = 18, BH_FIELDS = 72, CD_FIELDS = 30, DD_FIELDS = 45;
export const SD_FIELDS = 88, S16_FIELDS = 8, C6A_FIELDS = 10;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
export const SUPPORTED_FORMS = ['138', '140', '143'] as const;
export type Form = typeof SUPPORTED_FORMS[number];
export type Ymd = string;                   // 'YYYY-MM-DD'

// ---------------------------------------------------------------- data shapes
export interface Person {
  name: string; address1?: string; address2?: string; address3?: string; address4?: string;
  town?: string; state_code?: string; pin?: string; email?: string; std_code?: string; phone?: string;
  country?: string;                         // default 'INDIA'
}

export interface Deductor {
  tan: string; pan: string; entity: Person;
  deductor_type: string;                    // BH 32: F firm, K company, P individual/HUF ...
  responsible: Person; responsible_designation: string; responsible_pan: string;
  gstn?: string;
}

export interface Deductee {
  pan: string; name: string;
  section_code: string;                     // 4-digit internal code, e.g. '1023', '1067'
  date_paid: Ymd; amount: number; tds: number; date_deducted: Ymd;
  rate: number;                             // percent; ignored for Form 138
  deposited?: number | null;                // defaults to tds
  remarks?: string; certificate_no?: string;
  // Form 143 only
  non_resident?: string;                    // Y/N, default N
  opting_out?: string;                      // Y/N, default N
  collectee_code?: string;                  // '01'..'10'
  permanent_establishment?: string;         // non-residents only
  tds_liable?: string; tds_challan_no?: string; tds_paid_on?: Ymd | null;   // remark F only
}

export interface Challan {
  bsr: string; challan_no: string; date_deposited: Ymd;
  tax: number;                              // FULL physical challan tax, even if shared with other forms
  interest?: number; fee?: number; others?: number;
  minor_head?: string;                      // default '200'
  interest_allocated?: number | null; fee_allocated?: number | null;
  deductees: Deductee[];
}

export interface ViaItem { section: string; deductible: number; gross?: number | null; qualifying?: number | null }

export interface SalaryDetail {
  pan: string; name: string;
  category: string;                         // G / W / S / O
  old_regime: boolean;                      // true = opted OUT of the new regime
  employed_from: Ymd; employed_to: Ymd;
  salary_17_1: number; perquisites_17_2?: number; profits_17_3?: number; previous_employer_salary?: number;
  travel_concession?: number; gratuity?: number; commuted_pension?: number; leave_encashment?: number;
  hra_exemption?: number; other_exemption?: number; allowances_10_14?: number;
  standard_deduction?: number; entertainment_16ii?: number; professional_tax_16iii?: number;
  house_property?: number; other_income?: number;
  via?: ViaItem[];
  tax?: number; rebate_87a?: number; surcharge?: number; cess?: number; relief_89?: number;
  tds_current?: number; tds_previous?: number; tds_192_2b?: number;
  higher_rate?: string; rent_over_1lakh?: string; landlords?: [string, string][];
  interest_to_lender?: string; lenders?: [string, string][];
  taxable_income?: number | null;           // override (rounding u/s 288A)
}

// ---------------------------------------------------------------- formatting (matches Python)
/** Python f'{x:.Nf}': correctly rounded, ties to even on the exact binary value. */
function fixed(x: number, places: number): string {
  // Round the EXACT decimal value of the binary number, ties to even — what Python's
  // f'{x:.2f}' does. toPrecision(100) gives the exact expansion for any amount >= 1e-6
  // (a double has at most ~75 significant decimal digits in that range).
  if (!Number.isFinite(x)) throw new Error(`Not a number: ${x}`);
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let intPart: string, frac: string;
  if (ax !== 0 && ax < 1e-6) { intPart = '0'; frac = '0000001'; }   // tiny: rounds to zero at <= 6 places
  else {
    const s = ax === 0 ? '0' : ax.toPrecision(100);
    [intPart, frac = ''] = s.split('.');
  }
  frac = frac.padEnd(places + 1, '0');
  let digits = BigInt(intPart + frac.slice(0, places));
  const rest = frac.slice(places);                       // digits beyond the last kept place
  const first = rest[0], tail = rest.slice(1);
  if (first > '5' || (first === '5' && /[1-9]/.test(tail)) || (first === '5' && digits % 2n === 1n)) digits += 1n;
  let out = digits.toString().padStart(places + 1, '0');
  out = places ? `${out.slice(0, -places)}.${out.slice(-places)}` : out;
  return neg ? `-${out}` : out;                          // Python keeps the sign: -0.004 -> '-0.00'
}
export const amt = (v: number | null | undefined): string => fixed(Number(v || 0), 2);
export const rate4 = (v: number | null | undefined): string => fixed(Number(v || 0), 4);
export const dmy = (d: Ymd): string => { const [y, m, dd] = d.split('-'); return `${dd}${m}${y}`; };

export function clean(text: unknown, maxlen?: number): string {
  let t = String(text ?? '').replace(/[\^\r\n\t]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim().toUpperCase();
  return maxlen ? t.slice(0, maxlen) : t;
}

function line(fields: Record<number, string | number>, width: number): string {
  const out: string[] = [];
  for (let i = 1; i <= width; i++) out.push(fields[i] === undefined ? '' : String(fields[i]));
  return out.join('^');
}

// ---------------------------------------------------------------- Form 143 collectee codes
export const COLLECTEE_CODES: Record<string, string> = {
  '01': 'Company, other than domestic company', '02': 'Individual', '03': 'Hindu Undivided Family',
  '04': 'AOP (other than AOP of only companies)', '05': 'AOP consisting only of companies',
  '06': 'Co-operative society', '07': 'Firm', '08': 'Body of individuals',
  '09': 'Artificial juridical person', '10': 'Others',
};
const PAN4_TO_COLLECTEE: Record<string, string> = { P: '02', H: '03', A: '04', F: '07', E: '07', B: '08', J: '09' };
/** Code implied by the PAN's 4th letter, or '' when a person must decide (companies, trusts, govt). */
export const collecteeCodeFromPan = (pan: string): string => (pan.length === 10 ? PAN4_TO_COLLECTEE[pan[3]] ?? '' : '');

// ---------------------------------------------------------------- Form 138 Q4 salary details
export const VIA_ORDER = ['80CCE', '80CCF', '80CCG', 'OTHERS', '80C', '80CCC', '80CCD(1)', '80CCD(1B)', '80CCD(2)',
  '80D', '80E', '80G', '80TTA', '80CCH', '80CCH(1)'];
export const VIA_WITH_QUALIFYING = new Set(['OTHERS', '80G', '80TTA']);
export const VIA_DEDUCTIBLE_ONLY = new Set(['80CCE', '80CCF', '80CCG']);
export const VIA_NEW_REGIME = new Set(['80CCD(2)', '80CCH', '80CCH(1)']);
export const EMPLOYEE_CATEGORY: Record<string, string> = { G: 'Others', W: 'Woman', S: 'Senior citizen', O: 'Super senior citizen' };

const n0 = (v: number | null | undefined) => Number(v || 0);
export const salary = {
  exemptions: (s: SalaryDetail) => n0(s.travel_concession) + n0(s.gratuity) + n0(s.commuted_pension) +
    n0(s.leave_encashment) + n0(s.hra_exemption) + n0(s.other_exemption) + n0(s.allowances_10_14),
  s16: (s: SalaryDetail): [string, number][] =>
    ([['16(ii)', n0(s.entertainment_16ii)], ['16(iii)', n0(s.professional_tax_16iii)],
      ['16(ia)', n0(s.standard_deduction)]] as [string, number][]).filter(([, v]) => v),
  currentSalary: (s: SalaryDetail) => n0(s.salary_17_1) + n0(s.perquisites_17_2) + n0(s.profits_17_3),
  totalSalary: (s: SalaryDetail) => salary.currentSalary(s) + n0(s.previous_employer_salary),
  incomeSalaries: (s: SalaryDetail) =>
    salary.totalSalary(s) - salary.exemptions(s) - salary.s16(s).reduce((a, [, v]) => a + v, 0),
  gti: (s: SalaryDetail) => salary.incomeSalaries(s) + n0(s.house_property) + n0(s.other_income),
  viaLines: (s: SalaryDetail): ViaItem[] => {
    const order = new Map(VIA_ORDER.map((x, i) => [x, i]));
    return [...(s.via ?? [])].sort((a, b) => order.get(a.section)! - order.get(b.section)!).filter(v =>
      VIA_DEDUCTIBLE_ONLY.has(v.section) ? !!v.deductible
        : VIA_WITH_QUALIFYING.has(v.section) ? !!(v.deductible || v.gross || v.qualifying)
          : !!(v.deductible || v.gross));
  },
  viaTotal: (s: SalaryDetail) => salary.viaLines(s).reduce((a, v) => a + v.deductible, 0),
  taxable: (s: SalaryDetail) =>
    s.taxable_income !== null && s.taxable_income !== undefined ? s.taxable_income : salary.gti(s) - salary.viaTotal(s),
  netTax: (s: SalaryDetail) => n0(s.tax) + n0(s.surcharge) + n0(s.cess) - n0(s.rebate_87a) - n0(s.relief_89),
  totalTds: (s: SalaryDetail) => n0(s.tds_current) + n0(s.tds_previous) + n0(s.tds_192_2b),
};

function salaryLines(n: number, s: SalaryDetail, nextLine: number): string[] {
  const A = amt, S = salary;
  const isNew = !s.old_regime;
  const s16 = S.s16(s), via = S.viaLines(s);
  const agg80c = via.filter(v => ['80C', '80CCC', '80CCD(1)'].includes(v.section)).reduce((a, v) => a + v.deductible, 0);
  const landlords = s.landlords ?? [], lenders = s.lenders ?? [];
  const rent = s.rent_over_1lakh ?? 'N', lender = s.interest_to_lender ?? 'N';
  const sd: Record<number, string | number> = {
    2: 'SD', 3: 1, 4: n, 5: 'A', 7: s.pan, 9: clean(s.name, 75), 10: s.category,
    11: dmy(s.employed_from), 12: dmy(s.employed_to), 13: A(S.totalSalary(s)),
    15: s16.length, 16: A(s16.reduce((a, [, v]) => a + v, 0)), 17: A(S.incomeSalaries(s)), 18: A(s.house_property),
    19: A(S.gti(s)), 21: via.length, 22: A(S.viaTotal(s)), 23: A(S.taxable(s)),
    24: A(s.tax), 25: A(s.surcharge), 26: A(s.cess), 27: A(s.relief_89), 28: A(S.netTax(s)),
    29: A(S.totalTds(s)), 30: A(S.netTax(s) - S.totalTds(s)), 31: A(agg80c),
    34: A(S.currentSalary(s)), 35: A(s.previous_employer_salary), 36: A(s.tds_current), 37: A(s.tds_previous),
    38: s.higher_rate ?? 'N', 39: rent,
    40: rent === 'Y' ? String(landlords.length) : '0',
    49: lender, 50: lender === 'Y' ? String(lenders.length) : '0',
    59: 'N',
    67: A(s.salary_17_1), 68: A(s.perquisites_17_2), 69: A(s.profits_17_3),
    70: isNew ? '' : A(s.travel_concession), 71: A(s.gratuity), 72: A(s.commuted_pension),
    73: A(s.leave_encashment), 74: isNew ? '' : A(s.hra_exemption), 75: A(s.other_exemption),
    76: A(S.exemptions(s)), 77: A(s.other_income), 78: A(s.rebate_87a), 79: s.old_regime ? 'Y' : 'N',
    80: A(s.allowances_10_14), 81: A(s.tds_192_2b),
  };
  if (rent === 'Y') landlords.slice(0, 4).forEach(([p, nm], k) => { sd[41 + 2 * k] = p; sd[42 + 2 * k] = clean(nm, 75); });
  if (lender === 'Y') lenders.slice(0, 4).forEach(([p, nm], k) => { sd[51 + 2 * k] = p; sd[52 + 2 * k] = clean(nm, 75); });
  const out: string[] = [];
  sd[1] = nextLine; out.push(line(sd, SD_FIELDS));
  s16.forEach(([sid, v], k) =>
    out.push(line({ 1: nextLine + out.length, 2: 'S16', 3: 1, 4: n, 5: k + 1, 6: sid, 7: A(v) }, S16_FIELDS)));
  via.forEach((v, k) => {
    const f: Record<number, string | number> = { 1: nextLine + out.length, 2: 'C6A', 3: 1, 4: n, 5: k + 1, 6: v.section, 7: A(v.deductible) };
    if (!VIA_DEDUCTIBLE_ONLY.has(v.section)) f[8] = A(v.gross || 0);
    if (VIA_WITH_QUALIFYING.has(v.section)) f[9] = A(v.qualifying || 0);
    out.push(line(f, C6A_FIELDS));
  });
  return out;
}

// ---------------------------------------------------------------- builder
const FILE_TYPE: Record<string, string> = { '138': 'SL1', '140': 'NS1', '144': 'NS1', '143': 'TC1' };
const challanTotal = (c: Challan) => n0(c.tax) + n0(c.interest) + n0(c.fee) + n0(c.others);

function ddFields(form: Form, x: Deductee, c: Challan): Record<number, string> {
  if (form === '140') return {};
  if (form === '138') return { 28: '', 29: dmy(c.date_deposited) };   // salary: no rate; date of deposit instead
  const raw = String(x.collectee_code ?? '').trim();
  const f: Record<number, string> = { 11: x.non_resident ?? 'N', 12: /^\d+$/.test(raw) ? String(parseInt(raw, 10)) : '', 14: x.opting_out ?? 'N' };
  if ((x.non_resident ?? 'N') === 'Y') f[13] = x.permanent_establishment ?? '';
  if (x.remarks === 'F') {
    f[34] = x.tds_liable ?? '';
    if (x.tds_liable === 'Y') { f[35] = x.tds_challan_no ?? ''; f[36] = x.tds_paid_on ? dmy(x.tds_paid_on) : ''; }
  }
  return f;
}

export interface BuildOptions {
  form: Form; deductor: Deductor; challans: Challan[]; fyStart: number; quarter: 1 | 2 | 3 | 4;
  prevToken?: string | null;                // RRR no. of the previous regular statement of this form
  created?: Ymd;                            // file creation date, default today
  salary?: SalaryDetail[];                  // Form 138 Q4 only
}

const todayYmd = (): Ymd => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function buildStatement(o: BuildOptions): string[] {
  const { form, deductor: d, challans, fyStart, quarter } = o;
  if (!SUPPORTED_FORMS.includes(form)) throw new Error(`Form ${form} not supported (supported: ${SUPPORTED_FORMS.join(', ')})`);
  const q4 = form === '138' && quarter === 4;
  if (q4 && !o.salary) throw new Error("Form 138 Q4 needs every employee's annual salary details");
  if (o.salary && o.salary.length && !q4) throw new Error('Salary details belong only in Form 138 Q4');
  const sal = o.salary ?? [];
  const prev = o.prevToken || '';
  const lines: string[] = [];
  lines.push(line({ 1: 1, 2: 'FH', 3: FILE_TYPE[form], 4: 'R', 5: dmy(o.created ?? todayYmd()), 6: 1, 7: 'D',
    8: d.tan, 9: 1, 10: WRITER_NAME }, FH_FIELDS));
  const e = d.entity, r = d.responsible;
  lines.push(line({
    1: 2, 2: 'BH', 3: 1, 4: challans.length, 5: form, 9: prev, 13: d.tan, 15: d.pan,
    16: `${fyStart + 1}${String(fyStart + 2).slice(-2)}`, 17: `${fyStart}${String(fyStart + 1).slice(-2)}`, 18: `Q${quarter}`,
    19: clean(e.name, 75), 20: clean(e.country ?? 'INDIA'),
    21: clean(e.address1, 25), 22: clean(e.address2, 25), 23: clean(e.address3, 25), 24: clean(e.address4, 25),
    25: clean(e.town, 25), 26: e.state_code ?? '', 27: e.pin ?? '', 28: e.email ?? '', 29: e.std_code ?? '', 30: e.phone ?? '',
    32: d.deductor_type,
    33: clean(r.name, 75), 34: clean(d.responsible_designation, 20),
    35: clean(r.address1, 25), 36: clean(r.address2, 25), 37: clean(r.address3, 25), 38: clean(r.address4, 25),
    39: clean(r.town, 25), 40: r.state_code ?? '', 41: r.pin ?? '', 42: r.email ?? '', 43: clean(r.country ?? 'INDIA'),
    44: r.std_code ?? '', 45: r.phone ?? '',
    47: amt(challans.reduce((a, c) => a + challanTotal(c), 0)),
    49: form === '138' ? (q4 ? String(sal.length) : '0') : '',
    50: q4 ? amt(sal.reduce((a, s) => a + salary.gti(s), 0)) : '',
    70: q4 ? '0' : '', 71: q4 ? '0.00' : '',
    52: prev ? 'Y' : 'N', 59: d.responsible_pan, 69: d.gstn ?? '',
  }, BH_FIELDS));

  challans.forEach((c, ci0) => {
    const ci = ci0 + 1;
    const depOf = (x: Deductee) => (x.deposited !== null && x.deposited !== undefined ? x.deposited : x.tds);
    const depTotal = c.deductees.reduce((a, x) => a + Number(depOf(x)), 0);
    const nil = challanTotal(c) === 0;
    lines.push(line({
      1: lines.length + 1, 2: 'CD', 3: 1, 4: ci, 5: c.deductees.length, 6: nil ? 'Y' : 'N',
      8: amt(c.tax), 9: amt(c.interest), 10: amt(c.fee), 11: amt(c.others), 12: amt(nil ? 0 : challanTotal(c)),
      13: nil ? '' : 'C', 15: nil ? '' : c.bsr, 17: nil ? '' : c.challan_no, 19: dmy(c.date_deposited),
      21: amt(nil ? 0 : depTotal), 22: amt(nil ? 0 : depTotal), 23: nil ? '' : (c.minor_head ?? '200'),
      24: amt(c.interest_allocated ?? c.interest), 25: amt(c.fee_allocated ?? c.fee),
    }, CD_FIELDS));
    c.deductees.forEach((x, di) => {
      const dd: Record<number, string | number> = {
        1: lines.length + 1, 2: 'DD', 3: 1, 4: di + 1, 5: ci, 6: 'O', 8: x.pan, 9: clean(x.name, 75),
        15: x.section_code, 18: 'Y', 19: dmy(x.date_paid), 20: amt(x.amount),
        24: amt(x.tds), 25: amt(nil ? 0 : depOf(x)), 27: dmy(x.date_deducted), 28: rate4(x.rate),
        32: x.remarks ?? '', 33: x.certificate_no ?? '',
      };
      Object.assign(dd, ddFields(form, x, c));
      lines.push(line(dd, DD_FIELDS));
    });
  });
  sal.forEach((s, k) => lines.push(...salaryLines(k + 1, s, lines.length + 1)));
  return lines;
}

// ---------------------------------------------------------------- checks (same rules as Python)
export function checkStatement(lines: string[], fyStart: number, quarter: number): string[] {
  const probs: string[] = [];
  const form = (lines.map(l => l.split('^')).find(f => f[1] === 'BH') ?? [])[4] ?? '';
  const widths: Record<string, number> = { FH: FH_FIELDS, BH: BH_FIELDS, CD: CD_FIELDS, DD: DD_FIELDS, SD: SD_FIELDS, S16: S16_FIELDS, C6A: C6A_FIELDS };
  const qm = ({ 1: [4, 6], 2: [7, 9], 3: [10, 12], 4: [1, 3] } as Record<number, number[]>)[quarter];
  const qYear = quarter === 4 ? fyStart + 1 : fyStart;
  let batchTotal = 0, cdTotal = 0, cur: string[] | null = null, ddSum = 0, ddCount = 0;
  const closeCd = () => {
    if (!cur) return;
    if (Math.abs(ddSum - Number(cur[21])) > 0.001) probs.push(`CD ${cur[4]}: deductee deposited total ${ddSum.toFixed(2)} != CD field 21 ${cur[21]}`);
    if (ddCount !== Number(cur[5])) probs.push(`CD ${cur[4]}: ${ddCount} DD lines but count field says ${cur[5]}`);
  };
  lines.forEach((ln, i) => {
    const n = i + 1, f = ['', ...ln.split('^')], rt = f[2];
    if (!(rt in widths)) { probs.push(`line ${n}: unknown record type ${rt}`); return; }
    if (f.length - 1 !== widths[rt]) probs.push(`line ${n} ${rt}: ${f.length - 1} fields, expected ${widths[rt]}`);
    if (f[1] !== String(n)) probs.push(`line ${n} ${rt}: line number field is ${f[1]}`);
    if (rt === 'FH' && !TAN_RE.test(f[8])) probs.push('FH: TAN format invalid');
    if (rt === 'BH') {
      batchTotal = Number(f[47]);
      if (!PAN_RE.test(f[15])) probs.push('BH: deductor PAN format invalid');
      if (f[52] === 'Y' && !/^\d{15}$/.test(f[9])) probs.push('BH: previous statement filed = Y but field 9 is not a 15-digit RRR number');
      if (f[59] && !PAN_RE.test(f[59])) probs.push('BH: responsible person PAN invalid');
    }
    if (rt === 'CD') {
      closeCd(); cur = f; ddSum = 0; ddCount = 0;
      cdTotal += Number(f[12]);
      const tot = [8, 9, 10, 11].reduce((a, k) => a + Number(f[k]), 0);
      if (Math.abs(tot - Number(f[12])) > 0.001) probs.push(`CD ${f[4]}: tax+interest+fee+others ${tot.toFixed(2)} != total ${f[12]}`);
      if (f[6] === 'N' && !/^\d{7}$/.test(f[15])) probs.push(`CD ${f[4]}: BSR code not 7 digits`);
    }
    if (rt === 'DD') {
      ddCount++; ddSum += Number(f[25]);
      if (!PAN_RE.test(f[8]) && !['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'].includes(f[8])) probs.push(`line ${n} DD: PAN ${f[8]} invalid`);
      if (cur && f[5] !== cur[4]) probs.push(`line ${n} DD: challan number ${f[5]} does not match its CD ${cur[4]}`);
      for (const fi of [19, 27]) {
        const mo = Number(f[fi].slice(2, 4)), yr = Number(f[fi].slice(4));
        if (!(qm[0] <= mo && mo <= qm[1] && yr === qYear)) probs.push(`line ${n} DD: date ${f[fi]} (field ${fi}) outside Q${quarter}`);
      }
      if (Number(f[24]) > Number(f[20]) + 0.001) probs.push(`line ${n} DD: TDS more than amount paid`);
      if (form === '138') {
        if (f[28]) probs.push(`line ${n} DD: Form 138 has no rate of deduction (field 28 must be blank)`);
        if (cur && f[29] !== cur[19]) probs.push(`line ${n} DD: date of deposit ${f[29]} (field 29) must equal its challan date ${cur[19]}`);
      } else if (!/^\d{1,3}\.\d{4}$/.test(f[28])) probs.push(`line ${n} DD: rate ${f[28]} must have 4 decimal places (T-FV-4092)`);
      for (const fi of [20, 24, 25]) if (!/^\d+\.\d{2}$/.test(f[fi])) probs.push(`line ${n} DD: amount field ${fi} ${f[fi]} must have 2 decimal places`);
      if (form === '143') {
        for (const [fi, what] of [[11, 'non-resident'], [14, 'opting out of tax regime']] as [number, string][])
          if (!['Y', 'N'].includes(f[fi])) probs.push(`line ${n} DD: "${what}" (field ${fi}) must be Y or N`);
        if (!(/^\d+$/.test(f[12]) && Number(f[12]) >= 1 && Number(f[12]) <= 10))
          probs.push(`line ${n} DD: collectee code (field 12) missing - mandatory on every row (T_FV_6417)`);
        if (f[11] === 'Y' && !['Y', 'N'].includes(f[13])) probs.push(`line ${n} DD: non-resident collectee needs permanent establishment Y/N (field 13)`);
      }
    }
  });
  closeCd();
  if (Math.abs(batchTotal - cdTotal) > 0.001) probs.push(`BH field 47 ${batchTotal.toFixed(2)} != sum of challan totals ${cdTotal.toFixed(2)}`);
  return probs.concat(checkSalary(lines, form, fyStart, quarter));
}

function checkSalary(lines: string[], form: string, fyStart: number, quarter: number): string[] {
  const probs: string[] = [];
  const recs = lines.map(l => ['', ...l.split('^')]);
  const bh = recs.find(f => f[2] === 'BH')!;
  const sds = recs.map((f, i) => (f[2] === 'SD' ? i : -1)).filter(i => i >= 0);
  if (!(form === '138' && quarter === 4)) {
    if (sds.length || recs.some(f => f[2] === 'S16' || f[2] === 'C6A')) probs.push('salary detail lines (SD/S16/C6A) belong only in Form 138 Q4');
    return probs;
  }
  if (bh[49] !== String(sds.length)) probs.push(`BH field 49 says ${bh[49]} salary records, file has ${sds.length}`);
  const gtiSum = sds.reduce((a, i) => a + Number(recs[i][19]), 0);
  if (!bh[50] || Math.abs(Number(bh[50]) - gtiSum) > 0.005) probs.push(`BH field 50 ${bh[50]} != total gross total income ${gtiSum.toFixed(2)}`);
  const fyFrom = `${fyStart}0401`, fyTo = `${fyStart + 1}0331`;
  const ord = (d: string) => `${d.slice(4)}${d.slice(2, 4)}${d.slice(0, 2)}`;   // ddmmyyyy -> yyyymmdd
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  sds.forEach((i, k) => {
    const f = recs[i], who = `SD ${f[4]} (${f[7]})`;
    const end = k + 1 < sds.length ? sds[k + 1] : recs.length;
    const subs = recs.slice(i + 1, end);
    const s16 = subs.filter(s => s[2] === 'S16'), c6a = subs.filter(s => s[2] === 'C6A');
    if (subs.some(s => !['S16', 'C6A'].includes(s[2]))) probs.push(`${who}: only S16/C6A lines may follow a salary record`);
    if (subs.map(s => s[2]).join() !== [...s16.map(() => 'S16'), ...c6a.map(() => 'C6A')].join()) probs.push(`${who}: S16 lines must come before C6A lines`);
    if (!PAN_RE.test(f[7]) && !['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'].includes(f[7])) probs.push(`${who}: PAN invalid`);
    if (!(f[10] in EMPLOYEE_CATEGORY)) probs.push(`${who}: category ${f[10]} must be one of G/W/S/O`);
    if (/^\d{8}$/.test(f[11]) && /^\d{8}$/.test(f[12])) {
      const d1 = ord(f[11]), d2 = ord(f[12]);
      if (!(fyFrom <= d1 && d1 <= d2 && d2 <= fyTo)) probs.push(`${who}: employment period ${f[11]}-${f[12]} must fall inside the financial year`);
    } else probs.push(`${who}: employment dates must be ddmmyyyy`);
    if (!['Y', 'N'].includes(f[79])) probs.push(`${who}: regime flag (field 79) must be Y (old regime) or N (new regime)`);
    if (['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'].includes(f[7]) && f[38] !== 'Y')
      probs.push(`${who}: no valid PAN, so "tax deducted at higher rate" (field 38) must be Y (T-FV-4319)`);
    const sd16 = s16.reduce((a, s) => a + Number(s[7]), 0);
    if (sd16 > Number(f[13]) + 0.005) probs.push(`${who}: section 16 deductions exceed salary - the standard deduction is limited to the salary (T-FV-4026)`);
    if (Number(f[17]) < 0) probs.push(`${who}: income under salaries is negative (T-FV-4026)`);
    if (Number(f[19]) < 0 && Number(f[18]) >= 0) probs.push(`${who}: gross total income is negative (T-FV-4028)`);
    if (Number(f[23]) < 0 || Number(f[22]) > Math.max(Number(f[19]), 0) + 0.005) probs.push(`${who}: Chapter VI-A exceeds gross total income - taxable income cannot be negative (T-FV-4031)`);
    if (Number(f[24]) < 0) probs.push(`${who}: tax on total income is negative (T-FV-4032)`);
    if (f[79] === 'N') {
      if (f[70] || f[74]) probs.push(`${who}: new regime - travel concession and HRA exemption must be blank (T_FV_6354)`);
      if (Number(f[18]) < 0) probs.push(`${who}: new regime - house property loss not allowed`);
      const bad = c6a.map(s => s[6]).filter(x => !VIA_NEW_REGIME.has(x));
      if (bad.length) probs.push(`${who}: new regime - deductions ${bad.join(', ')} not allowed`);
    }
    if (Number(f[15]) !== s16.length || !near(Number(f[16]), sd16)) probs.push(`${who}: section 16 count/total (fields 15/16) do not match its S16 lines`);
    if (Number(f[21]) !== c6a.length || !near(Number(f[22]), c6a.reduce((a, s) => a + Number(s[7]), 0))) probs.push(`${who}: Chapter VI-A count/total (fields 21/22) do not match its C6A lines`);
    s16.forEach((s, j) => { if (s[4] !== f[4] || s[5] !== String(j + 1)) probs.push(`${who}: S16 numbering wrong`); });
    c6a.forEach((s, j) => { if (s[4] !== f[4] || s[5] !== String(j + 1)) probs.push(`${who}: C6A numbering wrong`); });
    const v = (k2: number) => (f[k2] ? Number(f[k2]) : 0);
    if (!near(v(13), v(34) + v(35))) probs.push(`${who}: total salary (13) != current (34) + previous (35)`);
    if (!near(v(34), v(67) + v(68) + v(69))) probs.push(`${who}: current salary (34) != 17(1)+17(2)+17(3)`);
    if (!near(v(17), v(13) - v(76) - v(16))) probs.push(`${who}: income under salaries (17) != salary - exemptions - s.16`);
    if (!near(v(19), v(17) + v(18) + v(77))) probs.push(`${who}: gross total income (19) != salaries + house property + other income`);
    if (!near(v(28), v(24) + v(25) + v(26) - v(78) - v(27))) probs.push(`${who}: net tax (28) != tax + surcharge + cess - rebate - relief`);
    if (!near(v(29), v(36) + v(37) + v(81))) probs.push(`${who}: total TDS (29) != current + previous + 192(2B)`);
    if (!near(v(30), v(28) - v(29))) probs.push(`${who}: shortfall (30) != net tax - TDS`);
  });
  return probs;
}

// ---------------------------------------------------------------- output file
/** Protean file name rule: at most 12 characters including ".txt", letters and digits only. */
export function checkFileName(name: string): string | null {
  return name.length <= 12 && /^[A-Za-z0-9]+\.txt$/.test(name) ? null : 'File name must be at most 12 letters/digits including ".txt", e.g. ABC140Q2.txt';
}

/** Bytes to save as the .txt: Windows line endings, Windows-1252 text (as the RPU writes). */
export function encodeReturn(lines: string[]): Uint8Array {
  const text = lines.join('\r\n') + '\r\n';
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 255 || (c >= 0x80 && c < 0xa0)) throw new Error(`Character "${text[i]}" cannot be written in a Protean return file (line text: ${text.slice(Math.max(0, i - 20), i + 20)})`);
    out[i] = c;
  }
  return out;
}

// ---------------------------------------------------------------- reuse last quarter's header
/** Deductor details from a previously accepted .fvu (its FH/BH lines are plain text). */
export function deductorFromFvu(fvuText: string): { deductor: Deductor; form: string } {
  for (const ln of fvuText.split(/\r?\n/)) {
    const f = ['', ...ln.split('^')];
    if (f.length > 2 && f[2] === 'BH') {
      return {
        form: f[5],
        deductor: {
          tan: f[13], pan: f[15], deductor_type: f[32], responsible_designation: f[34], responsible_pan: f[59],
          gstn: f.length > 69 ? f[69] : '',
          entity: { name: f[19], country: f[20] || 'INDIA', address1: f[21], address2: f[22], address3: f[23], address4: f[24],
            town: f[25], state_code: f[26], pin: f[27], email: f[28], std_code: f[29], phone: f[30] },
          responsible: { name: f[33], address1: f[35], address2: f[36], address3: f[37], address4: f[38], town: f[39],
            state_code: f[40], pin: f[41], email: f[42], country: f[43] || 'INDIA', std_code: f[44], phone: f[45] },
        },
      };
    }
  }
  throw new Error('No batch header (BH) line found in this .fvu file');
}
