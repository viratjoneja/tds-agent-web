import { useMemo, useState } from 'react';
import { applyChallanMatches, matchChallans, readForMatching, readOtherFormUse, setOtherForms, setOtherFormsFor, type OtherFormUse, type RowIn } from '../challanMatch.ts';
import { addChallansToWorkbook, fromGemini, geminiChallanRequest, maskReceiptText, readChallanPdfs, type ChallanReceipt, type ReadResult } from '../challanPdf.ts';
import { applyProposals, checkProposals, geminiExceptionRequest, maskedPayload, type CheckedProposal } from '../aiExceptions.ts';
import { askGemini } from './ai.ts';
import { clearChallans, download, inr, readBytes, typedChallanLinks } from './util.ts';
import { Table } from './Table.tsx';
import type { StepProps } from './App.tsx';

type PdfRead = { name: string; result: ReadResult; text: string };

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

export function ChallansStep({ s, set, next, ai }: StepProps) {
  const [work, setWork] = useState<Uint8Array>(s.withSections!);
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [msg, setMsg] = useState<{ cls: string; text: string }[]>([]);

  const m = useMemo(() => { try { return readForMatching(work); } catch (e) { return { challans: [], rows: [], problems: [(e as Error).message], warnings: [] }; } }, [work]);
  const rowsIn: RowIn[] = useMemo(() => m.rows.map(r => (overrides[r.row] ? { ...r, challanNo: overrides[r.row] } : r)), [m, overrides]);
  const res = useMemo(() => (m.problems.length ? null : matchChallans(m.challans, rowsIn)), [m, rowsIn]);
  const rowById = useMemo(() => new Map(m.rows.map(r => [r.row, r])), [m]);
  const chById = useMemo(() => new Map(m.challans.map(c => [c.no, c])), [m]);
  const useById = useMemo(() => new Map((res?.challans ?? []).map(c => [c.no, c])), [res]);
  const unlinked = res ? res.rows.filter(r => r.challanNo === null).length : 0;
  const blocking = res ? res.exceptions.filter(e => e.kind === 'split-unknown' || e.kind === 'over-limit') : [];
  const canApply = !!res && unlinked === 0 && blocking.length === 0;
  const setWorkbook = (b: Uint8Array) => { setWork(b); setOverrides({}); };
  const setOther = (no: number, text: string) => {
    const t = text.replace(/,/g, '').trim();
    const v = t === '' ? null : Number(t);
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setMsg([{ cls: 'bad', text: `"${text}" is not an amount` }]); return; }
    const cur = chById.get(no)?.otherForms ?? null;
    if (cur === v) return;
    try { setWork(setOtherFormsFor(work, no, v)); } catch (e) { setMsg([{ cls: 'bad', text: (e as Error).message }]); }
  };

  const apply = () => {
    set({ linked: applyChallanMatches(work, res!.rows.filter(r => r.challanNo !== null).map(r => ({ row: r.row, challanNo: r.challanNo! }))) });
    next();
  };

  return (
    <section className="card">
      <h2>4. Challans</h2>
      <Receipts work={work} existing={m.challans.length} setWorkbook={setWorkbook} ai={ai} setMsg={setMsg} />
      <OtherReturns work={work} setWork={setWork} setMsg={setMsg} />
      {msg.map(x => <p key={x.text} className={x.cls}>{x.text}</p>)}

      {m.problems.length > 0 && (
        <div className="banner error"><b>Fix these in the workbook and upload it again:</b>
          <ul>{m.problems.map(p => <li key={p}>{p}</li>)}</ul></div>)}
      {m.warnings.length > 0 && (
        <details className="banner warn"><summary>{m.warnings.length} row(s) where Tax differs from Amount x Rate % - fine if it is the tax actually deducted</summary>
          <ul>{m.warnings.map(p => <li key={p}>{p}</li>)}</ul></details>)}

      {res && <StatusSummary res={res} challans={m.challans} rows={m.rows} unlinked={unlinked} canApply={canApply} />}

      {res && <>
        <h3>Challans ({m.challans.length})</h3>
        <Table rows={m.challans} rowClass={c => ((useById.get(c.no)?.interestDue ?? 0) > c.interest + 1 ? 'row-bad' : (useById.get(c.no)?.balance ?? 0) > 1 ? 'row-warn' : '')}
          cols={[
            { key: 'no', label: '#' }, { key: 'date', label: 'Date' }, { key: 'bsr', label: 'BSR' }, { key: 'serial', label: 'Serial' },
            { key: 'majorHead', label: 'Major head' },
            { key: 'tax', label: 'Tax', num: true },
            { key: 'other', label: 'Used by other forms', value: c => c.otherForms ?? '', render: c => (
              <input className="code" key={`${c.no}-${c.otherForms ?? ''}`} defaultValue={c.otherForms ?? ''} inputMode="decimal"
                placeholder={c.breakup ? 'receipt' : '?'} aria-label={`Used by other forms, challan ${c.no}`}
                onBlur={e => setOther(c.no, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />) },
            { key: 'limit', label: 'For this return', num: true, value: c => useById.get(c.no)?.forThisReturn ?? c.tax },
            { key: 'used', label: 'Used here', num: true, value: c => useById.get(c.no)?.usedHere ?? 0 },
            { key: 'left', label: 'Left for this return', num: true, value: c => useById.get(c.no)?.left ?? 0 },
            { key: 'interest', label: 'Interest paid', num: true },
            { key: 'idue', label: 'Interest due', num: true, value: c => useById.get(c.no)?.interestDue ?? 0 },
            { key: 'notes', label: 'Notes', wrap: true, value: c => (useById.get(c.no)?.notes ?? []).join('; ') },
          ]} />

        {res.exceptions.length > 0 && <>
          <details className="points" open={res.exceptions.length <= 3}>
            <summary><h3>Points needing a decision ({res.exceptions.length})</h3></summary>
            <div className="cards">{res.exceptions.map((e, i) => <div key={i} className={`point ${e.kind}`}><b>{e.kind.replace('-', ' ')}</b> {shortMessage(e.message)}</div>)}</div>
          </details>
          {ai && unlinked > 0 && <AiProposals challans={m.challans} rows={rowsIn} res={res} onApply={links => setOverrides(o => ({ ...o, ...links }))} />}
        </>}

        <h3>Deductee rows ({res.rows.length}) {unlinked > 0 ? <span className="bad">- {unlinked} need a challan</span> : <span className="ok">- all linked</span>}</h3>
        <Table rows={res.rows} total={false}
          rowClass={r => (r.status === 'exception' ? (r.challanNo ? 'row-warn' : 'row-bad') : '')}
          cols={[
            { key: 'row', label: 'Row' },
            { key: 'name', label: 'Name', value: r => rowById.get(r.row)?.name },
            { key: 'pan', label: 'PAN', value: r => rowById.get(r.row)?.pan },
            { key: 'code', label: 'Section', value: r => rowById.get(r.row)?.code },
            { key: 'date', label: 'Deducted', value: r => rowById.get(r.row)?.dateDeducted },
            { key: 'tax', label: 'Tax', num: true, value: r => rowById.get(r.row)?.tax },
            { key: 'challan', label: 'Challan', value: r => r.challanNo ?? '', render: r => (
              r.status === 'exception' || overrides[r.row] ? (
                <select value={r.challanNo ?? ''} aria-label={`Challan for row ${r.row}`}
                  onChange={e => setOverrides(o => { const n = { ...o }; if (e.target.value) n[r.row] = Number(e.target.value); else delete n[r.row]; return n; })}>
                  <option value="">-- choose --</option>
                  {m.challans.map(c => <option key={c.no} value={c.no}>#{c.no} {c.date} Rs {inr(c.tax, 0)} (left for this return {inr(useById.get(c.no)?.left ?? c.tax, 0)})</option>)}
                </select>) : <>#{r.challanNo} {chById.get(r.challanNo!)?.date}</>) },
            { key: 'reason', label: 'Why', wrap: true, render: r => <small>{r.reason}</small> },
          ]} />
      </>}

      {res && <p className="muted"><small>"Used by other forms": what the other return of this quarter (e.g. 24Q salary) claims from the challan. It is the limit for this return; blank = taken from the receipt's section split, or unknown. Enter 0 if no other return uses the challan.</small></p>}
      <div className="actions">
        <button className="ghost" disabled={!canApply}
          onClick={() => download(applyChallanMatches(work, res!.rows.filter(r => r.challanNo !== null).map(r => ({ row: r.row, challanNo: r.challanNo! }))), `linked_${s.workbook!.name.replace(/\.xls$/i, '.xlsx')}`)}>
          Download workbook with challan links</button>
        <button disabled={!canApply} onClick={apply}>{unlinked ? `${unlinked} row(s) still need a challan` : blocking.length ? 'Settle the challan split first' : 'Apply challan links and build the return'}</button>
      </div>
    </section>
  );
}

/** The engine's long "no room" message without the parts the summary above already says. */
const shortMessage = (msg: string) => msg
  .replace(/ A short deposit, a challan missing from the sheet, or a wrong split with another return - needs a decision\./, '')
  .replace(/ Money kept for other returns, not used:.*$/, '');

type Res = NonNullable<ReturnType<typeof matchChallans>>;
/** One plain summary of what stands between the user and the return, with the next action. Display only - the rules are in the engine. */
function StatusSummary({ res, challans, rows, unlinked, canApply }:
  { res: Res; challans: ReturnType<typeof readForMatching>['challans']; rows: RowIn[]; unlinked: number; canApply: boolean }) {
  const byNo = new Map(challans.map(c => [c.no, c]));
  const taxOf = new Map(rows.map(r => [r.row, r.tax]));
  const openTax = res.rows.filter(r => r.challanNo === null).reduce((a, r) => a + (taxOf.get(r.row) ?? 0), 0);
  const label = (no: number) => `#${no} (${byNo.get(no)?.serial}, ${byNo.get(no)?.date})`;
  const kept = res.challans.filter(u => u.tax - u.forThisReturn > 1 && u.limitFrom === 'breakup');
  const unknown = res.exceptions.filter(e => e.kind === 'split-unknown').flatMap(e => e.challans);
  const over = res.exceptions.filter(e => e.kind === 'over-limit').flatMap(e => e.challans);
  const others = res.exceptions.filter(e => !['too-large', 'no-challan', 'split-unknown', 'over-limit'].includes(e.kind)).length;
  if (canApply) return (
    <div className="banner ok-banner"><b>All {res.rows.length} rows have a challan, and no challan is used beyond its share for this return.</b>
      {others > 0 && <> {others} point(s) below to check before you go on.</>}</div>);
  return (
    <div className="banner error"><b>Before the return can be built:</b>
      <ol>
        {unlinked > 0 && <li>
          <b>{unlinked} row(s), Rs {inr(openTax, 0)} of tax, have no room in the challans.</b>{' '}
          {kept.length > 0
            ? <>The challan receipts keep {kept.map(u => `Rs ${inr(u.tax - u.forThisReturn, 0)} on ${label(u.no)}`).join(', ')} for salary or another return.
                If the 24Q (or other return) used less than that, <b>upload the 24Q sheet in the box above</b>, or type what it used in <b>"Used by other forms"</b> for that challan.
                Otherwise a challan is missing or the deposit was short - choose a challan for these rows in the table below.</>
            : <>A challan may be missing from the sheet, or the deposit was short. Add the challan (receipt PDFs above), or choose one for these rows in the table below.</>}
        </li>}
        {unknown.length > 0 && <li>
          <b>Not known whether {unknown.map(label).join(", ")} also {unknown.length > 1 ? "pay" : "pays"} salary or another return</b> (money is left on them).
          Upload the challan receipts or the 24Q sheet above, or type in <b>"Used by other forms"</b> what the other return uses - <b>0</b> if none.
        </li>}
        {over.length > 0 && <li>
          <b>{over.map(label).join(', ')} {over.length > 1 ? 'are' : 'is'} used beyond the share for this return.</b> Move rows to another challan, or correct "Used by other forms".
        </li>}
      </ol>
    </div>);
}

function OtherReturns({ work, setWork, setMsg }:
  { work: Uint8Array; setWork: (b: Uint8Array) => void; setMsg: (m: { cls: string; text: string }[]) => void }) {
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const uses: OtherFormUse[] = [], bad: string[] = [];
    for (const f of [...files]) {
      const r = readOtherFormUse(await readBytes(f));
      if (r.problems.length) bad.push(`${f.name}: ${r.problems.join('; ')}`); else uses.push(...r.uses);
    }
    if (!uses.length) { setMsg(bad.map(text => ({ cls: 'bad', text }))); return; }
    const out = setOtherForms(work, uses);
    setWork(out.bytes);
    setMsg([
      { cls: 'ok', text: `Used by other forms set from ${files.length} file(s): ${out.matched.map(x => `#${x.no} Rs ${inr(x.amount, 0)}`).join(', ') || 'no challan on this sheet matched'}.` },
      ...(out.notOnSheet.length ? [{ cls: 'muted', text: `Not on this return's Challans sheet: ${out.notOnSheet.map(u => `${u.serial} of ${u.date} (Rs ${inr(u.amount, 0)})`).join(', ')}.` }] : []),
      ...bad.map(text => ({ cls: 'bad', text }))]);
  };
  return (
    <div className="sub-card">
      <label className="file">The other return of this quarter, e.g. the 24Q (Compu-TDS sheet) or this tool's input workbook for that form (optional - gives exactly how much of each challan it uses; best source for the split)
        <input type="file" accept=".xls,.xlsx" multiple onChange={e => onFiles(e.target.files)} /></label>
    </div>
  );
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

function AiProposals({ challans, rows, res, onApply }:
  { challans: ReturnType<typeof readForMatching>['challans']; rows: RowIn[]; res: NonNullable<ReturnType<typeof matchChallans>>; onApply: (links: Record<number, number>) => void }) {
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
    const { links } = applyProposals(challans, rows, res, chosen);
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
