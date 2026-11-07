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
