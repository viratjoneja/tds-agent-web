/**
 * Phase 2 — work out the 4-digit section code from the section as written in the working
 * ("194C", "94C", "Contract", "393(1)-6(i).D(a)", "194J(b)", "Salary 92B", "Scrap" ...).
 *
 * Rules only, no AI. Every result carries the reason. When the rules cannot decide (or the
 * section belongs in another form) the row is NOT guessed: it is returned as 'choose' with the
 * possible codes, or 'error'. A rate that does not fit the code is reported, never changed
 * (SOP rule 11: report under the section the tax was deposited in).
 *
 * The section map (sectionMap.json) gives code descriptions, rates and forms. Its "old section"
 * labels have errors, so the old-section rules below are written out here instead.
 * New module — does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import MAP from './sectionMap.json' with { type: 'json' };
import { makeTemplate } from './inputWorkbook.ts';
import type { Form } from './protean.ts';

export interface CodeInfo { ref: string; category: string; nature: string; rate: string; forms: string[] }
export const SECTION_MAP = MAP as Record<string, CodeInfo>;
export const SECTION_TEXT_COLUMN = 'Section (as in working)';

export interface SectionInput {
  text: string;                 // section as written in the working
  pan?: string;                 // payee PAN (company / non-company decides some codes)
  rate?: number | null;         // rate % from the working, if any
  form: Form;
  deductorType?: string;        // BH 32: A central govt, S state govt ... (salary codes)
}
export interface SectionResult {
  status: 'given' | 'auto' | 'choose' | 'error';
  code: string;                 // '' unless given/auto
  reason: string;
  options: { code: string; label: string }[];   // for 'choose'
  rateNote: string;             // '' or a note that the rate does not fit the code
}

const label = (c: string) => `${c} - ${SECTION_MAP[c]?.ref ?? ''} ${SECTION_MAP[c]?.nature ?? ''}`.trim();
const inForm = (c: string, form: Form) => (SECTION_MAP[c]?.forms ?? []).includes(form);
const pan4 = (pan?: string) => (pan && /^[A-Z]{5}\d{4}[A-Z]$/.test(pan.toUpperCase()) ? pan.toUpperCase()[3] : '');

function rateNote(code: string, rate?: number | null): string {
  const m = SECTION_MAP[code]?.rate.match(/^([\d.]+)%$/);
  if (!m || rate === null || rate === undefined || Number.isNaN(rate) || rate === 0) return '';
  return Math.abs(Number(m[1]) - rate) > 0.001
    ? `Rate ${rate}% in the working; the usual rate for ${code} is ${m[0]}. Check - if tax was deposited under ${code}, keep ${code} (SOP rule 11) and note the difference.`
    : '';
}

function finish(code: string, reason: string, i: SectionInput, status: 'given' | 'auto' = 'auto'): SectionResult {
  if (!SECTION_MAP[code]) return { status: 'error', code: '', reason: `Code ${code} is not in the section map`, options: [], rateNote: '' };
  if (!inForm(code, i.form)) {
    const forms = SECTION_MAP[code].forms.map(f => `Form ${f}`).join(' / ');
    return { status: 'error', code: '', options: [], rateNote: '',
      reason: `${label(code)} is reported in ${forms}, not Form ${i.form}${['141', '144'].some(f => SECTION_MAP[code].forms.includes(f)) && !SECTION_MAP[code].forms.some(f => ['138', '140', '143'].includes(f)) ? ' (that form is not supported by this tool)' : ''}.` };
  }
  return { status, code, reason, options: [], rateNote: rateNote(code, i.rate) };
}
function choose(codes: string[], reason: string, i: SectionInput): SectionResult {
  const ok = codes.filter(c => inForm(c, i.form));
  if (ok.length === 1) return finish(ok[0], `${reason} - only ${ok[0]} applies in Form ${i.form}`, i);
  if (!ok.length) return { status: 'error', code: '', reason: `${reason} - none of ${codes.join(', ')} belongs in Form ${i.form}`, options: [], rateNote: '' };
  return { status: 'choose', code: '', reason, options: ok.map(c => ({ code: c, label: label(c) })), rateNote: '' };
}
const err = (reason: string): SectionResult => ({ status: 'error', code: '', reason, options: [], rateNote: '' });

// ---------------------------------------------------------------- the rules
function contract(i: SectionInput, why: string): SectionResult {
  const p = pan4(i.pan);
  // The working's own label says which 194C section the tax went under (SOP rule 11): it decides,
  // and a PAN that says otherwise is noted, not "corrected".
  const t = (i.text ?? '').toUpperCase();
  const saysInd = /IND(IVIDUAL|IVIUAL|\.)?\s*(\/|OR|&)\s*HUF|IND\/HUF/.test(t) && !/OTHER THAN/.test(t);
  const saysOther = /OTHER(S)?\s+THAN\s+IND|CONTRACT\s+OTHERS?\b/.test(t);
  if (saysInd || saysOther) {
    const code = saysInd ? '1023' : '1024';
    const r = finish(code, `${why}; the working says ${saysInd ? 'individual/HUF' : 'other than individual/HUF'}`, i);
    const panInd = p === 'P' || p === 'H';
    if (p && panInd !== saysInd) r.rateNote = [r.rateNote, `Payee PAN 4th letter ${p} suggests ${panInd ? '1023' : '1024'}; kept ${code} as in the working (SOP rule 11) - check.`].filter(Boolean).join(' ');
    return r;
  }
  if (p === 'P' || p === 'H') return finish('1023', `${why}; payee PAN is an individual/HUF (4th letter ${p})`, i);
  if (p) return finish('1024', `${why}; payee PAN is not an individual/HUF (4th letter ${p})`, i);
  return choose(['1023', '1024'], `${why}; no valid PAN, so individual/HUF or not cannot be told`, i);
}
function salary(i: SectionInput, why: string): SectionResult {
  if (i.deductorType === 'A') return finish('1003', `${why}; deductor is the Central Government`, i);
  if (i.deductorType === 'S') return finish('1001', `${why}; deductor is a State Government`, i);
  if (i.deductorType) return finish('1002', `${why}; deductor type ${i.deductorType} (not government) - private employee`, i);
  return choose(['1001', '1002', '1003'], `${why}; deductor type not known`, i);
}
function fees(i: SectionInput, t: string, why: string): SectionResult {
  if (/DIRECTOR/.test(t)) return finish('1028', `${why}; director remuneration`, i);
  if (/TECHNICAL|ROYALTY|CALL CENT|FILM/.test(t)) return finish('1026', `${why}; technical services / royalty`, i);
  if (/\bPROF(ESSION|F\b|\.|\b)|LEGAL|AUDIT|ADVOCATE|DOCTOR|ARCHITECT/.test(t)) return finish('1027', `${why}; professional services`, i);
  if (i.rate === 2) return finish('1026', `${why}; rate 2% = technical services`, i);
  if (i.rate === 10) return finish('1027', `${why}; rate 10% = professional services (not director)`, i);
  return choose(['1026', '1027', '1028'], `${why}; technical / professional / director cannot be told from the working`, i);
}
function rent(i: SectionInput, t: string, why: string): SectionResult {
  if (/OTHER THAN (PLANT|MACHIN)/.test(t)) return finish('1009', `${why}; other than plant & machinery`, i);
  if (/PLANT|MACHIN|EQUIPMENT|VEHICLE|P\s*&\s*M\b/.test(t)) return finish('1008', `${why}; plant / machinery / equipment`, i);
  if (/BUILDING|BLDG|LAND|FURNITURE|OFFICE|PREMISES|GODOWN|WAREHOUSE|FLAT|SHOP/.test(t)) return finish('1009', `${why}; land / building / furniture`, i);
  if (i.rate === 2) return finish('1008', `${why}; rate 2% = plant & machinery`, i);
  if (i.rate === 10) return finish('1009', `${why}; rate 10% = land / building / furniture`, i);
  return choose(['1008', '1009'], `${why}; plant & machinery or building cannot be told`, i);
}
function cashKind(i: SectionInput, t: string, cash: string, kind: string, why: string): SectionResult {
  if (/KIND/.test(t)) return finish(kind, `${why}; in kind`, i);
  if (/CASH/.test(t)) return finish(cash, `${why}; in cash`, i);
  return choose([cash, kind], `${why}; cash or kind not stated`, i);
}
function tcs(i: SectionInput, t: string, why: string): SectionResult | null {
  const kw: [RegExp, string, string][] = [
    [/SCRAP/, '1073', 'sale of scrap'], [/LIQUOR|ALCOHOL/, '1068', 'alcoholic liquor'], [/TENDU/, '1069', 'tendu leaves'],
    [/TIMBER.*OTHER|OTHER.*TIMBER/, '1071', 'timber (other than forest lease)'], [/TIMBER/, '1070', 'timber under forest lease'],
    [/FOREST/, '1072', 'other forest produce'], [/MINERAL|COAL|LIGNITE|IRON ORE/, '1074', 'minerals'],
    [/MOTOR|VEHICLE|CAR\b/, '1075', 'motor vehicle'], [/WRIST|WATCH/, '1076', 'wristwatch'], [/ART/, '1077', 'art piece'],
    [/COIN|STAMP/, '1078', 'coin / stamp'], [/YACHT|BOAT|HELICOPTER/, '1079', 'yacht / boat / helicopter'],
    [/SUNGLASS/, '1080', 'sunglasses'], [/HANDBAG|PURSE/, '1081', 'handbag / purse'], [/SHOE/, '1082', 'shoes'],
    [/SPORT/, '1083', 'sportswear / equipment'], [/THEATRE|THEATER/, '1084', 'home theatre'], [/HORSE/, '1085', 'horse'],
    [/EDUCATION|MEDICAL/, '1086', 'LRS education / medical'], [/LRS|REMITTANCE/, '1087', 'LRS other purposes'],
    [/PARKING/, '1090', 'parking lot'], [/TOLL/, '1091', 'toll plaza'], [/MINE|QUARRY/, '1092', 'mine / quarry'],
  ];
  for (const [re, code, what] of kw) if (re.test(t)) return finish(code, `${why}; ${what}`, i);
  if (/TOUR/.test(t)) return choose(['1088', '1089'], `${why}; overseas tour package - up to or above the threshold?`, i);
  return null;
}

export function resolveSection(i: SectionInput): SectionResult {
  const raw = (i.text ?? '').toString();
  const t = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return err('No section given in the working');

  // 1. a 4-digit code already
  const four = t.match(/(?:^|[^\d])(1\d{3})(?:[^\d]|$)/);
  if (four && SECTION_MAP[four[1]]) return finish(four[1], `code ${four[1]} given in the working`, i, 'given');

  // 2. ITA 2025 reference, e.g. 393(1)-6(i).D(a), 394(1)-4, 392 - alone, or inside a label
  //    such as "Rent Bldg 393(1)-2(ii).D(b)" or "Contract Ind/HUF 393(1)-6(i).D(a)"
  const embedded = t.match(/39[234]\s*\(\s*\d\s*\)\s*-\s*\d+(\s*\(\s*[IVX]+\s*\))?(\s*\.\s*D\s*\(\s*[AB]\s*\))?/);
  const ref = (embedded && embedded[0] !== t ? embedded[0] : t).replace(/\s+/g, '').replace(/^(\d{3})\(1\)-(\d+)$/, '$1-$2');
  const exact = Object.entries(SECTION_MAP).filter(([, v]) => v.ref.toUpperCase() === ref).map(([c]) => c);
  const altRef = ref.replace(/^394\(1\)-/, '394-');
  const exact2 = exact.length ? exact : Object.entries(SECTION_MAP).filter(([, v]) => v.ref.toUpperCase() === altRef).map(([c]) => c);
  if (/^39[234]/.test(ref)) {
    const pref = Object.entries(SECTION_MAP).filter(([, v]) => v.ref.toUpperCase().startsWith(ref)).map(([c]) => c);
    const cands = exact2.length ? exact2 : pref;
    const inF = cands.filter(c => inForm(c, i.form));
    if (inF.length === 1) return finish(inF[0], `ITA 2025 reference ${raw.trim()}`, i);
    if (inF.every(c => ['1023', '1024'].includes(c)) && inF.length) return contract(i, `ITA 2025 reference ${raw.trim()} (contract)`);
    if (inF.every(c => ['1026', '1027', '1028'].includes(c)) && inF.length) return fees(i, t, `ITA 2025 reference ${raw.trim()} (fees)`);
    if (inF.every(c => ['1001', '1002', '1003'].includes(c)) && inF.length) return salary(i, `ITA 2025 reference ${raw.trim()} (salary)`);
    if (inF.every(c => ['1008', '1009'].includes(c)) && inF.length) return rent(i, t, `ITA 2025 reference ${raw.trim()} (rent)`);
    if (inF.length > 1) return choose(inF, `ITA 2025 reference ${raw.trim()} covers several codes`, i);
    if (cands.length) return choose(cands, `ITA 2025 reference ${raw.trim()}`, i);
  }

  // 3. old (ITA 1961) section, written loosely and anywhere in the text: "194 C", "94C", "194-J(b)",
  //    "Sec. 194Q", "CONTT. 194 C", "PROFF. 194 J", "SALARY 92B", "206C(1) scrap"
  let s = '';
  const tt = t.replace(/\b(SECTION|SEC|US|U\/S)(?=\d)/g, '$1 ');            // "Section194P" -> "Section 194P"
  const tcsHit = tt.match(/(?:^|[^0-9])206\s*-?\s*C\s*(\(\s*[0-9A-Z]{1,3}\s*\))?/);
  const secHit = tt.match(/(?:^|[^0-9A-Z])(1?9[2-6])(?![0-9])\s*-?\s*([A-Z]{1,3})?\s*(\(\s*[A-Z0-9]{1,3}\s*\))?/);
  if (tcsHit) s = `206C${(tcsHit[1] ?? '').replace(/\s+/g, '')}`;
  else if (secHit) s = `${secHit[1].length === 2 ? '1' + secHit[1] : secHit[1]}${secHit[2] ?? ''}${(secHit[3] ?? '').replace(/\s+/g, '')}`;
  const why = `section ${raw.trim()}`;
  if (/^192A/.test(s)) return finish('1004', `${why}: PF withdrawal`, i);
  if (/^192/.test(s)) return salary(i, `${why}: salary`);
  if (/^193/.test(s)) return finish('1019', `${why}: interest on securities`, i);
  if (/^194A/.test(s)) return /BANK|POST|CO-?OP/.test(t) ? choose(['1020', '1021'], `${why}: interest by a bank / post office / co-op - senior citizen or not?`, i)
    : finish('1022', `${why}: interest other than by banks`, i);
  if (/^194BB/.test(s)) return finish('1062', `${why}: horse race winnings`, i);
  if (/^194BA/.test(s)) return cashKind(i, t, '1060', '1061', `${why}: online gaming`);
  if (/^194B/.test(s)) return cashKind(i, t, '1058', '1059', `${why}: lottery / puzzle / game`);
  if (/^194C/.test(s)) return contract(i, `${why}: contract`);
  if (/^194DA/.test(s)) return finish('1030', `${why}: life insurance payout`, i);
  if (/^194D/.test(s)) return finish('1005', `${why}: insurance commission`, i);
  if (/^194EE/.test(s)) return finish('1066', `${why}: NSS withdrawal`, i);
  if (/^194E/.test(s)) return finish('1039', `${why}: non-resident sportsperson`, i);
  if (/^194G/.test(s)) return finish('1063', `${why}: commission on lottery tickets`, i);
  if (/^194H/.test(s)) return finish('1006', `${why}: commission / brokerage`, i);
  if (/^194IA/.test(s)) return finish('1010', `${why}: transfer of immovable property`, i);
  if (/^194IB/.test(s)) return finish('1007', `${why}: rent by individual / HUF`, i);
  if (/^194IC/.test(s)) return finish('1012', `${why}: compensation (joint development)`, i);
  if (/^194I\(A\)/.test(s)) return finish('1008', `${why}: rent of plant & machinery`, i);
  if (/^194I\(B\)/.test(s)) return finish('1009', `${why}: rent of land / building / furniture`, i);
  if (/^194I/.test(s)) return rent(i, t, `${why}: rent`);
  if (/^194J(A|\(A\))/.test(s)) return finish('1026', `${why}: technical services / royalty`, i);
  if (/^194J(B|\(B\))/.test(s)) return /DIRECTOR/.test(t) ? finish('1028', `${why}: director remuneration`, i) : finish('1027', `${why}: professional services`, i);
  if (/^194J/.test(s)) return fees(i, t, `${why}: fees`);
  if (/^194K/.test(s)) return finish('1013', `${why}: mutual fund units`, i);
  if (/^194LBC/.test(s)) return finish('1018', `${why}: securitisation trust`, i);
  if (/^194LBA/.test(s)) return choose(['1014', '1015', '1016', '1017'], `${why}: business trust - interest / dividend / rent / REIT?`, i);
  if (/^194M/.test(s)) return finish('1025', `${why}: payments by individuals / HUF`, i);
  if (/^194N/.test(s)) return /CO-?OP/.test(t) ? finish('1064', `${why}: cash withdrawal (co-operative society)`, i) : choose(['1064', '1065'], `${why}: cash withdrawal - co-operative society or not?`, i);
  if (/^194O/.test(s)) return finish('1035', `${why}: e-commerce operator`, i);
  if (/^194P/.test(s)) return err(`${why}: specified senior citizen (Annexure III of Form 138) is not supported by this tool`);
  if (/^194Q/.test(s)) return finish('1031', `${why}: purchase of goods`, i);
  if (/^194R/.test(s)) return cashKind(i, t, '1033', '1034', `${why}: business perquisite`);
  if (/^194S/.test(s)) return /KIND/.test(t) ? finish('1038', `${why}: virtual digital asset (kind)`, i) : finish('1037', `${why}: virtual digital asset`, i);
  if (/^194T/.test(s)) return finish('1067', `${why}: payment to partner`, i);
  if (/^194($|[^0-9A-Z])/.test(s) || /^194DIV/.test(s)) return finish('1029', `${why}: dividend`, i);
  if (/^195|^196/.test(s)) return err(`${why}: non-resident payments go in Form 144, which this tool does not support`);
  if (/^206C\(?1H/.test(s)) return err(`${why}: TCS on sale of goods (206C(1H)) no longer applies from 1 April 2025 - check the working`);
  if (/^206C/.test(s)) return tcs(i, t, `${why}: TCS`) ?? choose(Object.keys(SECTION_MAP).filter(c => inForm(c, '143')), `${why}: TCS - nature of the goods / receipt not stated`, i);

  // 4. words only (partner first: "Partner salary" is 194T, not salary)
  if (/PARTNER/.test(t)) return finish('1067', `"${raw.trim()}": payment to partner`, i);
  if (/SALAR/.test(t)) return salary(i, `"${raw.trim()}": salary`);
  if (/CONTRACT|\bCONTT\b|JOB ?WORK|TRANSPORT|LABOU?R|CARRIAGE|FREIGHT/.test(t)) return contract(i, `"${raw.trim()}": contract`);
  if (/DIRECTOR|\bPROF(ESSION|F\b|\.|\b)|TECHNICAL|ROYALTY|LEGAL|AUDIT|CONSULT/.test(t)) return fees(i, t, `"${raw.trim()}": fees`);
  if (/COMMISSION|BROKERAGE/.test(t)) return finish('1006', `"${raw.trim()}": commission / brokerage`, i);
  if (/RENT|HIRE|LEASE/.test(t)) return rent(i, t, `"${raw.trim()}": rent`);
  if (/PURCHASE|GOODS/.test(t)) return finish('1031', `"${raw.trim()}": purchase of goods`, i);
  if (/PARTNER/.test(t)) return finish('1067', `"${raw.trim()}": payment to partner`, i);
  if (/INTEREST/.test(t)) return finish('1022', `"${raw.trim()}": interest (not by a bank)`, i);
  if (i.form === '143') { const r = tcs(i, t, `"${raw.trim()}"`); if (r) return r; }
  return err(`"${raw.trim()}" not recognised - choose the code from the section map`);
}

// ---------------------------------------------------------------- workbook helpers
/** Blank input workbook with an extra "Section (as in working)" column on Deductees. */
export function makeTemplateWithSection(form: Form): Uint8Array {
  const wb = XLSX.read(makeTemplate(form), { type: 'array' });
  const ws = wb.Sheets['Deductees'];
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[];
  const at = hdr.indexOf('Section code');
  hdr.splice(at + 1, 0, SECTION_TEXT_COLUMN);
  wb.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet([hdr]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

export interface RowSuggestion { row: number; pan: string; name: string; text: string; rate: number | null; result: SectionResult }

/** One suggestion per Deductees row: rows that already have a 4-digit code are checked against the form. */
export function suggestSections(data: ArrayBuffer | Uint8Array, form: Form, deductorType?: string): RowSuggestion[] {
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets['Deductees'];
  if (!ws) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const hdr = ((grid[0] ?? []) as unknown[]).map(v => String(v ?? '').trim());
  const col = (h: string) => hdr.indexOf(h);
  const [cCode, cText, cPan, cName, cRate] = [col('Section code'), col(SECTION_TEXT_COLUMN), col('PAN'), col('Name'), col('Rate %')];
  const out: RowSuggestion[] = [];
  grid.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    const code = String(r[cCode] ?? '').trim(), text = cText >= 0 ? String(r[cText] ?? '').trim() : '';
    const rateRaw = cRate >= 0 ? r[cRate] : null;
    const rate = rateRaw === null || rateRaw === '' ? null : Number(rateRaw);
    const pan = String(r[cPan] ?? '').trim().toUpperCase();
    out.push({ row: k + 2, pan, name: String(r[cName] ?? '').trim(), text: code || text, rate,
      result: resolveSection({ text: code || text, pan, rate, form, deductorType }) });
  });
  return out;
}

/** Write the chosen codes into the "Section code" column; returns new workbook bytes for the core reader. */
export function applySections(data: ArrayBuffer | Uint8Array, choices: { row: number; code: string }[]): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Deductees'];
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[];
  const c = hdr.indexOf('Section code');
  for (const { row, code } of choices) {
    if (!/^\d{4}$/.test(code)) throw new Error(`Row ${row}: "${code}" is not a 4-digit section code`);
    ws[XLSX.utils.encode_cell({ r: row - 1, c })] = { t: 's', v: code };
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
