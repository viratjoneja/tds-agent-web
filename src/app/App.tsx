import { useEffect, useState } from 'react';
import { AGENT_VERSION, TARGET_FVU, checkFileName, deductorFromFvu, type Deductor, type Form } from '../protean.ts';
import { readInputWorkbook } from '../inputWorkbook.ts';
import { parseCsi, type CsiInfo } from '../csi.ts';
import { makeTemplateFull } from '../challanMatch.ts';
import { runSelfTest, type SelfTest } from './selfTest.ts';
import { aiAvailable } from './ai.ts';
import { download, readBytes, readLatin1 } from './util.ts';
import { SectionsStep } from './Sections.tsx';
import { ChallansStep } from './Challans.tsx';
import { ReviewStep, DownloadStep, FvuStep } from './Review.tsx';

declare const __APP_VERSION__: string;
declare const __ENGINE_HASH__: string;

export interface Session {
  form: Form; fy: number; quarter: 1 | 2 | 3 | 4;
  workbook: { name: string; bytes: Uint8Array } | null;
  fvu: { name: string; deductor: Deductor } | null;
  deductor: Deductor | null;                         // from the workbook's Deductor sheet, else the .fvu
  rrr: string; fileName: string;
  csi: { info: CsiInfo; bytes: Uint8Array } | null;
  withSections: Uint8Array | null;                   // after the Section codes step
  linked: Uint8Array | null;                         // after the Challans step
  lines: string[] | null;                            // built return
}
export interface StepProps { s: Session; set: (p: Partial<Session>) => void; next: () => void; ai: boolean; selfTest: SelfTest | null }

const STEPS = ['Setup', 'Upload', 'Section codes', 'Challans', 'Review', 'Download', 'FVU results'];
const fresh = (): Session => ({ form: '140', fy: 2026, quarter: 2, workbook: null, fvu: null, deductor: null, rrr: '', fileName: '', csi: null,
  withSections: null, linked: null, lines: null });

export function App() {
  const [s, setS] = useState<Session>(fresh);
  const [step, setStep] = useState(0);
  const [selfTest, setSelfTest] = useState<SelfTest | null>(null);
  const [server, setServer] = useState<{ ai: boolean; model: string }>({ ai: false, model: '' });
  const [neverAi, setNeverAi] = useState(false);
  useEffect(() => { runSelfTest().then(setSelfTest); aiAvailable().then(setServer); }, []);

  // a change to an earlier step throws away everything built after it
  const set = (p: Partial<Session>) => setS(old => {
    const n = { ...old, ...p };
    if ('form' in p || 'fy' in p || 'quarter' in p || 'workbook' in p || 'fvu' in p) Object.assign(n, { withSections: null, linked: null, lines: null });
    if ('withSections' in p) Object.assign(n, { linked: null, lines: null });
    if ('linked' in p || 'rrr' in p) n.lines = null;
    return n;
  });
  const reached = [true, true, !!s.workbook && !!s.deductor, !!s.withSections, !!s.linked, !!s.lines, !!s.lines];
  const props: StepProps = { s, set, next: () => setStep(k => k + 1), ai: server.ai && !neverAi, selfTest };

  return (
    <div className="app">
      <header>
        <div>
          <h1>TDS / TCS Return Builder</h1>
          <p className="sub">Protean e-TDS/TCS regular statement · FVU {TARGET_FVU} layout</p>
        </div>
        <div className="head-actions">
          <label className="check"><input type="checkbox" checked={neverAi} onChange={e => setNeverAi(e.target.checked)} /> Never use AI</label>
          <button className="ghost" onClick={() => { setS(fresh()); setStep(0); }}>Start over</button>
        </div>
      </header>

      <nav className="steps" aria-label="Steps">
        {STEPS.map((t, i) => (
          <button key={t} className={`step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} disabled={!reached[i]} onClick={() => setStep(i)}>
            <span className="n">{i + 1}</span>{t}
          </button>))}
      </nav>

      {selfTest && !selfTest.ok && (
        <div className="banner error">
          <b>Engine self-test failed - return files cannot be downloaded from this deployment.</b>
          <ul>{selfTest.checks.filter(c => !c.ok).map(c => <li key={c.name}>{c.name}</li>)}</ul>
          This deployment is not running the tested engine. Re-import the app from GitHub.
        </div>)}

      <main>
        {step === 0 && <SetupStep {...props} />}
        {step === 1 && <UploadStep {...props} />}
        {step === 2 && <SectionsStep {...props} />}
        {step === 3 && <ChallansStep {...props} />}
        {step === 4 && <ReviewStep {...props} />}
        {step === 5 && <DownloadStep {...props} />}
        {step === 6 && <FvuStep {...props} />}
      </main>

      <footer>
        <p>Prepares draft return files only. It is not tax advice. A qualified person must review every return before it is filed.
          Built for Protean FVU version {TARGET_FVU}; if Protean releases a newer FVU, check for an updated version of this tool.</p>
        <p className="meta">
          App {__APP_VERSION__} · core {AGENT_VERSION} · engine <code>{__ENGINE_HASH__}</code> · self-test{' '}
          {selfTest === null ? 'running...' : selfTest.ok ? <span className="ok">passed</span> : <span className="bad">FAILED</span>}
          {' '}· AI {neverAi ? 'off (never use AI)' : server.ai ? `available (${server.model})` : 'not set up on this server'}
        </p>
      </footer>
    </div>
  );
}

function SetupStep({ s, set, next }: StepProps) {
  return (
    <section className="card">
      <h2>1. Setup</h2>
      <div className="grid3">
        <label>Form
          <select value={s.form} onChange={e => set({ form: e.target.value as Form })}>
            <option value="138">138 - TDS on salary (24Q)</option>
            <option value="140">140 - TDS other than salary (26Q)</option>
            <option value="143">143 - TCS (27EQ)</option>
          </select></label>
        <label>Financial year
          <select value={s.fy} onChange={e => set({ fy: Number(e.target.value) })}>
            {[2026, 2027, 2028, 2029, 2030].map(y => <option key={y} value={y}>{y}-{String(y + 1).slice(2)}</option>)}
          </select></label>
        <label>Quarter
          <select value={s.quarter} onChange={e => set({ quarter: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
            {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
          </select></label>
      </div>
      <div className="help">
        <p><b>Input workbook.</b> Fill the sheets <b>Challans</b> and <b>Deductees</b>{s.form === '138' && <> (and <b>Salary (Q4)</b> for Q4)</>}.
          Fill the <b>Deductor</b> sheet, or upload last quarter's accepted <code>.fvu</code> in the next step.</p>
        <ul>
          <li><b>Section</b>: write the section as in your working (e.g. "194C", "393(1)-6(i).D(a)", "Contractor") in <i>Section (as in working)</i>; the tool works out the 4-digit code. Or type the code yourself.</li>
          <li><b>Tax</b>: the tax actually deducted. If you use a formula, it is <code>=Amount*Rate/100</code>.</li>
          <li><b>Challan #</b> on each deductee row is optional - the tool matches rows to challans. On the Challans sheet give each FULL challan (even if part of it is for another form).</li>
          <li><b>Major head</b> and <b>Section breakup</b> on challans are optional - or upload the challan receipt PDFs in step 4 and the tool reads them.</li>
        </ul>
      </div>
      <div className="actions">
        <button className="ghost" onClick={() => download(makeTemplateFull(s.form), `TDS_input_${s.form}.xlsx`)}>Download blank input workbook</button>
        <button onClick={next}>Next</button>
      </div>
    </section>
  );
}

function UploadStep({ s, set, next }: StepProps) {
  const [err, setErr] = useState<string[]>([]);
  const [note, setNote] = useState<string[]>([]);
  const rrrOk = s.rrr === '' || /^\d{15}$/.test(s.rrr);
  const nameErr = s.fileName ? checkFileName(s.fileName) : null;

  const onWorkbook = async (f?: File) => {
    if (!f) return;
    setErr([]); setNote([]);
    const bytes = await readBytes(f);
    let deductor: Deductor | null = null;
    try { deductor = readInputWorkbook(bytes, s.form, s.quarter).deductor; }
    catch (e) { setErr([`Could not read the workbook: ${(e as Error).message}`]); return; }
    const d = deductor ?? s.fvu?.deductor ?? null;
    set({ workbook: { name: f.name, bytes }, deductor: d, fileName: s.fileName || (d ? `${d.tan.slice(0, 3)}${s.form}Q${s.quarter}.txt` : '') });
    if (!deductor) setNote(['The Deductor sheet is empty - upload last quarter\'s .fvu below, or fill the sheet.']);
  };
  const onFvu = async (f?: File) => {
    if (!f) return;
    setErr([]);
    try {
      const { deductor, form } = deductorFromFvu(await readLatin1(f));
      if (form !== s.form) { setErr([`That .fvu is for Form ${form}, not Form ${s.form}.`]); return; }
      let fromSheet: Deductor | null = null;
      if (s.workbook) try { fromSheet = readInputWorkbook(s.workbook.bytes, s.form, s.quarter).deductor; } catch { /* shown on upload */ }
      const d = fromSheet ?? deductor;
      set({ fvu: { name: f.name, deductor }, deductor: d, fileName: s.fileName || `${d.tan.slice(0, 3)}${s.form}Q${s.quarter}.txt` });
    } catch (e) { setErr([`Not a readable .fvu: ${(e as Error).message}`]); }
  };
  const onCsi = async (f?: File) => {
    if (!f) return;
    setErr([]);
    try { const bytes = await readBytes(f); set({ csi: { info: parseCsi(new TextDecoder('latin1').decode(bytes), f.name), bytes } }); }
    catch (e) { setErr([`Not a CSI file: ${(e as Error).message}`]); }
  };

  return (
    <section className="card">
      <h2>2. Upload</h2>
      <p className="privacy">Your files are processed in your browser and are never uploaded.</p>
      <div className="grid2">
        <label className="file">Filled input workbook (.xlsx) <b>required</b>
          <input type="file" accept=".xlsx,.xls" onChange={e => onWorkbook(e.target.files?.[0])} />
          {s.workbook && <span className="ok">✓ {s.workbook.name}</span>}</label>
        <label className="file">Last quarter's accepted .fvu, same form (optional - gives the deductor details)
          <input type="file" accept=".fvu,.txt" onChange={e => onFvu(e.target.files?.[0])} />
          {s.fvu && <span className="ok">✓ {s.fvu.name}</span>}</label>
        <label>Previous statement RRR number
          <input value={s.rrr} onChange={e => set({ rrr: e.target.value.trim() })} placeholder="15 digits, starts 7700" inputMode="numeric" />
          <small>On the previous quarter's acknowledgement (not the e-filing acknowledgement number). Leave blank only if this form was never filed before.</small>
          {!rrrOk && <span className="bad">Must be 15 digits.</span>}</label>
        <label>Output file name
          <input value={s.fileName} onChange={e => set({ fileName: e.target.value.trim() })} placeholder="e.g. ABC140Q2.txt" />
          {nameErr && <span className="bad">{nameErr}</span>}</label>
        <label className="file">CSI file from the e-filing portal (.csi, optional)
          <input type="file" accept=".csi" onChange={e => onCsi(e.target.files?.[0])} />
          {s.csi && <span className="ok">✓ {s.csi.info.originalName}: TAN {s.csi.info.tan}, {s.csi.info.challanCount} challans</span>}
          <small>The CSI lists the challans the bank reported. Its challan lines are encoded, so only Protean's FVU can match each challan; this tool checks the TAN, the number of challans and whether the CSI is recent enough.</small></label>
      </div>
      {s.deductor && <p className="ok">Deductor: {s.deductor.entity.name} ({s.deductor.tan})</p>}
      {[...err].map(m => <p key={m} className="bad">{m}</p>)}
      {note.map(m => <p key={m} className="warn">{m}</p>)}
      {s.rrr === '' && s.workbook && <p className="warn">No RRR number: the file will say no earlier statement was filed for this form.</p>}
      <div className="actions">
        <button disabled={!s.workbook || !s.deductor || !rrrOk || !!nameErr || !s.fileName} onClick={next}>Next: section codes</button>
      </div>
    </section>
  );
}
