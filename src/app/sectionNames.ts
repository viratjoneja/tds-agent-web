import { SECTION_MAP } from '../sectionCodes.ts';

/** Short description of a section for the screen: salary sections as "Salary - ...", others by nature. */
const short = (code: string) => {
  const s = SECTION_MAP[code];
  if (!s) return '';
  if (s.category === 'TDS on Salary') return `Salary - ${s.nature.toLowerCase()}`;
  return /^other\b/i.test(s.nature) ? `${s.category} - ${s.nature.toLowerCase()}` : s.nature;
};

/** "392(7) Salary - private employee" for 1002; THIS / OTHER as words; unknown codes as they are. */
export function sectionName(code: string): string {
  if (code === 'THIS') return 'this return';
  if (code === 'OTHER') return 'other returns';
  const s = SECTION_MAP[code];
  return s ? `${s.ref} ${short(code)}` : code;
}

/** Just the section reference ("392(7)"), for narrow places. */
export const sectionRef = (code: string) => (code === 'THIS' ? 'this return' : code === 'OTHER' ? 'other returns' : SECTION_MAP[code]?.ref ?? code);

/** Replace the 4-digit codes the engine writes after "section" in its messages with the section names. */
export function withSectionNames(text: string): string {
  return text.replace(/\bsections? ((?:\d{4}|other returns)(?:, (?:\d{4}|other returns))*)/g, (_m, list: string) =>
    `section ${list.split(', ').map(c => (/^\d{4}$/.test(c) ? sectionName(c) : c)).join(', ')}`);
}

/** All sections, for the split editor's drop-down: this form's first, then salary, then the rest. */
export function sectionChoices(form: string): { code: string; label: string; group: string }[] {
  const all = Object.keys(SECTION_MAP).sort();
  const pick = (f: (c: string) => boolean, group: string) => all.filter(f).map(code => ({ code, label: `${sectionName(code)} (${code})`, group }));
  return [
    ...pick(c => SECTION_MAP[c].forms.includes(form), `Form ${form} - this return`),
    ...pick(c => !SECTION_MAP[c].forms.includes(form) && SECTION_MAP[c].forms.includes('138'), 'Salary - Form 138 (24Q)'),
    ...pick(c => !SECTION_MAP[c].forms.includes(form) && !SECTION_MAP[c].forms.includes('138'), 'Other returns'),
  ];
}
