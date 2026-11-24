import { useMemo, useState } from 'react';
import { applyChallanMatches, approvalOptions, formatBreakup, matchChallans, readForMatching, setApproved, setChallanSplit, type ApprovalOption, type ChallanIn, type ChallanUse, type RowIn } from '../challanMatch.ts';
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
  const shownRows = res ? (showAll ? res.rows : res.rows.filter(r => r.status === 'exception' || overrides[r.row])) : [];

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

        {res.exceptions.length > 0 && <>
          <details className="points" open={res.exceptions.length <= 3}>
            <summary><h3>Points needing a decision ({res.exceptions.length})</h3></summary>
            <div className="cards">{res.exceptions.map((e, i) => <div key={i} className={`point ${e.kind}`}><b>{e.kind.replace('-', ' ')}</b> {withSectionNames(e.message)}</div>)}</div>
          </details>
          {ai && unlinked > 0 && <AiProposals challans={m.challans} rows={rowsIn} res={res} form={s.form} onApply={links => setOverrides(o => ({ ...o, ...links }))} />}
        </>}

        <h3>Deductee rows ({res.rows.length}) {unlinked > 0 ? <span className="bad">- {unlinked} need a challan</span> : <span className="ok">- all linked</span>}
          {' '}<button className="link" onClick={() => setShowAll(v => !v)}>{showAll ? 'show only rows that need attention' : `show all ${res.rows.length} rows`}</button></h3>
        {shownRows.length > 0 ? <Table rows={shownRows} total={false}
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
          ]} /> : <p className="muted">No rows need attention.</p>}
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
          {options.length > 0 ? <>{' '}The extra can come from another return's share (e.g. 392(7) salary) on one of these challans - only if you allow it.
            Pick the challan whose other-return share was more than that return actually needed (check the salary register):
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
