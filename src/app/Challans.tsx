import { useMemo, useState } from 'react';
import { applyChallanMatches, matchChallans, readForMatching, type RowIn } from '../challanMatch.ts';
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
  const setWorkbook = (b: Uint8Array) => { setWork(b); setOverrides({}); };

  const apply = () => {
    set({ linked: applyChallanMatches(work, res!.rows.filter(r => r.challanNo !== null).map(r => ({ row: r.row, challanNo: r.challanNo! }))) });
    next();
  };

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

      {res && <>
        <h3>Challans ({m.challans.length})</h3>
        <Table rows={m.challans} rowClass={c => ((useById.get(c.no)?.interestDue ?? 0) > c.interest + 1 ? 'row-bad' : (useById.get(c.no)?.balance ?? 0) > 1 ? 'row-warn' : '')}
          cols={[
            { key: 'no', label: '#' }, { key: 'date', label: 'Date' }, { key: 'bsr', label: 'BSR' }, { key: 'serial', label: 'Serial' },
            { key: 'majorHead', label: 'Major head' },
            { key: 'tax', label: 'Tax', num: true },
            { key: 'used', label: 'Used here', num: true, value: c => useById.get(c.no)?.usedHere ?? 0 },
            { key: 'bal', label: 'Balance', num: true, value: c => useById.get(c.no)?.balance ?? 0 },
            { key: 'interest', label: 'Interest paid', num: true },
            { key: 'idue', label: 'Interest due', num: true, value: c => useById.get(c.no)?.interestDue ?? 0 },
            { key: 'notes', label: 'Notes', value: c => (useById.get(c.no)?.notes ?? []).join('; ') },
          ]} />

        {res.exceptions.length > 0 && <>
          <h3>Points needing a decision ({res.exceptions.length})</h3>
          <div className="cards">{res.exceptions.map((e, i) => <div key={i} className={`point ${e.kind}`}><b>{e.kind.replace('-', ' ')}</b> {e.message}</div>)}</div>
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
                  {m.challans.map(c => <option key={c.no} value={c.no}>#{c.no} {c.date} Rs {inr(c.tax, 0)} (left {inr(useById.get(c.no)?.balance ?? c.tax, 0)})</option>)}
                </select>) : <>#{r.challanNo} {chById.get(r.challanNo!)?.date}</>) },
            { key: 'reason', label: 'Why', render: r => <small>{r.reason}</small> },
          ]} />
      </>}

      <div className="actions">
        <button className="ghost" disabled={!res || unlinked > 0}
          onClick={() => download(applyChallanMatches(work, res!.rows.filter(r => r.challanNo !== null).map(r => ({ row: r.row, challanNo: r.challanNo! }))), `linked_${s.workbook!.name.replace(/\.xls$/i, '.xlsx')}`)}>
          Download workbook with challan links</button>
        <button disabled={!res || unlinked > 0} onClick={apply}>{unlinked ? `${unlinked} row(s) still need a challan` : 'Apply challan links and build the return'}</button>
      </div>
    </section>
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
