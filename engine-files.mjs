// The tested engine. The app shows a fingerprint of these files in its footer so anyone can see
// it is running exactly the released engine (compare with README.md). Line endings are ignored.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ENGINE_FILES = [
  'protean.ts', 'inputWorkbook.ts', 'review.ts', 'template_columns.json',          // frozen core (tds-agent 2.6.0)
  'csi.ts', 'fvuResult.ts', 'sectionCodes.ts', 'sectionMap.json',
  'challanMatch.ts', 'challanPdf.ts', 'aiExceptions.ts',
];

export function engineHash(root = dirname(fileURLToPath(import.meta.url))) {
  const h = createHash('sha256');
  for (const f of ENGINE_FILES) h.update(f + '\n' + readFileSync(join(root, 'src', f), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 12);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(engineHash());
