import { useEffect, useMemo, useState } from 'react';
import { TARGET_FVU, buildStatement, encodeReturn } from '../protean.ts';
import { readInputWorkbook } from '../inputWorkbook.ts';
import { reviewModel, type ReviewModel } from '../review.ts';
import { checkCsi } from '../csi.ts';
import { compareStatistics, readErrFile, readStatistics, readWarningFile, type FvuIssue } from '../fvuResult.ts';
import { download, inr, readLatin1, reviewWorkbook } from './util.ts';
import { Table, autoCols } from './Table.tsx';
import type { Session, StepProps } from './App.tsx';

/** Builds the return from the linked workbook with the frozen core. */
function build(s: Session): { lines: string[] | null; missing: string[]; error: string } {
  try {
    const inp = readInputWorkbook(s.linked!, s.form, s.quarter);
    if (inp.missing.length) return { lines: null, missing: inp.missing, error: '' };
    const deductor = inp.deductor ?? s.fvu?.deductor ?? null;
    if (!deductor) return { lines: null, missing: ['Deductor details: fill the Deductor sheet or upload last quarter\'s .fvu'], error: '' };
    const lines = buildStatement({ form: s.form, deductor, challans: inp.challans, fyStart: s.fy, quarter: s.quarter,
      prevToken: s.rrr || null, salary: inp.salary ?? undefined });
    return { lines, missing: [], error: '' };
  } catch (e) { return { lines: null, missing: [], error: (e as Error).message }; }
}

const csiFindings = (s: Session) => (s.csi && s.lines ? checkCsi(s.csi.info, s.lines, TARGET_FVU) : []);
const blockers = (s: Session, rv: ReviewModel, selfOk: boolean) => [
  ...(selfOk ? [] : ['Engine self-test failed on this deployment']),
  ...rv.problems, ...csiFindings(s).filter(f => f.level === 'error').map(f => f.message)];

export function ReviewStep({ s, set, next, selfTest }: StepProps) {
  const b = useMemo(() => build(s), [s.linked, s.form, s.quarter, s.fy, s.rrr, s.fvu]);
  useEffect(() => { if (b.lines && b.lines !== s.lines) set({ lines: b.lines }); }, [b]);
  const [tab, setTab] = useState('Summary');
  if (!b.lines) return (
    <section className="card"><h2>5. Review</h2>
      {b.error && <p className="bad">Could not build the return: {b.error}</p>}
      {b.missing.length > 0 && <div className="banner error"><b>Fill these in the workbook and upload it again:</b><ul>{b.missing.map(m => <li key={m}>{m}</li>)}</ul></div>}
    </section>);
  const rv = reviewModel(b.lines);
  const block = blockers({ ...s, lines: b.lines }, rv, !!selfTest?.ok);
  const tabs = ['Summary', 'Deductor', 'Challans', 'Deductees', ...(rv.salary ? ['Salary details'] : [])];
  return (
    <section className="card">
      <h2>5. Review - check this before running the FVU</h2>
      <nav className="tabs">{tabs.map(t => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</nav>
      {tab === 'Summary' && <Summary s={{ ...s, lines: b.lines }} rv={rv} />}
      {tab === 'Deductor' && <Table rows={rv.deductorDetails} total={false} cols={[{ key: 'field', label: 'Field' }, { key: 'label', label: 'Item' }, { key: 'value', label: 'Value' }]} />}
      {tab === 'Challans' && <Table rows={rv.challans} rowClass={c => (c.balanceForOtherForms > 0 ? 'row-warn' : '')} cols={[
        { key: 'no', label: '#' }, { key: 'bsr', label: 'BSR' }, { key: 'date', label: 'Date' }, { key: 'serial', label: 'Serial' },
        { key: 'tax', label: 'Tax', num: true }, { key: 'interest', label: 'Interest', num: true }, { key: 'fee', label: 'Fee', num: true },
        { key: 'others', label: 'Others', num: true }, { key: 'total', label: 'Total', num: true }, { key: 'rows', label: 'Rows' },
        { key: 'thisFormTax', label: 'This form', num: true }, { key: 'balanceForOtherForms', label: 'Balance for other forms', num: true }]} />}
      {tab === 'Challans' && rv.challans.some(c => c.balanceForOtherForms > 0) && <p className="warn">Amber rows: part of this challan belongs to another form.</p>}
      {tab === 'Deductees' && <Table rows={rv.deductees} cols={autoCols(rv.deductees)} />}
      {tab === 'Salary details' && rv.salary && <Table rows={rv.salary} cols={autoCols(rv.salary)} rowClass={r => (Number(r.shortfall) > 1 ? 'row-warn' : '')} />}
      <div className="actions">
        {block.length > 0 ? <span className="bad">Download is disabled until the problems above are fixed.</span>
          : <button onClick={next}>Next: download</button>}
      </div>
    </section>
  );
}

function Summary({ s, rv }: { s: Session; rv: ReviewModel }) {
  const t = rv.totals;
  const f = csiFindings(s);
  return (<>
    <dl className="summary">
      <dt>Deductor</dt><dd>{rv.deductor} ({rv.tan})</dd>
      <dt>Form / FY / quarter</dt><dd>{rv.form} · {rv.fy} · {rv.quarter}</dd>
      <dt>Previous RRR</dt><dd>{rv.prevRrr || 'none (no earlier statement)'}</dd>
      <dt>Challans</dt><dd>{t.challans} · total Rs {inr(t.challanTotal)}</dd>
      <dt>Deductee rows</dt><dd>{t.deducteeRows} ({t.distinctPans} PANs)</dd>
      <dt>Amount paid</dt><dd>Rs {inr(t.amountPaid)}</dd>
      <dt>Tax deducted / deposited</dt><dd>Rs {inr(t.taxDeducted)} / Rs {inr(t.taxDeposited)}</dd>
    </dl>
    {rv.problems.length > 0 && <div className="banner error"><b>Problems (must be fixed):</b><ul>{rv.problems.map(p => <li key={p}>{p}</li>)}</ul></div>}
    {rv.pointsToReview.length > 0 && <div className="banner warn"><b>Points to review:</b><ul>{rv.pointsToReview.map(p => <li key={p}>{p}</li>)}</ul></div>}
    {f.length > 0 && <div className="banner"><b>CSI checks</b><ul>{f.map(x => <li key={x.message} className={x.level === 'error' ? 'bad' : x.level === 'warning' ? 'warn' : 'muted'}>{x.message}</li>)}</ul></div>}
  </>);
}

export function DownloadStep({ s, next, selfTest }: StepProps) {
  const rv = useMemo(() => reviewModel(s.lines!), [s.lines]);
  const block = blockers(s, rv, !!selfTest?.ok);
  const sheets = () => ({
    Summary: [{ Deductor: rv.deductor, TAN: rv.tan, Form: rv.form, FY: rv.fy, Quarter: rv.quarter, 'Previous RRR': rv.prevRrr, ...rv.totals }] as Record<string, unknown>[],
    Deductor: rv.deductorDetails as unknown as Record<string, unknown>[],
    Challans: rv.challans as unknown as Record<string, unknown>[],
    Deductees: rv.deductees, ...(rv.salary ? { 'Salary details': rv.salary } : {}),
  });
  return (
    <section className="card">
      <h2>6. Download</h2>
      {block.length > 0 && <div className="banner error"><ul>{block.map(b => <li key={b}>{b}</li>)}</ul></div>}
      <div className="actions left">
        <button disabled={block.length > 0} onClick={() => download(encodeReturn(s.lines!), s.fileName)}>Download return file ({s.fileName})</button>
        <button className="ghost" onClick={() => download(reviewWorkbook(sheets()), s.fileName.replace(/\.txt$/, '_review.xlsx'))}>Download review workbook</button>
        {s.csi && <button className="ghost" onClick={() => download(s.csi!.bytes, s.csi!.info.validName)}>Download CSI with a valid name ({s.csi.info.validName})</button>}
      </div>
      <h3>Next steps</h3>
      <ol className="help">
        <li>Download Protean's free e-TDS/TCS FVU from Protean's TIN website, unzip it and run <code>TDS_STANDALONE_FVU_{TARGET_FVU}.jar</code> (needs Java 8).</li>
        <li>Give it the return <code>.txt</code>, the CSI file for the TAN (from the e-filing portal; name letters/digits only, max 25 characters) and an output folder.</li>
        <li>If the FVU reports errors, upload its files in step 7, fix the input workbook and rebuild - never edit the <code>.txt</code> by hand.</li>
        <li>Upload the <code>.fvu</code> on the e-filing portal (DSC/EVC) yourself.</li>
        {s.form === '138' && <li>Form 138 Q4: dates of employment and challans cannot be in the future, so a Q4 return validates only after 31 March.</li>}
      </ol>
      <div className="actions"><button className="ghost" onClick={next}>Next: FVU results</button></div>
    </section>
  );
}

export function FvuStep({ s }: StepProps) {
  const [issues, setIssues] = useState<FvuIssue[]>([]);
  const [stats, setStats] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const rv = useMemo(() => reviewModel(s.lines!), [s.lines]);
  const load = async (f: File | undefined, kind: 'err' | 'warn' | 'stats') => {
    if (!f) return;
    setErr('');
    try {
      const text = await readLatin1(f);
      if (kind === 'err') setIssues(i => [...i.filter(x => x.kind !== 'error'), ...readErrFile(text, s.lines!)]);
      if (kind === 'warn') setIssues(i => [...i.filter(x => x.kind !== 'warning'), ...readWarningFile(text, s.lines!)]);
      if (kind === 'stats') setStats(compareStatistics(readStatistics(text), rv.totals));
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="card">
      <h2>7. FVU results</h2>
      <p>Upload what the FVU wrote to its output folder. Each error is tied back to the challan / deductee row, with what usually fixes it.</p>
      <div className="grid3">
        <label className="file">Error file (.err)<input type="file" accept=".err,.txt" onChange={e => load(e.target.files?.[0], 'err')} /></label>
        <label className="file">Warning file (…Warning_File.html)<input type="file" accept=".html,.htm" onChange={e => load(e.target.files?.[0], 'warn')} /></label>
        <label className="file">Statistics report (.html)<input type="file" accept=".html,.htm" onChange={e => load(e.target.files?.[0], 'stats')} /></label>
      </div>
      {err && <p className="bad">{err}</p>}
      {stats && (stats.length ? <div className="banner error"><b>FVU totals differ from the return:</b><ul>{stats.map(x => <li key={x}>{x}</li>)}</ul></div>
        : <p className="ok">FVU totals match the return.</p>)}
      {issues.length > 0 && <Table rows={issues} total={false} rowClass={i => (i.kind === 'error' ? 'row-bad' : 'row-warn')} cols={[
        { key: 'kind', label: 'Type' }, { key: 'code', label: 'Code' }, { key: 'where', label: 'Where' },
        { key: 'description', label: 'FVU says' }, { key: 'hint', label: 'Usually fixed by' }]} />}
    </section>
  );
}
