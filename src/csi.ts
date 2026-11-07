/**
 * Phase 1 — checks on the CSI (Challan Status Inquiry) file before running Protean's FVU.
 *
 * A CSI file has one readable header line, e.g.
 *   2^ABCD12345E^EXAMPLE TRADERS & CO^9.5^2.191^1.2^00000000000000000001
 *   = challan count ^ TAN ^ name ^ FVU versions it supports ^ checksum
 * followed by one ENCODED line per challan. The challan lines cannot be read: only Protean's FVU
 * can match each challan against them. So this module checks what CAN be checked, and leaves the
 * per-challan match to the FVU (whose result fvuResult.ts reads back).
 *
 * New module — does not change the frozen core.
 */
export interface CsiInfo {
  challanCount: number;
  tan: string;
  name: string;
  fvuVersions: string[];          // FVU versions the file was prepared for, e.g. ['9.5', '2.191', '1.2']
  encodedLines: number;           // challan lines actually present
  downloadedOn: string | null;    // 'YYYY-MM-DD' from the file name (TAN + ddmmyy), if it follows that pattern
  originalName: string;
  validName: string;              // name the FVU accepts: letters/digits only, at most 25 characters
}

export type Level = 'error' | 'warning' | 'info';
export interface Finding { level: Level; message: string }

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function parseCsi(text: string, fileName: string): CsiInfo {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) throw new Error('The CSI file is empty');
  const h = lines[0].split('^');
  if (h.length < 3 || !/^\d+$/.test(h[0]) || !/^[A-Z]{4}\d{5}[A-Z]$/.test(h[1].trim()))
    throw new Error('This does not look like a CSI file (first line should start with the challan count and the TAN)');
  const tan = h[1].trim();
  const base = fileName.replace(/\.[^.]*$/, '');
  const m = base.match(new RegExp(`^${tan}(\\d{2})(\\d{2})(\\d{2})`));
  let downloadedOn: string | null = null;
  if (m) {
    const [d, mo, yy] = [Number(m[1]), Number(m[2]), 2000 + Number(m[3])];
    const dt = new Date(Date.UTC(yy, mo - 1, d));
    if (dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) downloadedOn = ymd(yy, mo, d);
  }
  const clean = base.replace(/[^A-Za-z0-9]/g, '');
  const stem = (m ? `${tan}${m[1]}${m[2]}${m[3]}` : clean).slice(0, 21);
  return {
    challanCount: Number(h[0]), tan, name: (h[2] ?? '').trim(), fvuVersions: h.slice(3, 6).map(s => s.trim()).filter(Boolean),
    encodedLines: lines.length - 1, downloadedOn, originalName: fileName, validName: `${stem}.csi`,
  };
}

/** Compare a CSI with the return lines (from the frozen core's buildStatement). */
export function checkCsi(csi: CsiInfo, returnLines: string[], targetFvu: string): Finding[] {
  const out: Finding[] = [];
  const recs = returnLines.map(l => l.split('^'));
  const bh = recs.find(f => f[1] === 'BH');
  if (!bh) return [{ level: 'error', message: 'No return built yet' }];
  const tan = bh[12], name = bh[18];
  if (csi.tan !== tan) out.push({ level: 'error', message: `The CSI is for TAN ${csi.tan}, the return is for ${tan}. Download the CSI for ${tan}.` });
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (csi.tan === tan && norm(csi.name) !== norm(name))
    out.push({ level: 'warning', message: `Name in the CSI ("${csi.name}") differs from the deductor name in the return ("${name}"). The FVU compares them; use the name as registered for the TAN.` });
  if (csi.encodedLines !== csi.challanCount)
    out.push({ level: 'warning', message: `The CSI says ${csi.challanCount} challans but contains ${csi.encodedLines} challan lines - the file may be damaged; download it again.` });

  const cds = recs.filter(f => f[1] === 'CD' && f[5] === 'N');                  // challans that are not nil
  const distinct = new Set(cds.map(f => `${f[14]}|${f[18]}|${f[16]}`)).size;   // BSR | date | serial
  if (distinct > csi.challanCount)
    out.push({ level: 'warning', message: `The return uses ${distinct} challans but the CSI lists only ${csi.challanCount}. Some challans are not in this CSI: download a CSI covering all challan dates, or check the challan details.` });
  else out.push({ level: 'info', message: `The CSI lists ${csi.challanCount} challan(s); the return uses ${distinct}. (The CSI may also hold challans used in other forms - that is normal.)` });

  if (csi.downloadedOn) {
    const toIso = (d: string) => `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
    const dates = cds.map(f => toIso(f[18])).sort();
    const latest = dates[dates.length - 1];
    if (latest) {
      const days = (Date.parse(csi.downloadedOn) - Date.parse(latest)) / 86400000;
      if (days < 0) out.push({ level: 'error', message: `The CSI was downloaded on ${csi.downloadedOn}, before the challan of ${latest} was paid. Download a fresh CSI.` });
      else if (days < 7) out.push({ level: 'warning', message: `The CSI was downloaded ${days} day(s) after the latest challan (${latest}). Banks can take several days to report a challan, so it may be missing - if the FVU reports "challan not in CSI", download a fresh CSI.` });
    }
  } else {
    out.push({ level: 'info', message: 'The CSI file name does not show its download date (normally TAN + ddmmyy), so its age cannot be checked.' });
  }
  if (!csi.fvuVersions.includes(targetFvu))
    out.push({ level: 'info', message: `This CSI lists FVU versions ${csi.fvuVersions.join(', ')}; this tool targets FVU ${targetFvu}.` });
  if (csi.validName !== csi.originalName)
    out.push({ level: 'info', message: `Save the CSI as "${csi.validName}" - the FVU accepts only letters and digits, at most 25 characters.` });
  return out;
}
