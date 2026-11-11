import * as XLSX from 'xlsx';

export const inr = (v: unknown, dp = 2) =>
  typeof v === 'number' ? v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : String(v ?? '');

export function download(bytes: Uint8Array | ArrayBuffer | string, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const readBytes = async (f: File) => new Uint8Array(await f.arrayBuffer());
export const readLatin1 = async (f: File) => new TextDecoder('latin1').decode(await f.arrayBuffer());

/** Remove all challans from the Challans sheet (keeps the headings). Used before adding challans read from receipts. */
export function clearChallans(bytes: Uint8Array): Uint8Array {
  const wb = XLSX.read(bytes, { type: 'array' });
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Challans'], { header: 1 })[0] ?? []) as unknown[];
  wb.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([hdr]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

/** Number of deductee rows that already have a challan number typed in. */
export function typedChallanLinks(bytes: Uint8Array): number {
  const wb = XLSX.read(bytes, { type: 'array' });
  const g = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Deductees'], { header: 1, defval: null });
  const i = ((g[0] ?? []) as unknown[]).map(String).indexOf('Challan #');
  return i < 0 ? 0 : g.slice(1).filter(r => r[i] !== null && r[i] !== '').length;
}

/** Review tables to an .xlsx. */
export function reviewWorkbook(sheets: Record<string, Record<string, unknown>[]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
