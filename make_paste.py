"""Bundle the AI Studio brief and the tested core into ONE file to paste into Google AI Studio Build.
Run from the repo root after any change to src:  py -3 make_paste.py
Writes AISTUDIO_PASTE.md.
"""
from pathlib import Path

WEB = Path(__file__).resolve().parent
parts = [(WEB / 'AISTUDIO_BRIEF.md').read_text(encoding='utf-8'), '\n\n---\n\n# Core files (put in src/core/ exactly as given)\n']
for name, lang in (('protean.ts', 'ts'), ('inputWorkbook.ts', 'ts'), ('review.ts', 'ts'), ('template_columns.json', 'json'),
                   ('csi.ts', 'ts'), ('fvuResult.ts', 'ts'), ('sectionCodes.ts', 'ts'), ('sectionMap.json', 'json'), ('challanMatch.ts', 'ts'), ('challanPdf.ts', 'ts'), ('aiExceptions.ts', 'ts')):
    parts.append(f'\n## src/core/{name}\n\n```{lang}\n{(WEB / "src" / name).read_text(encoding="utf-8").rstrip()}\n```\n')
out = WEB / 'AISTUDIO_PASTE.md'
out.write_text(''.join(parts), encoding='utf-8')
print(f'written {out} ({out.stat().st_size:,} bytes)')
