import { useEffect, useMemo, useState } from 'react';
import { TARGET_FVU, buildStatement, encodeReturn } from '../protean.ts';
import { readInputWorkbook } from '../inputWorkbook.ts';
import { reviewModel, type ReviewModel } from '../review.ts';
import { checkCsi, parseCsi } from '../csi.ts';
import { allowedLateDeductions, checkUpload } from '../dataChecks.ts';
import { sectionName } from './sectionNames.ts';
import { compareStatistics, readErrFile, readStatistics, readWarningFile, type FvuIssue } from '../fvuResult.ts';
import { download, inr, readBytes, readLatin1 } from './util.ts';
import { logTdsRun } from './office.ts';
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
/** The frozen core's problems, less late deductions (Protean's FVU accepts those - they become points to review). */
const splitProblems = (s: Session, rv: ReviewModel) => allowedLateDeductions(rv.problems, s.lines ?? [], s.fy, s.quarter);
const SHARED_POINT = /challan\(s\) are shared with another form/;
const blockers = (s: Session, rv: ReviewModel, selfOk: boolean, sharedOk = true) => [
  ...(selfOk ? [] : ['Engine self-test failed on this deployment']),
  ...splitProblems(s, rv).blocking, ...csiFindings(s).filter(f => f.level === 'error').map(f => f.message),
  ...(sharedOk ? [] : ['Confirm the balances left on the shared challans for the other returns (Summary tab)'])];
const sharedChallans = (s: Session) => (s.setoff ? s.setoff.result.challans.filter(u => u.otherShare - u.takenFromOther > 0.5 || u.left > 0.5) : []);

/** Everything the report needs, from the session. */
export async function makeReport(s: Session, rv: ReviewModel) {
  const { fullReport } = await import('./report.ts');
  const sp = splitProblems(s, rv);
  return fullReport({ meta: { deductor: rv.deductor, tan: rv.tan, form: s.form, fy: s.fy, quarter: s.quarter, file: s.workbook?.name },
    rv, setoff: s.setoff, workbook: s.linked ?? undefined, checks: s.workbook ? checkUpload(s.workbook.bytes, s.fy, s.quarter) : null,
    problems: sp.blocking, points: rv.pointsToReview.filter(p => !SHARED_POINT.test(p)), late: sp.late, csi: csiFindings(s) });
}

export function ReviewStep({ s, set, next, selfTest }: StepProps) {
  const [sharedOk, setSharedOk] = useState(false);
  const b = useMemo(() => build(s), [s.linked, s.form, s.quarter, s.fy, s.rrr, s.fvu]);
  useEffect(() => { if (b.lines && b.lines !== s.lines) set({ lines: b.lines }); }, [b]);
  const [tab, setTab] = useState('Summary');
  if (!b.lines) return (
    <section className="card"><h2>5. Review</h2>
      {b.error && <p className="bad">Could not build the return: {b.error}</p>}
      {b.missing.length > 0 && <div className="banner error"><b>Fill these in the workbook and upload it again:</b><ul>{b.missing.map(m => <li key={m}>{m}</li>)}</ul></div>}
    </section>);
  const rv = reviewModel(b.lines);
  const shared = sharedChallans(s);
  const block = blockers({ ...s, lines: b.lines }, rv, !!selfTest?.ok, !shared.length || sharedOk || s.sharedOk);
  const tabs = ['Summary', 'Deductor', 'Challans', 'Deductees', ...(rv.salary ? ['Salary details'] : [])];
  return (
    <section className="card">
      <h2>5. Review - check this before running the FVU</h2>
      <nav className="tabs">{tabs.map(t => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</nav>
      {tab === 'Summary' && <Summary s={{ ...s, lines: b.lines }} rv={rv} set={set} sharedOk={sharedOk || !!s.sharedOk} setSharedOk={v => { setSharedOk(v); set({ sharedOk: v }); }} />}
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
        <button className="ghost" onClick={async () => download(await makeReport({ ...s, lines: b.lines }, rv), s.fileName.replace(/\.txt$/, '_report.xlsx'))}>Download the return report (Excel)</button>
        {block.length > 0 ? <span className="bad">{block.length === 1 && /Confirm the balances/.test(block[0]) ? 'Tick the confirmation above to go on.' : 'Download is disabled until the problems above are fixed.'}</span>
          : <button onClick={next}>Next: download</button>}
      </div>
    </section>
  );
}

function Summary({ s, rv, set, sharedOk, setSharedOk }: { s: Session; rv: ReviewModel; set: StepProps['set']; sharedOk: boolean; setSharedOk: (v: boolean) => void }) {
  const t = rv.totals;
  const f = csiFindings(s);
  const sp = splitProblems(s, rv);
  const checks = s.workbook ? checkUpload(s.workbook.bytes, s.fy, s.quarter) : null;
  const interest = (checks?.late ?? []).reduce((a, l) => a + l.interest, 0);
  const shared = sharedChallans(s);
  const ch = new Map((s.setoff?.challans ?? []).map(c => [c.no, c]));
  const points = rv.pointsToReview.filter(p => !SHARED_POINT.test(p));
  const stale = f.find(x => /days? after the latest challan/.test(x.message) && x.level !== 'info');
  const [csiMsg, setCsiMsg] = useState('');
  const onCsi = async (file?: File) => {
    if (!file) return;
    try { const bytes = await readBytes(file); set({ csi: { info: parseCsi(new TextDecoder('latin1').decode(bytes), file.name), bytes } }); setCsiMsg(`Loaded ${file.name}.`); }
    catch (e) { setCsiMsg(`Not a CSI file: ${(e as Error).message}`); }
  };
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
    {sp.blocking.length > 0
      ? <div className="banner error"><b>Problems (must be fixed in the workbook):</b><ul>{sp.blocking.map(p => <li key={p}>{p}</li>)}</ul></div>
      : <div className="banner ok-banner"><b>No problems</b> - the return file can be built.</div>}

    {shared.length > 0 && (
      <div className="banner warn">
        <b>{shared.length} challan(s) have money this return does not use.</b>{' '}
        "Left for other returns" must be used by those returns (e.g. the 24Q for 392(7) salary); "unused" is this return's own money not needed here - excess, or for a later return.
        <div className="scroll"><table className="compact"><thead><tr><th>Challan</th><th className="num">Tax</th><th className="num">Used by this return</th><th className="num">…of which approved from other share</th><th className="wrap">Other returns' sections</th><th className="num">Left for other returns</th><th className="num">Unused by this return</th></tr></thead>
          <tbody>{shared.map(u => { const c = ch.get(u.no); const other = u.otherShare - u.takenFromOther; return <tr key={u.no}><td>{c?.serial} <small className="muted">{c?.date}</small></td><td className="num">{inr(u.tax, 0)}</td>
            <td className="num">{inr(u.usedHere, 0)}</td><td className="num">{u.takenFromOther ? inr(u.takenFromOther, 0) : ''}</td>
            <td className="wrap"><small>{u.otherSections.map(sectionName).join(', ') || '-'}</small></td><td className="num"><b>{other > 0.5 ? inr(other, 0) : ''}</b></td>
            <td className="num">{u.left > 0.5 ? inr(u.left, 0) : ''}</td></tr>; })}</tbody></table></div>
        <label className="check"><input type="checkbox" checked={sharedOk} onChange={e => setSharedOk(e.target.checked)} /> I have noted these balances (they are also in the report's Challan set-off sheet).</label>
      </div>)}

    {(sp.late.length > 0 || points.length > 0) && <div className="banner warn"><b>Points to review:</b><ul>
      {sp.late.length > 0 && <li><b>{sp.late.length} late deduction(s)</b> - paid in an earlier quarter, deducted in this one; reported as they are (Protean's FVU accepts this).
        Interest for late deduction about <b>Rs {inr(interest, 0)}</b> - pay it with the next challan. <small>{sp.late.join(' · ')}</small></li>}
      {points.map(p => <li key={p}>{p}</li>)}</ul></div>}

    {f.length > 0 && <div className="banner"><b>CSI checks</b><ul>{f.map(x => <li key={x.message} className={x.level === 'error' ? 'bad' : x.level === 'warning' ? 'warn' : 'muted'}>{x.message}</li>)}</ul>
      {stale && <div className="actions left"><label className="file small-file">Download a fresh CSI from the e-filing portal and load it here:
        <input type="file" accept=".csi" onChange={e => onCsi(e.target.files?.[0])} /></label></div>}
      {csiMsg && <p className="ok">{csiMsg}</p>}
      {!s.csi && <p className="muted">No CSI loaded - the FVU will need one.</p>}</div>}
  </>);
}

export function DownloadStep({ s, next, selfTest }: StepProps) {
  const rv = useMemo(() => reviewModel(s.lines!), [s.lines]);
  const block = blockers(s, rv, !!selfTest?.ok, !sharedChallans(s).length || !!s.sharedOk);
  return (
    <section className="card">
      <h2>6. Download</h2>
      {block.length > 0 && <div className="banner error"><ul>{block.map(b => <li key={b}>{b}</li>)}</ul></div>}
      <div className="actions left">
        <button disabled={block.length > 0} onClick={() => { download(encodeReturn(s.lines!), s.fileName);
          void logTdsRun({ deductor: rv.deductor, tan: rv.tan, form: rv.form, fy: rv.fy, quarter: rv.quarter, totals: rv.totals as unknown as Record<string, unknown> }); }}>Download return file ({s.fileName})</button>
        <button className="ghost" onClick={async () => download(await makeReport(s, rv), s.fileName.replace(/\.txt$/, '_report.xlsx'))}>Download the return report (Excel)</button>
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
        { key: 'kind', label: 'Type' }, { key: 'code', label: 'Code' }, { key: 'where', label: 'Where', wrap: true },
        { key: 'description', label: 'FVU says', wrap: true }, { key: 'hint', label: 'Usually fixed by', wrap: true }]} />}
    </section>
  );
}
