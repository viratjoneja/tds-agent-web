import { useMemo, useState } from 'react';
import { applyChallanMatches, approvalOptions, formatBreakup, matchChallans, openGroups, readForMatching, setApproved, setChallanSplit, type ApprovalOption, type ChallanIn, type ChallanUse, type OpenGroup, type RowIn } from '../challanMatch.ts';
import { addChallansToWorkbook, fromGemini, geminiChallanRequest, maskReceiptText, readChallanPdfs, type ChallanReceipt, type ReadResult } from '../challanPdf.ts';
import { applyProposals, checkProposals, geminiExceptionRequest, maskedPayload, type CheckedProposal } from '../aiExceptions.ts';
import { askGemini } from './ai.ts';
import { clearChallans, download, inr, readBytes, reviewWorkbook, typedChallanLinks } from './util.ts';
import { Table } from './Table.tsx';
import { sectionChoices, sectionName, sectionRef, withSectionNames } from './sectionNames.ts';
import type { StepProps } from './App.tsx';
import type { Form } from '../protean.ts';

type PdfRead = { name: string; result: ReadResult; text: string };

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

export function ChallansStep({ s, set, next, ai }: StepProps) {
  const [work, setWorkHere] = useState<Uint8Array>(s.challanWork ?? s.withSections!);
  const setWork = (b: Uint8Array) => { setWorkHere(b); set({ challanWork: b }); };
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [msg, setMsg] = useState<{ cls: string; text: string }[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [undo, setUndo] = useState<Uint8Array[]>([]);
  const opts = useMemo(() => ({ form: s.form }), [s.form]);

  const m = useMemo(() => { try { return readForMatching(work); } catch (e) { return { challans: [], rows: [], problems: [(e as Error).message], warnings: [] }; } }, [work]);
  const rowsIn: RowIn[] = useMemo(() => m.rows.map(r => (overrides[r.row] ? { ...r, challanNo: overrides[r.row] } : r)), [m, overrides]);
  const res = useMemo(() => (m.problems.length ? null : matchChallans(m.challans, rowsIn, opts)), [m, rowsIn, opts]);
  const options = useMemo(() => (res && res.offers.length ? approvalOptions(m.challans, rowsIn, opts) : []), [res, m, rowsIn, opts]);
  const rowById = useMemo(() => new Map(m.rows.map(r => [r.row, r])), [m]);
  const chById = useMemo(() => new Map(m.challans.map(c => [c.no, c])), [m]);
  const useById = useMemo(() => new Map((res?.challans ?? []).map(c => [c.no, c])), [res]);
  const unlinked = res ? res.rows.filter(r => r.challanNo === null).length : 0;
  const blocking = res ? res.exceptions.filter(e => e.kind === 'split-missing' || e.kind === 'over-limit') : [];
  const canApply = !!res && unlinked === 0 && blocking.length === 0;
  const setWorkbook = (b: Uint8Array) => { setWork(b); setOverrides({}); };
  const change = (f: () => Uint8Array, ok?: string) => {
    try { setWork(f()); setMsg(ok ? [{ cls: 'ok', text: ok }] : []); } catch (e) { setMsg([{ cls: 'bad', text: (e as Error).message }]); }
  };
  const allow = (no: number, extra: number) => {
    const c = chById.get(no)!;
    change(() => setApproved(work, no, Math.round(((Number(c.approved) || 0) + extra) * 100) / 100),
      `Allowed Rs ${inr(extra, 0)} of challan #${no}'s ${useById.get(no)?.otherSections.map(sectionName).join(', ')} share for this return (your approval is recorded on the challan).`);
  };
  const setAllowedText = (no: number, text: string) => {
    const t = text.replace(/,/g, '').trim();
    const v = t === '' ? null : Number(t);
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setMsg([{ cls: 'bad', text: `"${text}" is not an amount` }]); return; }
    if ((chById.get(no)?.approved ?? null) === v) return;
    change(() => setApproved(work, no, v));
  };
  const linkedBytes = () => applyChallanMatches(work, res!.rows.filter(r => r.challanNo !== null).map(r => ({ row: r.row, challanNo: r.challanNo! })));
  const apply = () => { set({ linked: linkedBytes() }); next(); };
  const setOffSheet = () => reviewWorkbook({ 'Challan set-off': m.challans.map(c => {
    const u = useById.get(c.no)!;
    return { 'Challan #': c.no, BSR: c.bsr, Serial: c.serial, Date: c.date, 'Major head': c.majorHead, Tax: c.tax,
      'Split by section': c.breakup ? Object.entries(c.breakup).map(([k, v]) => `${sectionName(k)}${/^\d{4}$/.test(k) ? ` (${k})` : ''}: ${v}`).join('; ') : 'MISSING',
      'Split (codes)': c.breakup ? formatBreakup(c.breakup) : '',
      "This return's money": u.pool, "Other returns' sections": u.otherSections.map(k => `${sectionName(k)}${/^\d{4}$/.test(k) ? ` (${k})` : ''}`).join('; '), "Other returns' share": u.otherShare,
      'Allowed by you from other share': u.approved, 'Used by this return': u.usedHere, 'Of which from other share': u.takenFromOther,
      'Left for this return': u.left, 'Left for other returns': Math.round((u.otherShare - u.takenFromOther) * 100) / 100 };
  }) });
  const groups = useMemo(() => (res ? openGroups(m.challans, rowsIn, res) : []), [res, m, rowsIn]);
  const points = res ? res.exceptions.filter(e => e.kind !== 'too-large' && e.kind !== 'no-challan') : [];
  // link rows (written into the workbook's Challan # column) and record any approval of another return's share
  const linkRows = (p: LinkPlan) => {
    try {
      let w = work;
      for (const a of p.approvals) w = setApproved(w, a.no, Math.round(((Number(chById.get(a.no)?.approved) || 0) + a.extra) * 100) / 100);
      w = applyChallanMatches(w, p.links);
      setUndo(u => [...u, work]);
      setOverrides(o => { const n = { ...o }; for (const l of p.links) delete n[l.row]; return n; });
      setWork(w);
      setMsg([{ cls: 'ok', text: `${p.label}${p.approvals.length ? `; allowed ${p.approvals.map(a => `Rs ${inr(a.extra, 0)} on ${chById.get(a.no)?.serial}`).join(', ')} from other returns' share (recorded on the challan)` : ''}.` }]);
    } catch (e) { setMsg([{ cls: 'bad', text: (e as Error).message }]); }
  };
  const undoLast = () => { const prev = undo.at(-1); if (!prev) return; setUndo(u => u.slice(0, -1)); setWork(prev); setMsg([{ cls: 'ok', text: 'Last linking undone.' }]); };

  return (
    <section className="card">
      <h2>4. Challans</h2>
      <Receipts work={work} existing={m.challans.length} setWorkbook={setWorkbook} ai={ai} setMsg={setMsg} />
      {msg.map(x => <p key={x.text} className={x.cls}>{x.text}</p>)}

      {m.problems.length > 0 && (
        <div className="banner error"><b>Fix these in the workbook and upload it again:</b>
          <ul>{m.problems.map(p => <li key={p}>{p}</li>)}</ul></div>)}
      {m.warnings.length > 0 && (
        <details className="banner warn"><summary>{m.warnings.length} row(s) where Tax differs from Amount x Rate % - fine if it is the tax actually deducted</summary>
          <ul>{m.warnings.map(p => <li key={p}>{p}</li>)}</ul></details>)}

      {res && <StatusSummary res={res} challans={m.challans} rows={m.rows} options={options} unlinked={unlinked} canApply={canApply}
        onSplit={setEditing} onAllThis={no => change(() => setChallanSplit(work, no, { THIS: chById.get(no)!.tax }), `Challan #${no}: all of it for this return.`)}
        onAllow={allow} />}

      {res && <>
        <h3>Challans ({m.challans.length}) - how each is set off</h3>
        <Table rows={m.challans} rowClass={c => (useById.get(c.no)?.limitFrom === 'missing' || (useById.get(c.no)?.left ?? 0) < -0.5 ? 'row-bad' : (useById.get(c.no)?.interestDue ?? 0) > c.interest + 1 ? 'row-warn' : '')}
          cols={[
            { key: 'no', label: '#' }, { key: 'serial', label: 'Challan' }, { key: 'date', label: 'Date' }, { key: 'majorHead', label: 'Head' },
            { key: 'tax', label: 'Tax', num: true },
            { key: 'bar', label: 'Set-off', value: c => useById.get(c.no)?.usedHere ?? 0, render: c => <SetOffBar u={useById.get(c.no)!} /> },
            { key: 'split', label: 'Split by section', value: c => (c.breakup ? formatBreakup(c.breakup) : ''), render: c => (
              <span className="split">{c.breakup ? <SplitList b={c.breakup} /> : <b className="bad">missing</b>}
                <button className="link" onClick={() => setEditing(c.no)}>{c.breakup ? 'edit' : 'enter'}</button></span>) },
            { key: 'pool', label: 'This return', num: true, value: c => useById.get(c.no)?.pool ?? 0 },
            { key: 'other', label: 'Other returns', num: true, value: c => useById.get(c.no)?.otherShare ?? 0 },
            { key: 'allowed', label: 'Allowed from other', value: c => c.approved ?? '', render: c => ((useById.get(c.no)?.otherShare ?? 0) > 0.5 || c.approved ? (
              <input className="code" key={`${c.no}-${c.approved ?? ''}`} defaultValue={c.approved ?? ''} inputMode="decimal" placeholder="0"
                aria-label={`Allowed from other returns' share, challan ${c.no}`}
                onBlur={e => setAllowedText(c.no, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />) : '') },
            { key: 'used', label: 'Used here', num: true, value: c => useById.get(c.no)?.usedHere ?? 0 },
            { key: 'left', label: 'Left', num: true, value: c => useById.get(c.no)?.left ?? 0 },
            { key: 'idue', label: 'Interest due / paid', value: c => useById.get(c.no)?.interestDue ?? 0, render: c => <small>{inr(useById.get(c.no)?.interestDue ?? 0, 0)} / {inr(c.interest, 0)}</small> },
            { key: 'notes', label: 'Notes', wrap: true, value: c => withSectionNames((useById.get(c.no)?.notes ?? []).join('; ')) },
          ]} />

        {points.length > 0 && <>
          <details className="points" open={points.length <= 3}>
            <summary><h3>Points needing a decision ({points.length})</h3></summary>
            <div className="cards">{points.map((e, i) => <div key={i} className={`point ${e.kind}`}><b>{e.kind.replace('-', ' ')}</b> {withSectionNames(e.message)}</div>)}</div>
          </details>
        </>}

        {unlinked > 0 && <OpenRows groups={groups} rowById={rowById} chById={chById} useById={useById} challans={m.challans}
          onLink={linkRows} canUndo={undo.length > 0} onUndo={undoLast} />}
        {ai && unlinked > 0 && <AiProposals challans={m.challans} rows={rowsIn} res={res} form={s.form} onApply={links => setOverrides(o => ({ ...o, ...links }))} />}

        <h3>Deductee rows ({res.rows.length}) {unlinked > 0 ? <span className="bad">- {unlinked} need a challan</span> : <span className="ok">- all linked</span>}
          {' '}<button className="link" onClick={() => setShowAll(v => !v)}>{showAll ? 'hide the full list' : `show all ${res.rows.length} rows`}</button>
          {unlinked === 0 && undo.length > 0 && <>{' '}<button className="link" onClick={undoLast}>undo the last linking</button></>}</h3>
        {showAll && <Table rows={res.rows} total={false}
          rowClass={r => (r.status === 'exception' ? (r.challanNo ? 'row-warn' : 'row-bad') : '')}
          cols={[
            { key: 'row', label: 'Row' },
            { key: 'name', label: 'Name', value: r => rowById.get(r.row)?.name },
            { key: 'pan', label: 'PAN', value: r => rowById.get(r.row)?.pan },
            { key: 'code', label: 'Section', value: r => sectionRef(rowById.get(r.row)?.code ?? ''), render: r => <span title={`${sectionName(rowById.get(r.row)?.code ?? '')} (code ${rowById.get(r.row)?.code})`}>{sectionRef(rowById.get(r.row)?.code ?? '')}</span> },
            { key: 'date', label: 'Deducted', value: r => rowById.get(r.row)?.dateDeducted },
            { key: 'tax', label: 'Tax', num: true, value: r => rowById.get(r.row)?.tax },
            { key: 'challan', label: 'Challan', value: r => r.challanNo ?? '', render: r => (
              r.status === 'exception' || overrides[r.row] ? (
                <select value={r.challanNo ?? ''} aria-label={`Challan for row ${r.row}`}
                  onChange={e => setOverrides(o => { const n = { ...o }; if (e.target.value) n[r.row] = Number(e.target.value); else delete n[r.row]; return n; })}>
                  <option value="">-- choose --</option>
                  {m.challans.map(c => <option key={c.no} value={c.no}>#{c.no} {c.serial} {c.date} (left for this return {inr(useById.get(c.no)?.left ?? 0, 0)})</option>)}
                </select>) : <>#{r.challanNo} {chById.get(r.challanNo!)?.serial} {chById.get(r.challanNo!)?.date}</>) },
            { key: 'reason', label: 'Why', wrap: true, render: r => <small>{withSectionNames(r.reason)}</small> },
          ]} />}
      </>}

      {editing !== null && chById.get(editing) && (
        <SplitEditor challan={chById.get(editing)!} form={s.form} codesHere={[...new Set(m.rows.map(r => r.code))].sort()}
          onCancel={() => setEditing(null)}
          onSave={split => { try { setWork(setChallanSplit(work, editing, split)); setMsg([{ cls: 'ok', text: `Challan #${editing}: split saved.` }]); setEditing(null); } catch (e) { return (e as Error).message; } return null; }} />)}

      <div className="actions">
        {res && <button className="ghost" onClick={() => download(setOffSheet(), `challan_setoff_${s.form}_Q${s.quarter}.xlsx`)}>Download challan set-off (balance left for other returns)</button>}
        <button className="ghost" disabled={!canApply} onClick={() => download(linkedBytes(), `linked_${s.workbook!.name.replace(/\.xls$/i, '.xlsx')}`)}>Download workbook with challan links</button>
        <button disabled={!canApply} onClick={apply}>{unlinked ? `${unlinked} row(s) still need a challan` : blocking.length ? 'Settle the challans first' : 'Apply challan links and build the return'}</button>
      </div>
    </section>
  );
}

/** A challan's split, one section per line: section reference and description, amount; the code on hover. */
function SplitList({ b }: { b: Record<string, number> }) {
  return <ul className="split-list">{Object.entries(b).map(([k, v]) => (
    <li key={k} title={/^\d{4}$/.test(k) ? `code ${k}` : ''}><span>{sectionName(k)}</span> <b>{inr(v, 0)}</b></li>))}</ul>;
}

/** Bar: other returns' share kept | used by this return | left for this return. */
function SetOffBar({ u }: { u: ChallanUse }) {
  if (!u) return null;
  if (u.limitFrom === 'missing') return <small className="bad">split missing</small>;
  const kept = Math.max(0, u.otherShare - u.takenFromOther), used = Math.max(0, u.usedHere), left = Math.max(0, u.left);
  const total = kept + used + left || 1;
  const pc = (x: number) => `${(100 * x) / total}%`;
  return (
    <span className="setoff" title={`Other returns Rs ${inr(kept, 0)} · this return Rs ${inr(used, 0)}${u.takenFromOther > 0 ? ` (Rs ${inr(u.takenFromOther, 0)} from the other share, approved)` : ''} · left Rs ${inr(left, 0)}`}>
      <span className="bar"><i className="kept" style={{ width: pc(kept) }} /><i className="used" style={{ width: pc(used) }} /><i className="left" style={{ width: pc(left) }} /></span>
      <small>{kept > 0.5 ? `other ${inr(kept, 0)} · ` : ''}this {inr(used, 0)}{left > 0.5 ? ` · left ${inr(left, 0)}` : ''}</small>
    </span>);
}

/** Enter how a challan was paid: section by section, adding up to the challan's tax. */
function SplitEditor({ challan, form, codesHere, onCancel, onSave }:
  { challan: ChallanIn; form: string; codesHere: string[]; onCancel: () => void; onSave: (b: Record<string, number>) => string | null }) {
  const start = challan.breakup ? Object.entries(challan.breakup).map(([code, v]) => ({ code, amount: String(v) })) : [{ code: codesHere[0] ?? '', amount: '' }];
  const [lines, setLines] = useState(start);
  const groups = useMemo(() => { const m = new Map<string, ReturnType<typeof sectionChoices>>(); for (const x of sectionChoices(form)) m.set(x.group, [...(m.get(x.group) ?? []), x]); return [...m.entries()]; }, [form]);
  const [err, setErr] = useState('');
  const sum = lines.reduce((a, l) => a + (Number(l.amount.replace(/,/g, '')) || 0), 0);
  const diff = Math.round((challan.tax - sum) * 100) / 100;
  const save = () => {
    const out: Record<string, number> = {};
    for (const l of lines) {
      const code = l.code.trim().toUpperCase(), amt = Number(l.amount.replace(/,/g, ''));
      if (!code && !l.amount.trim()) continue;
      if (!/^\d{4}$|^THIS$|^OTHER$/.test(code)) { setErr(`Line ${lines.indexOf(l) + 1}: choose the section`); return; }
      if (!(amt >= 0)) { setErr(`Amount for ${sectionName(code)} is not a number`); return; }
      out[code] = (out[code] ?? 0) + amt;
    }
    setErr(onSave(out) ?? '');
  };
  return (
    <div className="modal" role="dialog" aria-label={`Split of challan ${challan.no}`}>
      <div className="modal-box">
        <h3>How was challan #{challan.no} ({challan.serial}, {challan.date}, Rs {inr(challan.tax, 0)}) paid?</h3>
        <p className="muted">Take it from the challan receipt or the payment working. Sections of Form {form} are this return's money; other sections (e.g. 1002 salary) are kept for those returns.</p>
        <div className="actions left">
          <button className="ghost" onClick={() => setLines([{ code: 'THIS', amount: String(challan.tax) }])}>All for this return</button>
          <button className="ghost" onClick={() => setLines([{ code: '1002', amount: '' }, ...codesHere.map(code => ({ code, amount: '' }))])}>Salary + this return's sections</button>
        </div>
        <table className="split-lines"><thead><tr><th>Section</th><th className="num">Amount (Rs)</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><select value={l.code} aria-label={`Section, line ${i + 1}`}
                onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}>
                <option value="">-- choose the section --</option>
                <option value="THIS">This return (any of its sections)</option>
                {groups.map(([g, items]) => <optgroup key={g} label={g}>{items.map(x => <option key={x.code} value={x.code}>{x.label}</option>)}</optgroup>)}
                <option value="OTHER">Other returns (not split further)</option>
              </select></td>
              <td className="num"><input value={l.amount} inputMode="decimal" aria-label={`Amount, line ${i + 1}`}
                onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></td>
              <td><button className="link" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>remove</button></td>
            </tr>))}</tbody>
          <tfoot><tr><td><button className="link" onClick={() => setLines(ls => [...ls, { code: '', amount: '' }])}>+ add a section</button></td>
            <td className="num">{inr(sum, 0)}</td><td className={Math.abs(diff) > 0.5 ? 'bad' : 'ok'}>{Math.abs(diff) > 0.5 ? `${diff > 0 ? 'short' : 'over'} by ${inr(Math.abs(diff), 0)}` : 'adds up'}</td></tr></tfoot>
        </table>
        {err && <p className="bad">{err}</p>}
        <div className="actions"><button className="ghost" onClick={onCancel}>Cancel</button><button disabled={Math.abs(diff) > 0.5} onClick={save}>Save split</button></div>
      </div>
    </div>);
}

/** A linking plan: rows to challans, and how much of each challan's other-return share that needs (the user's OK). */
type LinkPlan = { links: { row: number; challanNo: number }[]; approvals: { no: number; extra: number }[]; otherHeadRows: number; label: string };

const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/** Rows without a challan, in groups with a suggestion each; tick groups or rows and link them in one go. */
function OpenRows({ groups, rowById, chById, useById, onLink, canUndo, onUndo }:
  { groups: OpenGroup[]; rowById: Map<number, RowIn>; chById: Map<number, ChallanIn>; useById: Map<number, ChallanUse>; challans: ChallanIn[];
    onLink: (p: LinkPlan) => void; canUndo: boolean; onUndo: () => void }) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState<LinkPlan | null>(null);
  const [err, setErr] = useState('');
  const allRows = groups.flatMap(g => g.rows);
  const taxOf = (row: number) => rowById.get(row)?.tax ?? 0;
  const selRows = allRows.filter(r => sel.has(r));
  const selTax = selRows.reduce((a, r) => a + taxOf(r), 0);
  const groupOf = new Map(groups.flatMap(g => g.rows.map(r => [r, g] as const)));
  const toggle = (rows: number[], on: boolean) => setSel(s => { const n = new Set(s); for (const r of rows) (on ? n.add(r) : n.delete(r)); return n; });
  const label = (no: number) => `${chById.get(no)?.serial} (${chById.get(no)?.date})`;
  const headOf = (row: number) => (/^[A-Z]{3}C/.test(rowById.get(row)?.pan ?? '') ? '0020' : '0021');

  // how much of a challan's other-return share the rows need, after its own money for this return
  const plan = (byChallan: Map<number, number[]>, what: string): LinkPlan | string => {
    const links: LinkPlan['links'] = [], approvals: LinkPlan['approvals'] = [];
    let otherHeadRows = 0;
    for (const [no, rows] of byChallan) {
      const c = chById.get(no)!, u = useById.get(no)!;
      const early = rows.filter(r => (rowById.get(r)?.dateDeducted ?? '') > c.date);
      if (early.length) return `${early.length} row(s) were deducted after ${label(no)} was paid - a challan can only pay tax already deducted.`;
      if (u.limitFrom === 'missing') return `${label(no)} has no split yet - enter it first.`;
      const need = rows.reduce((a, r) => a + taxOf(r), 0);
      const extra = Math.round(Math.max(0, need - Math.max(0, u.left)) * 100) / 100;
      const avail = u.otherShare - u.approved;
      if (extra > avail + 0.5) return `${label(no)} has only Rs ${inr(Math.max(0, u.left), 0)} of this return's money and Rs ${inr(avail, 0)} of other returns' share left - not enough for Rs ${inr(need, 0)}.`;
      if (extra > 0.5) approvals.push({ no, extra });
      otherHeadRows += rows.filter(r => c.majorHead && c.majorHead !== headOf(r)).length;
      links.push(...rows.map(row => ({ row, challanNo: no })));
    }
    return { links, approvals, otherHeadRows, label: what };
  };
  const run = (p: LinkPlan | string) => {
    setErr('');
    if (typeof p === 'string') { setErr(p); return; }
    if (p.approvals.length || p.otherHeadRows) setConfirm(p); else { onLink(p); setSel(new Set()); }
  };
  const linkSuggested = () => {
    const by = new Map<number, number[]>(); let none = 0;
    for (const r of selRows) { const g = groupOf.get(r); if (!g?.suggest) { none++; continue; } by.set(g.suggest.no, [...(by.get(g.suggest.no) ?? []), r]); }
    if (!by.size) { setErr('None of the selected rows has a suggested challan.'); return; }
    run(plan(by, `${selRows.length - none} row(s) linked to the suggested challans${none ? ` (${none} without a suggestion left as they are)` : ''}`));
  };
  const linkTo = () => {
    if (!target) { setErr('Choose the challan to link to.'); return; }
    run(plan(new Map([[Number(target), selRows]]), `${selRows.length} row(s) linked to ${label(Number(target))}`));
  };

  return (
    <div className="open-rows">
      <h3>Rows that need a challan ({allRows.length} rows · Rs {inr(allRows.reduce((a, r) => a + taxOf(r), 0), 0)})</h3>
      <p className="muted">Grouped by month, section and payee type. Tick groups (or open a group and tick rows), then link them with the bar below. Taking another return's money always asks you first.
        {canUndo && <>{' '}<button className="link" onClick={onUndo}>Undo the last linking</button></>}</p>
      <div className="scroll"><table className="groups">
        <thead><tr>
          <th><input type="checkbox" aria-label="Select all" checked={selRows.length === allRows.length && allRows.length > 0}
            ref={el => { if (el) el.indeterminate = selRows.length > 0 && selRows.length < allRows.length; }}
            onChange={e => toggle(allRows, e.target.checked)} /></th>
          <th>Rows</th><th>Deducted</th><th className="wrap">Section</th><th>Payee</th><th className="num">Tax</th><th className="wrap">Suggestion</th><th className="wrap">Why</th>
        </tr></thead>
        <tbody>{groups.map(g => {
          const n = g.rows.filter(r => sel.has(r)).length, isOpen = open.has(g.key);
          const sg = g.suggest;
          return [
            <tr key={g.key} className="grp">
              <td><input type="checkbox" aria-label={`Select group ${monthName(g.month)} ${g.code}`} checked={n === g.rows.length}
                ref={el => { if (el) el.indeterminate = n > 0 && n < g.rows.length; }} onChange={e => toggle(g.rows, e.target.checked)} /></td>
              <td><button className="link" onClick={() => setOpen(o => { const x = new Set(o); x.has(g.key) ? x.delete(g.key) : x.add(g.key); return x; })}>{isOpen ? '▾' : '▸'} {g.rows.length} row(s)</button></td>
              <td>{monthName(g.month)}</td>
              <td className="wrap" title={`code ${g.code}`}><small>{sectionName(g.code)}</small></td>
              <td>{g.head === '0020' ? 'Company' : 'Non-company'}</td>
              <td className="num">{inr(g.tax, 0)}</td>
              <td className="wrap">{sg
                ? <small>Link to <b>{label(sg.no)}</b>{sg.fromOther > 0.5
                    ? <>, using Rs {inr(sg.fromOther, 0)} of its {sg.sections.map(sectionName).join(', ')} share - <i>needs your OK</i></>
                    : ' - fits its own money for this return'}{sg.otherHead ? '; other major head (SOP rule 11, noted)' : ''}</small>
                : <small className="bad">No challan can take these - add the missing challan, or check whether the deposit was short.</small>}</td>
              <td className="wrap"><small>{g.why}</small></td>
            </tr>,
            ...(isOpen ? g.rows.map(r => {
              const x = rowById.get(r)!;
              return <tr key={`${g.key}-${r}`} className="sub">
                <td><input type="checkbox" aria-label={`Select row ${r}`} checked={sel.has(r)} onChange={e => toggle([r], e.target.checked)} /></td>
                <td>Row {r}</td><td>{x.dateDeducted}</td><td colSpan={2}>{x.name} <small className="muted">{x.pan}</small></td>
                <td className="num">{inr(x.tax, 0)}</td><td colSpan={2} />
              </tr>;
            }) : []),
          ];
        })}</tbody>
      </table></div>
      {err && <p className="bad">{err}</p>}
      {selRows.length > 0 && (
        <div className="bulkbar">
          <span><b>Selected:</b> {selRows.length} row(s) · Rs {inr(selTax, 0)}</span>
          <button className="small" onClick={linkSuggested}>Link to the suggested challans</button>
          <span className="muted">or link all to</span>
          <select value={target} onChange={e => setTarget(e.target.value)} aria-label="Challan to link the selected rows to">
            <option value="">-- choose a challan --</option>
            {[...chById.values()].map(c => { const u = useById.get(c.no); return (
              <option key={c.no} value={c.no}>{c.serial} {c.date} - this return left {inr(Math.max(0, u?.left ?? 0), 0)}{(u?.otherShare ?? 0) - (u?.approved ?? 0) > 0.5 ? `, other share ${inr((u!.otherShare - u!.approved), 0)}` : ''}</option>); })}
          </select>
          <button className="ghost small" onClick={linkTo}>Link</button>
          <button className="link" onClick={() => { setSel(new Set()); setErr(''); }}>clear</button>
        </div>)}
      {confirm && (
        <div className="modal" role="dialog" aria-label="Confirm linking">
          <div className="modal-box">
            <h3>Please confirm</h3>
            <p>{confirm.label}.</p>
            {confirm.approvals.length > 0 && <>
              <p><b>This uses another return's money - only with your OK:</b></p>
              <ul>{confirm.approvals.map(a => { const u = useById.get(a.no)!; return (
                <li key={a.no}>Rs {inr(a.extra, 0)} of {label(a.no)}'s {u.otherSections.map(sectionName).join(', ')} share (Rs {inr(u.otherShare, 0)}) - leaves Rs {inr(u.otherShare - u.takenFromOther - a.extra, 0)} for that return.</li>); })}</ul>
              <p className="muted">Check the salary register (or the other return): that return must still fit in what is left. Your approval is recorded on the challan.</p>
            </>}
            {confirm.otherHeadRows > 0 && <p className="warn">{confirm.otherHeadRows} row(s) go to a challan of the other major head - reported as deposited (SOP rule 11), with a note.</p>}
            <div className="actions"><button className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button onClick={() => { onLink(confirm); setConfirm(null); setSel(new Set()); }}>Yes, link and allow</button></div>
          </div>
        </div>)}
    </div>
  );
}

type Res = NonNullable<ReturnType<typeof matchChallans>>;
/** One plain summary of what stands between the user and the return, with the next action. Display only - the rules are in the engine. */
function StatusSummary({ res, challans, rows, options, unlinked, canApply, onSplit, onAllThis, onAllow }:
  { res: Res; challans: ChallanIn[]; rows: RowIn[]; options: ApprovalOption[]; unlinked: number; canApply: boolean;
    onSplit: (no: number) => void; onAllThis: (no: number) => void; onAllow: (no: number, amount: number) => void }) {
  const byNo = new Map(challans.map(c => [c.no, c]));
  const useOf = new Map(res.challans.map(u => [u.no, u]));
  const label = (no: number) => `${byNo.get(no)?.serial} of ${byNo.get(no)?.date}`;
  const missing = res.exceptions.filter(e => e.kind === 'split-missing').flatMap(e => e.challans);
  const over = res.exceptions.filter(e => e.kind === 'over-limit').flatMap(e => e.challans);
  const others = res.exceptions.filter(e => !['too-large', 'no-challan', 'split-missing', 'over-limit'].includes(e.kind)).length;
  void rows;
  if (canApply) return (
    <div className="banner ok-banner"><b>All {res.rows.length} rows have a challan, using only this return's money{res.challans.some(u => u.takenFromOther > 0.5) ? ' and what you allowed from other returns' : ''}.</b>
      {others > 0 && <> {others} point(s) below to check before you go on.</>}</div>);
  return (
    <div className="banner error"><b>Before the return can be built:</b>
      <ol>
        {missing.length > 0 && <li>
          <b>{missing.length} challan(s) have no receipt or section split</b> - say how each was paid, or upload its receipt above:
          <ul className="plain">{missing.map(no => <li key={no}>{label(no)}, Rs {inr(byNo.get(no)!.tax, 0)}{' '}
            <button className="ghost small" onClick={() => onAllThis(no)}>All for this return</button>{' '}
            <button className="ghost small" onClick={() => onSplit(no)}>Enter split…</button></li>)}</ul>
        </li>}
        {unlinked > 0 && <li>
          <b>{unlinked} row(s), Rs {inr(res.shortTax, 0)} of tax, have no room in this return's money on the challans.</b>
          {options.length > 0 ? <>{' '}The extra can only come from another return's share (e.g. 392(7) salary), and only if you allow it.
            <b> Fastest:</b> allow it on the one challan whose salary (or other) share was more than that return actually needed - check the salary register.
            Or link the groups under "Rows that need a challan" below, with their suggestions.
            <ul className="plain">{options.map(o => {
              const u = useOf.get(o.no)!;
              return <li key={o.no}>
                <button className="ghost small" onClick={() => onAllow(o.no, o.amount)}>Allow Rs {inr(o.amount, 0)} from {label(o.no)}</button>{' '}
                <small>{u.otherSections.map(sectionName).join(', ')} share Rs {inr(u.otherShare, 0)} → leaves Rs {inr(u.otherShare - u.approved - o.amount, 0)} for that return; {o.clearsAll ? 'all rows linked' : `${o.openAfter} row(s) still open`}{o.interestShort > 0 ? `; interest short about Rs ${inr(o.interestShort, 0)} in total` : ''}</small>
              </li>;
            })}</ul></>
            : <> No challan has another return's share to spare after these rows' dates. A challan may be missing (upload its receipt), or the deposit was short - choose a challan for these rows below.</>}
        </li>}
        {over.length > 0 && <li>
          <b>{over.map(label).join(', ')} {over.length > 1 ? 'are' : 'is'} used beyond this return's money.</b> Move rows to another challan, or allow part of the other returns' share.
        </li>}
      </ol>
    </div>);
}

function Receipts({ work, existing, setWorkbook, ai, setMsg }:
  { work: Uint8Array; existing: number; setWorkbook: (b: Uint8Array) => void; ai: boolean; setMsg: (m: { cls: string; text: string }[]) => void }) {
  const [reads, setReads] = useState<PdfRead[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PdfRead | null>(null);
  const good = reads.filter(r => r.result.ok).map(r => r.result.receipt!) as ChallanReceipt[];
  const typed = useMemo(() => typedChallanLinks(work), [work]);

  const onPdfs = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const pdfjs = await loadPdfJs();
      setReads(await readChallanPdfs(await Promise.all([...files].map(async f => ({ name: f.name, data: await readBytes(f) }))), pdfjs as never));
    } catch (e) { setMsg([{ cls: 'bad', text: `Could not read the PDFs: ${(e as Error).message}` }]); }
    setBusy(false);
  };
  const addAll = (replace: boolean) => {
    const base = replace ? clearChallans(work) : work;
    setWorkbook(addChallansToWorkbook(base, good));
    setMsg([{ cls: 'ok', text: `${good.length} challan(s) from receipts ${replace ? 'now replace the Challans sheet' : 'added to the Challans sheet'} (with major head and section breakup).` }]);
    setReads([]);
  };
  const tryGemini = async (r: PdfRead) => {
    try {
      const out = fromGemini(await askGemini(geminiChallanRequest(maskReceiptText(r.text))));
      setReads(rs => rs.map(x => (x === r ? { ...x, result: out.ok ? out : { ...out, problems: ['Gemini could not read it either: ' + out.problems.join('; ')] } } : x)));
    } catch (e) { setMsg([{ cls: 'bad', text: (e as Error).message }]); }
    setPreview(null);
  };

  return (
    <div className="sub-card">
      <label className="file">Challan receipt PDFs from the e-filing portal (optional - gives major head and section breakup)
        <input type="file" accept=".pdf" multiple onChange={e => onPdfs(e.target.files)} /></label>
      {busy && <p>Reading receipts in your browser...</p>}
      {reads.length > 0 && <>
        <ul className="reads">{reads.map(r => (
          <li key={r.name} className={r.result.ok ? 'ok' : /not recognised/.test(r.result.problems[0] ?? '') ? 'muted' : 'bad'}>
            {r.name}: {r.result.ok
              ? `#${r.result.receipt!.serial} of ${r.result.receipt!.tenderDate}, major head ${r.result.receipt!.majorHead}, tax ${inr(r.result.receipt!.tax, 0)}, interest ${inr(r.result.receipt!.interest, 0)} - ${Object.entries(r.result.receipt!.breakup).map(([k, v]) => `${k}=${v}`).join(', ')}`
              : r.result.problems.join('; ')}
            {!r.result.ok && ai && r.text.replace(/\s/g, '').length > 50 && /not recognised|not found|not read/.test(r.result.problems.join()) &&
              <button className="link" onClick={() => setPreview(r)}>Try with Gemini</button>}
          </li>))}</ul>
        {good.length > 0 && <div className="actions left">
          {existing > 0 && typed === 0 && <button onClick={() => addAll(true)}>Replace the {existing} challan(s) on the sheet with these {good.length} receipts</button>}
          <button className={existing ? 'ghost' : ''} onClick={() => addAll(false)}>Add {good.length} receipt(s) as new challans</button>
        </div>}
        {existing > 0 && typed > 0 && <p className="muted">The sheet's challans cannot be replaced because {typed} deductee row(s) already have a challan number typed in.</p>}
      </>}
      {preview && (
        <div className="modal" role="dialog" aria-label="Send to Gemini">
          <div className="modal-box">
            <h3>This is all that will be sent to Gemini</h3>
            <p>TAN, PAN, name, CIN and bank reference are replaced by placeholders.</p>
            <pre>{maskReceiptText(preview.text)}</pre>
            <div className="actions"><button className="ghost" onClick={() => setPreview(null)}>Cancel</button><button onClick={() => tryGemini(preview)}>Send to Gemini</button></div>
          </div>
        </div>)}
    </div>
  );
}

function AiProposals({ challans, rows, res, form, onApply }:
  { challans: ReturnType<typeof readForMatching>['challans']; rows: RowIn[]; res: NonNullable<ReturnType<typeof matchChallans>>; form: Form; onApply: (links: Record<number, number>) => void }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [props, setProps] = useState<CheckedProposal[] | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const payload = useMemo(() => maskedPayload(challans, rows, res), [challans, rows, res]);

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const out = checkProposals(await askGemini(geminiExceptionRequest(payload)), challans, rows, res);
      if (out.problems.length) setErr(out.problems.join('; '));
      setProps(out.proposals);
      setTicked(new Set(out.proposals.map((p, i) => (p.verdict === 'accepted' ? i : -1)).filter(i => i >= 0)));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false); setShow(false);
  };
  const applyTicked = () => {
    const chosen = props!.filter((_, i) => ticked.has(i));
    const { links } = applyProposals(challans, rows, res, chosen, form);
    const want = new Set(chosen.flatMap(p => p.rows));
    onApply(Object.fromEntries(links.filter(l => want.has(l.row)).map(l => [l.row, l.challanNo])));
    setProps(null);
  };

  return (
    <div className="sub-card">
      {!props && <button onClick={() => setShow(true)} disabled={busy}>{busy ? 'Asking Gemini...' : 'Ask Gemini to propose challans for the open rows'}</button>}
      {err && <p className="bad">{err}</p>}
      {show && (
        <div className="modal" role="dialog" aria-label="Send to Gemini">
          <div className="modal-box">
            <h3>This is all that will be sent to Gemini</h3>
            <p>Challan numbers, dates, amounts, major head, section breakup; rows as numbers with month, section, company / non-company and tax. No PAN, name, TAN, BSR or challan serial.</p>
            <pre>{JSON.stringify(payload, null, 1)}</pre>
            <div className="actions"><button className="ghost" onClick={() => setShow(false)}>Cancel</button><button onClick={send}>Send to Gemini</button></div>
          </div>
        </div>)}
      {props && <>
        <h3>Gemini's proposals, checked by the rules</h3>
        {props.length === 0 && <p>No proposals.</p>}
        {props.map((p, i) => (
          <label key={i} className={`proposal ${p.verdict}`}>
            <input type="checkbox" disabled={p.verdict === 'rejected'} checked={ticked.has(i)}
              onChange={e => setTicked(t => { const n = new Set(t); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
            <div><b>{p.verdict === 'accepted' ? 'Fits the rules' : p.verdict === 'needs-approval' ? 'Needs your approval' : 'Rejected'}</b>: rows {p.rows.join(', ')} → challan #{p.challan}
              <br /><i>{p.explanation}</i><ul>{p.checks.map(c => <li key={c}>{c}</li>)}</ul></div>
          </label>))}
        <div className="actions left">
          <button className="ghost" onClick={() => setProps(null)}>Discard</button>
          <button disabled={!ticked.size} onClick={applyTicked}>Apply ticked proposals</button>
        </div>
      </>}
    </div>
  );
}
