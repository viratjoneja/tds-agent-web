import * as XLSX from 'xlsx';

/**
 * Excel percentage cells in "Rate %": Excel stores 2% as 0.02 and only shows it as 2%.
 * The engine expects the rate as a plain number (2), so on upload any Rate % cell formatted
 * as a percentage is turned into the plain rate (0.02 -> 2). Plain numbers (2, 10, 0.1) are
 * left alone - 0.1% is a real rate, so a bare fraction is never guessed at.
 * Returns the workbook unchanged (same bytes) when no cell needed it.
 */
/**
 * Tax in whole rupees (v2.1): TDS/TCS is deducted and deposited in whole rupees, but a Tax column
 * made by a formula (Amount x Rate %) carries paise. Each row's Tax and "Tax deposited" are rounded
 * to the nearest rupee (the formula is replaced by its rounded value). Returns how many cells changed.
 */
export function roundTax(bytes: Uint8Array): { bytes: Uint8Array; rows: number } {
  const wb = XLSX.read(bytes, { type: 'array' });
  const ws = wb.Sheets['Deductees'];
  if (!ws || !ws['!ref']) return { bytes, rows: 0 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const cols: number[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = String(ws[XLSX.utils.encode_cell({ r: range.s.r, c })]?.v ?? '').trim();
    if (h === 'Tax' || h === 'Tax deposited (blank = Tax)') cols.push(c);
  }
  const changed = new Set<number>();
  for (let r = range.s.r + 1; r <= range.e.r; r++) for (const c of cols) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number') continue;
    const v = Math.round(cell.v);
    if (Math.abs(v - cell.v) < 0.005) continue;
    cell.v = v; delete cell.w; delete cell.f;
    changed.add(r);
  }
  if (!changed.size) return { bytes, rows: 0 };
  return { bytes: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), rows: changed.size };
}

export function normaliseRates(bytes: Uint8Array): { bytes: Uint8Array; rows: number } {
  const wb = XLSX.read(bytes, { type: 'array', cellNF: true });
  const ws = wb.Sheets['Deductees'];
  if (!ws || !ws['!ref']) return { bytes, rows: 0 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  let col = -1;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    if (h && String(h.v ?? '').trim() === 'Rate %') { col = c; break; }
  }
  if (col < 0) return { bytes, rows: 0 };
  let rows = 0;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: col })] as XLSX.CellObject | undefined;
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number') continue;
    const pct = (typeof cell.z === 'string' && cell.z.includes('%')) || (typeof cell.w === 'string' && cell.w.trim().endsWith('%'));
    if (!pct) continue;
    cell.v = Math.round(cell.v * 100 * 10000) / 10000;   // 4 decimals, as in the return file
    cell.z = 'General';
    delete cell.w;
    delete cell.f;                                         // keep the value, not a formula that would give the fraction again
    rows++;
  }
  if (!rows) return { bytes, rows: 0 };
  return { bytes: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), rows };
}
