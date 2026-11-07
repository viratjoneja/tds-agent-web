# Build brief: TDS / TCS Return File Builder (for Google AI Studio "Build")

## What to build

A single-page web app, **React + TypeScript + Vite**, that turns a filled Excel input workbook into an Indian quarterly TDS/TCS **return text file** in Protean's (NSDL) format, ready for validation with Protean's free File Validation Utility (FVU). Forms supported (Income-tax Act 2025 numbering, old numbers in brackets):

- **Form 138** (24Q) — TDS on salary, Q1 to Q4 (Q4 includes each employee's annual salary details)
- **Form 140** (26Q) — TDS on payments other than salary
- **Form 143** (27EQ) — TCS

## The engine is provided — do not rewrite it

Four files follow this brief. Put them in `src/core/` **exactly as given** and import from them. They are a tested port of a Python tool whose output Protean's FVU 1.2 has accepted on live returns; the TypeScript version is proven byte-for-byte identical to it. Do not change formatting, rounding, field order, dates or checks.

| File | Use |
|---|---|
| `src/core/protean.ts` | `buildStatement(...)` → lines of the return file; `checkStatement(lines, fyStart, quarter)` → problems (must be empty); `encodeReturn(lines)` → bytes to download; `checkFileName(name)`; `deductorFromFvu(text)` |
| `src/core/inputWorkbook.ts` | `makeTemplate(form)` → blank input .xlsx bytes; `readInputWorkbook(bytes, form, quarter)` → `{challans, deductor, salary, missing}` |
| `src/core/review.ts` | `reviewModel(lines)` → totals, problems, points to review, deductor details, challan / deductee / salary tables |
| `src/core/template_columns.json` | column headings shared with the Python tool |

The core imports each other with `.ts` extensions (e.g. `from './protean.ts'`): enable `"allowImportingTsExtensions": true` and `"noEmit": true` in `tsconfig.json` (Vite handles this), or remove the extensions if your setup needs that — change nothing else. The JSON import uses `with { type: 'json' }`; if the toolchain objects, change it to a plain `import cols from './template_columns.json'`.

**Dependency:** SheetJS, installed from its official CDN (the npm-registry copy is outdated and has a known parser vulnerability):
```
npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

## Privacy rules (mandatory)

- **All processing happens in the browser.** Files are read with `FileReader` / `file.arrayBuffer()` and never uploaded. **No backend, no database, no storage** (not even localStorage) of file contents.
- **Do not call the Gemini API or any other API** with workbook contents, PANs, TANs, names or amounts. The engine is deterministic and needs no AI. Remove any default Gemini client the template project includes.
- No analytics or logging that captures file contents.
- Show this line near the upload box: *"Your files are processed in your browser and are never uploaded."*

## Screens and flow

1. **Setup** — choose Form (138 / 140 / 143), Financial year (start year, e.g. 2026 for 2026-27; offer 2026 onwards), Quarter (Q1–Q4).
   Button **"Download blank input workbook"** → `makeTemplate(form)` saved as `TDS_input_<form>.xlsx`. Short help text: fill sheets Challans and Deductees (and "Salary (Q4)" for Form 138 Q4); fill the Deductor sheet **or** upload last quarter's `.fvu` below; section codes are the 4-digit codes (1002 salary, 1023 contractor, 1073 TCS on scrap …).

2. **Upload**
   - Filled input workbook (.xlsx) — required.
   - Last quarter's accepted `.fvu` of the **same form** — optional; read as text with `TextDecoder('latin1')`; `deductorFromFvu(text)` gives the deductor; if its `form` differs from the chosen form, show an error.
   - **Previous statement RRR number** — text box, 15 digits starting 7700 (validate `^\d{15}$`), help: "on the e-filing acknowledgement of the previous quarter's return (not the 'e-Filing Acknowledgement Number'). Leave blank only if this form was never filed before."
   - **Output file name** — default `<first 3 letters of TAN><form>Q<n>.txt`, validate with `checkFileName` (max 12 characters incl. .txt).

3. **Read** — `readInputWorkbook(bytes, form, quarter)`. If `missing` is not empty, list every item and stop ("Fill these in the workbook and upload again"). If there is no deductor (empty Deductor sheet and no .fvu), ask for one. If the RRR is blank, warn that the file will say "no earlier statement filed".

4. **Build and check** — `lines = buildStatement({ form, deductor, challans, fyStart, quarter, prevToken: rrr || null, salary: salary ?? undefined })`; wrap in try/catch and show errors plainly. Then `rv = reviewModel(lines)`.

5. **Review** (the user must look at this before validating). Tabs:
   - **Summary**: deductor, TAN, FY, quarter, previous RRR, totals (`rv.totals`), and for Form 138 Q4 the salary totals. If `rv.problems` is not empty, show them in red and **disable the download**. Show `rv.pointsToReview` in amber.
   - **Deductor** (`rv.deductorDetails`), **Challans** (`rv.challans`; highlight rows with `balanceForOtherForms > 0` in amber with the note "part of this challan belongs to another form"), **Deductees** (`rv.deductees`), **Salary details** (`rv.salary`, Form 138 Q4 only; highlight `shortfall > 1`).
   - Tables: sortable, filterable, amounts in Indian format (`toLocaleString('en-IN', {minimumFractionDigits: 2})`), totals row.

6. **Download**
   - **Return file**: `new Blob([encodeReturn(lines)], {type: 'application/octet-stream'})`, saved under the chosen name. Do not alter the bytes.
   - **Review workbook**: export the review tabs to .xlsx with SheetJS (`XLSX.utils.json_to_sheet` per tab).

7. **Next steps panel** (static text):
   1. Download Protean's free e-TDS/TCS FVU from Protean's TIN website, unzip it, and run `TDS_STANDALONE_FVU_<version>.jar` (needs Java 8).
   2. Give it the return `.txt`, the CSI file for the TAN (download from the income-tax e-filing portal; rename it so the name has only letters/digits, max 25 characters) and an output folder.
   3. If the FVU reports errors, fix the input workbook and rebuild — never edit the `.txt` by hand.
   4. Upload the `.fvu` on the e-filing portal (DSC/EVC) yourself.
   5. Form 138 Q4: dates of employment and challans cannot be in the future, so a Q4 return validates only after 31 March.

## Text to show on every page (footer)

"Prepares draft return files only. It is not tax advice. A qualified person must review every return before it is filed. Built for Protean FVU version 1.2 (`TARGET_FVU` in the core); if Protean releases a newer FVU, check for an updated version of this tool."

Also show `AGENT_VERSION` and `TARGET_FVU` from `protean.ts` in the footer.

## Look and feel

Clean, form-like, works on a laptop screen; plain language; no jargon beyond the field names used in returns. Step indicator 1–6. Accessible (labels on every input, keyboard navigation). No login.

## Acceptance tests (run these before calling it done)

Test files are in the repository at `web/test/fixtures/` (made-up data): `f140.xlsx`, `f143.xlsx`, `f138q2.xlsx`, `f138q4.xlsx` with expected output `*.txt`; for all of them use FY 2026, RRR `770000000000001`, and the Deductor sheet inside the workbook (no .fvu). Quarters: f140 Q2, f143 Q2, f138q2 Q2, f138q4 Q4.

For each: upload, build, download the `.txt`, and compare with the expected file. They must be identical **except field 5 of line 1** (the creation date, today's date as DDMMYYYY). The review must show no problems. Also check: uploading a workbook with a blank section code lists it under "fill these in"; Form 138 Q4 with a new-regime employee whose HRA is filled is reported as a problem and the download is disabled.

The core can also be checked from a terminal: `node web/test/parity.test.ts` (Node 22.6+; compares the TypeScript output with the Python tool's).

## Hosting on an existing site

The app is entirely static once built (`npm run build` → `dist/`). Either deploy it from AI Studio to Cloud Run and link to it from the site, or set Vite's `base` (e.g. `/tds-tool/`) and copy `dist/` into the existing site under that path. No server code is needed either way.


---

# Core files (put in src/core/ exactly as given)

## src/core/protean.ts

```ts
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
```

## src/core/inputWorkbook.ts

```ts
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
```

## src/core/review.ts

```ts
/**
 * Review data read BACK from a return file's lines — what the user must check before running
 * Protean's FVU. Same content as the Python review workbook (protean_review.py), returned as
 * plain data for the page to show as tables (and to export with SheetJS if wanted).
 */
import { COLLECTEE_CODES, EMPLOYEE_CATEGORY, checkStatement } from './protean.ts';

const STATE: Record<string, string> = { '01': 'Andaman & Nicobar', '02': 'Andhra Pradesh', '03': 'Arunachal Pradesh',
  '04': 'Assam', '05': 'Bihar', '06': 'Chandigarh', '07': 'Dadra & Nagar Haveli', '08': 'Daman & Diu', '09': 'Delhi',
  '10': 'Goa', '11': 'Gujarat', '12': 'Haryana', '13': 'Himachal Pradesh', '14': 'Jammu & Kashmir', '15': 'Karnataka',
  '16': 'Kerala', '17': 'Lakshadweep', '18': 'Madhya Pradesh', '19': 'Maharashtra', '20': 'Manipur', '21': 'Meghalaya',
  '22': 'Mizoram', '23': 'Nagaland', '24': 'Odisha', '25': 'Puducherry', '26': 'Punjab', '27': 'Rajasthan',
  '28': 'Sikkim', '29': 'Tamil Nadu', '30': 'Tripura', '31': 'Uttar Pradesh', '32': 'West Bengal', '33': 'Chhattisgarh',
  '34': 'Uttarakhand', '35': 'Jharkhand', '36': 'Telangana', '37': 'Ladakh', '99': 'Overseas' };
const DEDUCTOR_TYPE: Record<string, string> = { A: 'Central Govt', S: 'State Govt', K: 'Company', F: 'Firm',
  P: 'Individual/HUF', T: 'Trust', J: 'Artificial juridical person', B: 'Body of individuals',
  Q: 'Association of persons', L: 'Local authority' };

const dmyToIso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}` : d);
const n = (v: string) => (v === '' ? null : Number(v));

export interface ReviewModel {
  form: string; tan: string; deductor: string; fy: string; quarter: string; prevRrr: string; software: string;
  totals: { challans: number; deducteeRows: number; distinctPans: number; amountPaid: number; taxDeducted: number;
    taxDeposited: number; challanTotal: number; batchHeaderTotal: number };
  problems: string[];                       // must be empty before running the FVU
  pointsToReview: string[];                 // FVU accepts these, but a person should look
  deductorDetails: { field: number; label: string; value: string }[];
  challans: { no: number; bsr: string; date: string; serial: string; tax: number; interest: number; fee: number;
    others: number; total: number; rows: number; thisFormTax: number; balanceForOtherForms: number; line: number }[];
  deductees: Record<string, string | number | null>[];
  salary: Record<string, string | number | null>[] | null;      // Form 138 Q4
}

const BH_LABELS: [number, string][] = [[5, 'Form'], [9, 'Previous statement RRR no.'], [13, 'TAN'], [15, 'PAN of deductor'],
  [16, 'Assessment year'], [17, 'Financial year'], [18, 'Quarter'], [19, 'Name of deductor'], [21, 'Address 1'],
  [22, 'Address 2'], [23, 'Address 3'], [24, 'Address 4'], [25, 'Town / city'], [26, 'State'], [27, 'PIN'],
  [28, 'Email'], [30, 'Telephone'], [32, 'Deductor type'], [33, 'Responsible person - name'],
  [34, 'Responsible person - designation'], [59, 'Responsible person - PAN'], [39, 'RP town / city'], [40, 'RP state'],
  [41, 'RP PIN'], [42, 'RP email'], [47, 'Total of challan amounts'], [49, 'Salary records (Form 138)'],
  [50, 'Total gross total income (Form 138 Q4)'], [52, 'Earlier regular statement filed?'], [69, 'GSTN']];

export function reviewModel(lines: string[]): ReviewModel {
  const recs = lines.map(l => ['', ...l.split('^')]);
  const fh = recs.find(f => f[2] === 'FH')!, bh = recs.find(f => f[2] === 'BH')!;
  const fyStart = Number(bh[17].slice(0, 4)), quarter = Number(bh[18].slice(1));
  const form = bh[5], tcs = form === '143';
  const problems = checkStatement(lines, fyStart, quarter);

  const challans: ReviewModel['challans'] = [];
  const deductees: ReviewModel['deductees'] = [];
  let cur: string[] | null = null;
  for (const f of recs) {
    if (f[2] === 'CD') {
      cur = f;
      challans.push({ no: +f[4], bsr: f[15], date: dmyToIso(f[19]), serial: f[17], tax: +f[8], interest: +f[9], fee: +f[10],
        others: +f[11], total: +f[12], rows: +f[5], thisFormTax: +f[21], balanceForOtherForms: +f[8] - +f[21], line: +f[1] });
    } else if (f[2] === 'DD' && cur) {
      const code = /^\d+$/.test(f[12]) ? String(+f[12]).padStart(2, '0') : '';
      deductees.push({
        challan: +f[5], rowInChallan: +f[4], pan: f[8], name: f[9], sectionCode: f[15],
        datePaid: dmyToIso(f[19]), amount: +f[20], rate: f[28] ? +f[28] : null, tax: +f[24], deposited: +f[25],
        dateDeducted: dmyToIso(f[27]), wholeTaxDeposited: f[18], reason: f[32], certificate: f[33],
        ...(tcs ? { nonResident: f[11], optingOut: f[14], collecteeCode: code ? `${code} - ${COLLECTEE_CODES[code] ?? '?'}` : '(missing)' } : {}),
        bsr: cur[15], challanSerial: cur[17], dateDeposited: dmyToIso(cur[19]), line: +f[1],
      });
    }
  }
  const pointsToReview: string[] = [];
  const same = deductees.filter(d => form === '138' && Math.abs(Number(d.amount) - Number(d.tax)) < 0.005).length;
  if (same) pointsToReview.push(`${same} salary row(s) show amount paid = TDS. The FVU accepts this, but the amount should be the salary paid/credited.`);
  const shared = challans.filter(c => c.balanceForOtherForms > 0.005).length;
  if (shared) pointsToReview.push(`${shared} challan(s) are shared with another form (balance left for other forms) - confirm that form uses the balance.`);

  let salary: ReviewModel['salary'] = null;
  const sdIdx = recs.map((f, i) => (f[2] === 'SD' ? i : -1)).filter(i => i >= 0);
  if (sdIdx.length) {
    salary = sdIdx.map((i, k) => {
      const f = recs[i], end = k + 1 < sdIdx.length ? sdIdx[k + 1] : recs.length;
      const subs = recs.slice(i + 1, end);
      return {
        sr: +f[4], pan: f[7], name: f[9], category: `${f[10]} - ${EMPLOYEE_CATEGORY[f[10]] ?? '?'}`,
        regime: f[79] === 'Y' ? 'Old' : 'New', employedFrom: dmyToIso(f[11]), employedTo: dmyToIso(f[12]),
        salary17_1: n(f[67]), perquisites17_2: n(f[68]), previousEmployer: n(f[35]), totalSalary: n(f[13]),
        hraExemption: n(f[74]), travelConcession: n(f[70]), totalExemptions: n(f[76]), section16Total: n(f[16]),
        section16Lines: subs.filter(x => x[2] === 'S16').map(x => `${x[6]} ${Number(x[7]).toLocaleString('en-IN')}`).join(', '),
        incomeUnderSalaries: n(f[17]), houseProperty: n(f[18]), otherIncome: n(f[77]), grossTotalIncome: n(f[19]),
        chapterVIALines: subs.filter(x => x[2] === 'C6A').map(x => `${x[6]} ${Number(x[7]).toLocaleString('en-IN')}`).join(', '),
        chapterVIATotal: n(f[22]), taxableIncome: n(f[23]), tax: n(f[24]), rebate87A: n(f[78]), surcharge: n(f[25]),
        cess: n(f[26]), relief89: n(f[27]), netTaxPayable: n(f[28]), tdsThisEmployer: n(f[36]),
        tdsPreviousEmployer: n(f[37]), totalTds: n(f[29]), shortfall: n(f[30]), line: +f[1],
      };
    });
    const short = salary.filter(r => Number(r.shortfall) > 1).length;
    if (short) pointsToReview.push(`${short} employee(s) have a TDS shortfall over Rs 1 - check before filing.`);
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    form, tan: bh[13], deductor: bh[19], fy: `${bh[17].slice(0, 4)}-${bh[17].slice(4)}`, quarter: bh[18],
    prevRrr: bh[9] || '(none - first statement)', software: fh[10],
    totals: { challans: challans.length, deducteeRows: deductees.length, distinctPans: new Set(deductees.map(d => d.pan)).size,
      amountPaid: sum(deductees.map(d => Number(d.amount))), taxDeducted: sum(deductees.map(d => Number(d.tax))),
      taxDeposited: sum(deductees.map(d => Number(d.deposited))), challanTotal: sum(challans.map(c => c.total)),
      batchHeaderTotal: Number(bh[47]) },
    problems, pointsToReview,
    deductorDetails: BH_LABELS.map(([i, label]) => {
      let v = bh[i] ?? '';
      if ((i === 26 || i === 40) && v) v = `${v} - ${STATE[v] ?? '?'}`;
      if (i === 32 && v) v = `${v} - ${DEDUCTOR_TYPE[v] ?? '?'}`;
      return { field: i, label, value: v };
    }),
    challans, deductees, salary,
  };
}
```

## src/core/template_columns.json

```json
{"CHALLAN_COLS": ["Challan #", "BSR code", "Challan serial no.", "Date deposited", "Tax", "Interest", "Fee", "Others", "Minor head"], "DEDUCTEE_COLS": ["Challan #", "PAN", "Name", "Section code", "Date paid / credited", "Amount", "Rate %", "Tax", "Tax deposited (blank = Tax)", "Date deducted", "Reason code (lower/no deduction)", "Certificate no."], "TCS_COLS": ["Non-resident (Y/N)", "Opting out of tax regime (Y/N)", "Collectee code (01-10)", "Permanent establishment (Y/N, non-residents)"], "DEDUCTOR_FIELDS": [["TAN", "tan"], ["PAN", "pan"], ["Name", "name"], ["Address 1 (flat/plot)", "address1"], ["Address 2 (building)", "address2"], ["Address 3 (road)", "address3"], ["Address 4 (area)", "address4"], ["Town / city", "town"], ["State code (2 digits, e.g. 12 Haryana)", "state_code"], ["PIN", "pin"], ["Email", "email"], ["STD code", "std_code"], ["Phone", "phone"], ["Deductor type (F firm, K company, P individual ...)", "deductor_type"], ["Responsible person - name", "rp_name"], ["Responsible person - designation", "rp_designation"], ["Responsible person - PAN", "rp_pan"], ["RP address 1", "rp_address1"], ["RP address 2", "rp_address2"], ["RP address 3", "rp_address3"], ["RP address 4", "rp_address4"], ["RP town / city", "rp_town"], ["RP state code", "rp_state_code"], ["RP PIN", "rp_pin"], ["RP email", "rp_email"], ["RP STD code", "rp_std_code"], ["RP phone", "rp_phone"], ["GSTN (optional)", "gstn"]], "SALARY_COLS": [["PAN", "pan"], ["Name", "name"], ["Category (G/W/S/O)", "category"], ["Regime (Old/New)", "regime"], ["Employed from", "employed_from"], ["Employed to", "employed_to"], ["Salary 17(1)", "salary_17_1"], ["Perquisites 17(2)", "perquisites_17_2"], ["Profits in lieu 17(3)", "profits_17_3"], ["Previous employer salary", "previous_employer_salary"], ["Travel concession 10(5)", "travel_concession"], ["Gratuity 10(10)", "gratuity"], ["Commuted pension 10(10A)", "commuted_pension"], ["Leave encashment 10(10AA)", "leave_encashment"], ["HRA exemption 10(13A)", "hra_exemption"], ["Other s.10 exemption", "other_exemption"], ["Allowances 10(14)", "allowances_10_14"], ["Standard deduction 16(ia)", "standard_deduction"], ["Entertainment allowance 16(ii)", "entertainment_16ii"], ["Professional tax 16(iii)", "professional_tax_16iii"], ["House property income (+) / loss (-)", "house_property"], ["Other income offered", "other_income"], ["80C gross", "via:80C:gross"], ["80C deductible", "via:80C:deductible"], ["80CCC gross", "via:80CCC:gross"], ["80CCC deductible", "via:80CCC:deductible"], ["80CCD(1) gross", "via:80CCD(1):gross"], ["80CCD(1) deductible", "via:80CCD(1):deductible"], ["80CCD(1B) gross", "via:80CCD(1B):gross"], ["80CCD(1B) deductible", "via:80CCD(1B):deductible"], ["80CCD(2) gross", "via:80CCD(2):gross"], ["80CCD(2) deductible", "via:80CCD(2):deductible"], ["80D gross", "via:80D:gross"], ["80D deductible", "via:80D:deductible"], ["80E gross", "via:80E:gross"], ["80E deductible", "via:80E:deductible"], ["80G gross", "via:80G:gross"], ["80G qualifying", "via:80G:qualifying"], ["80G deductible", "via:80G:deductible"], ["80TTA gross", "via:80TTA:gross"], ["80TTA qualifying", "via:80TTA:qualifying"], ["80TTA deductible", "via:80TTA:deductible"], ["80CCH gross", "via:80CCH:gross"], ["80CCH deductible", "via:80CCH:deductible"], ["80CCH(1) gross", "via:80CCH(1):gross"], ["80CCH(1) deductible", "via:80CCH(1):deductible"], ["OTHERS gross", "via:OTHERS:gross"], ["OTHERS qualifying", "via:OTHERS:qualifying"], ["OTHERS deductible", "via:OTHERS:deductible"], ["Taxable income (blank = computed)", "taxable_income"], ["Tax on total income", "tax"], ["Rebate 87A", "rebate_87a"], ["Surcharge", "surcharge"], ["Health & education cess", "cess"], ["Relief 89", "relief_89"], ["TDS by this employer", "tds_current"], ["TDS by previous employer", "tds_previous"], ["TDS/TCS u/s 192(2B)", "tds_192_2b"], ["Higher rate for no PAN (Y/N)", "higher_rate"], ["Rent over 1 lakh (Y/N)", "rent_over_1lakh"], ["Landlord PANs (comma separated)", "landlord_pans"], ["Landlord names (comma separated)", "landlord_names"], ["Interest to lender (Y/N)", "interest_to_lender"], ["Lender PANs (comma separated)", "lender_pans"], ["Lender names (comma separated)", "lender_names"]], "SALARY_SHEET": "Salary (Q4)"}
```
