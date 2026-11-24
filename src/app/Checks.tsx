import { useState } from 'react';
import type { DataCheckResult } from '../dataChecks.ts';
import { sectionName } from './sectionNames.ts';
import { inr } from './util.ts';

const dmy = (d: string) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const sec = (code: string) => (/^\d{4}$/.test(code) ? sectionName(code) : code);

/** Data checks on the uploaded workbook: what must be fixed, what to check, and late deductions - by workbook row. */
export function DataChecks({ r, onDownload }: { r: DataCheckResult; onDownload?: () => void }) {
  const [showWarn, setShowWarn] = useState(false);
  const interest = r.late.reduce((a, l) => a + l.interest, 0);
  if (!r.errors.length && !r.warnings.length && !r.late.length)
    return <div className="banner ok-banner"><b>Data checks passed</b> - {r.rows} rows: PANs, amounts, tax and dates all fit Q-range and the year.</div>;
  return (
    <div className="checks">
      {r.errors.length > 0 && (
        <div className="banner error">
          <b>{r.errors.length} thing(s) to fix in the workbook before going on</b> - correct them in Excel and upload it again:
          <IssueTable list={r.errors} />
        </div>)}
      {r.late.length > 0 && (
        <div className="banner warn">
          <b>{r.late.length} late deduction(s)</b> - paid / credited in an earlier quarter, tax deducted in this one. They are reported as they are
          (Protean's FVU accepts this), but <b>interest for late deduction</b> applies: about <b>Rs {inr(interest, 0)}</b> in total (1% a month or part).
          <div className="scroll"><table className="compact"><thead><tr><th>Row</th><th>Payee</th><th className="wrap">Section</th><th>Paid / credited</th><th>Deducted</th><th className="num">Tax</th><th className="num">Months</th><th className="num">Interest (about)</th></tr></thead>
            <tbody>{r.late.map(l => <tr key={l.row}><td>{l.row}</td><td>{l.name} <small className="muted">{l.pan}</small></td><td className="wrap"><small>{sec(l.section)}</small></td>
              <td>{dmy(l.paid)}</td><td>{dmy(l.deducted)}</td><td className="num">{inr(l.tax, 0)}</td><td className="num">{l.months}</td><td className="num">{inr(l.interest, 0)}</td></tr>)}</tbody></table></div>
          <small>Pay the interest with the next challan (it goes in the challan's interest column), or check the dates if the payment was in fact made in this quarter.</small>
        </div>)}
      {r.warnings.length > 0 && (
        <div className="banner">
          <button className="link" onClick={() => setShowWarn(v => !v)}>{showWarn ? '▾' : '▸'} {r.warnings.length} point(s) to check</button> - not blocking.
          {showWarn && <IssueTable list={r.warnings} />}
        </div>)}
      {onDownload && <div className="actions left"><button className="ghost small" onClick={onDownload}>Download the data-check report (Excel)</button></div>}
    </div>);
}

function IssueTable({ list }: { list: DataCheckResult['errors'] }) {
  return (
    <div className="scroll"><table className="compact"><thead><tr><th>Row</th><th>Payee</th><th>Field</th><th>Value</th><th className="wrap">Problem</th><th className="wrap">What to do</th></tr></thead>
      <tbody>{list.map((i, k) => <tr key={k}><td>{i.row}</td><td>{i.name} <small className="muted">{i.pan}</small></td><td>{i.field}</td><td>{i.value}</td>
        <td className="wrap">{i.message}</td><td className="wrap"><small>{i.fix}</small></td></tr>)}</tbody></table></div>);
}
