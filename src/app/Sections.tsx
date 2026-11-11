import { useMemo, useState } from 'react';
import { SECTION_MAP, applySections, suggestSections, type RowSuggestion } from '../sectionCodes.ts';
import { download } from './util.ts';
import { Table } from './Table.tsx';
import type { StepProps } from './App.tsx';

const label = (code: string) => (SECTION_MAP[code] ? `${code} - ${SECTION_MAP[code].ref} ${SECTION_MAP[code].nature}` : code);

export function SectionsStep({ s, set, next }: StepProps) {
  const [err, setErr] = useState('');
  const sugg = useMemo<RowSuggestion[]>(() => {
    try { return suggestSections(s.workbook!.bytes, s.form, s.deductor?.deductor_type); }
    catch (e) { setErr((e as Error).message); return []; }
  }, [s.workbook, s.form, s.deductor]);
  const [choice, setChoice] = useState<Record<number, string>>({});
  const codeOf = (r: RowSuggestion) => choice[r.row] ?? r.result.code;
  const open = sugg.filter(r => !/^\d{4}$/.test(codeOf(r)) || !SECTION_MAP[codeOf(r)]);
  const counts = { given: 0, auto: 0, choose: 0, error: 0 } as Record<string, number>;
  for (const r of sugg) counts[r.result.status]++;

  const apply = () => {
    try { set({ withSections: applySections(s.workbook!.bytes, sugg.map(r => ({ row: r.row, code: codeOf(r) }))) }); next(); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <section className="card">
      <h2>3. Section codes</h2>
      <p>Worked out from the section as written in your working. <b>{counts.given}</b> given, <b>{counts.auto}</b> worked out,{' '}
        <b className={counts.choose ? 'warn' : ''}>{counts.choose}</b> need a choice, <b className={counts.error ? 'bad' : ''}>{counts.error}</b> not recognised.</p>
      {err && <p className="bad">{err}</p>}
      <Table rows={sugg} total={false}
        rowClass={r => (open.includes(r) ? 'row-bad' : r.result.status === 'auto' ? '' : '')}
        cols={[
          { key: 'row', label: 'Row' },
          { key: 'name', label: 'Name' },
          { key: 'pan', label: 'PAN' },
          { key: 'text', label: 'Section as written' },
          { key: 'rate', label: 'Rate %', value: r => r.rate ?? '' },
          { key: 'code', label: 'Code', value: r => codeOf(r), render: r =>
            r.result.status === 'choose' ? (
              <select value={codeOf(r)} onChange={e => setChoice(c => ({ ...c, [r.row]: e.target.value }))} aria-label={`Section code for row ${r.row}`}>
                <option value="">-- choose --</option>
                {r.result.options.map(o => <option key={o.code} value={o.code}>{o.code} - {o.label}</option>)}
              </select>
            ) : r.result.status === 'error' ? (
              <input className="code" value={choice[r.row] ?? ''} placeholder="4-digit code" maxLength={4} aria-label={`Section code for row ${r.row}`}
                onChange={e => setChoice(c => ({ ...c, [r.row]: e.target.value.trim() }))} />
            ) : <span title={label(codeOf(r))}>{codeOf(r)}</span> },
          { key: 'why', label: 'Why', value: r => r.result.reason, render: r => (
            <span>{r.result.reason}{r.result.rateNote && <><br /><span className="warn">{r.result.rateNote}</span></>}
              {choice[r.row] && SECTION_MAP[choice[r.row]] && <><br /><small>{label(choice[r.row])}</small></>}</span>) },
        ]} />
      <div className="actions">
        <button className="ghost" disabled={!!open.length} onClick={() => download(applySections(s.workbook!.bytes, sugg.map(r => ({ row: r.row, code: codeOf(r) }))), `with_sections_${s.workbook!.name.replace(/\.xls$/i, '.xlsx')}`)}>
          Download workbook with codes</button>
        <button disabled={!!open.length || !sugg.length} onClick={apply}>{open.length ? `${open.length} row(s) still need a code` : 'Next: challans'}</button>
      </div>
    </section>
  );
}
