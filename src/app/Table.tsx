import { useMemo, useState, type ReactNode } from 'react';
import { inr } from './util.ts';

export interface Col<T> { key: string; label: string; num?: boolean; render?: (r: T) => ReactNode; value?: (r: T) => unknown }

/** Sortable, filterable table with a totals row for number columns. */
export function Table<T extends object>({ rows, cols, rowClass, total = true, filter = true }:
  { rows: T[]; cols: Col<T>[]; rowClass?: (r: T) => string; total?: boolean; filter?: boolean }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [q, setQ] = useState('');
  const val = (r: T, c: Col<T>) => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);
  const shown = useMemo(() => {
    let out = rows;
    if (q.trim()) { const s = q.trim().toLowerCase(); out = out.filter(r => cols.some(c => String(val(r, c) ?? '').toLowerCase().includes(s))); }
    if (sort) {
      const c = cols.find(c => c.key === sort.key)!;
      out = [...out].sort((a, b) => { const x = val(a, c), y = val(b, c); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * sort.dir; });
    }
    return out;
  }, [rows, cols, q, sort]);
  return (
    <div className="table-wrap">
      {filter && rows.length > 8 && <input className="filter" placeholder="Filter rows..." value={q} onChange={e => setQ(e.target.value)} aria-label="Filter rows" />}
      <div className="scroll">
        <table>
          <thead><tr>{cols.map(c => (
            <th key={c.key} className={c.num ? 'num' : ''}>
              <button className="th" onClick={() => setSort(s => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}>
                {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </button>
            </th>))}</tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className={rowClass?.(r) ?? ''}>
                {cols.map(c => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : c.num ? inr(val(r, c)) : String(val(r, c) ?? '')}</td>)}
              </tr>))}
          </tbody>
          {total && shown.length > 1 && cols.some(c => c.num) && (
            <tfoot><tr>{cols.map((c, i) => (
              <td key={c.key} className={c.num ? 'num' : ''}>
                {i === 0 ? `Total (${shown.length})` : c.num ? inr(shown.reduce((a, r) => a + (Number(val(r, c)) || 0), 0)) : ''}
              </td>))}</tr></tfoot>)}
        </table>
      </div>
    </div>
  );
}

/** Columns straight from the keys of plain records (review tables). */
export function autoCols(rows: Record<string, unknown>[]): Col<Record<string, unknown>>[] {
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  return keys.map(k => ({ key: k, label: k, num: rows.some(r => typeof r[k] === 'number') && !/^(line|row|no|#)$/i.test(k) }));
}
