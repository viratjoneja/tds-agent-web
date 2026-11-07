# TDS Agent — Web

Browser version of the TDS/TCS return tool: turns a filled input workbook into a Protean (NSDL) return text file for Forms 138, 140 and 143, with checks and a review before the user validates with Protean's FVU on their own PC. Built into a web app with Google AI Studio "Build" (`AISTUDIO_PASTE.md`).

**Private repository.** Separate from `tds-agent` (the Claude Code agent used for filed returns) on purpose: nothing here may change that agent, and nothing here depends on it.

## Rules for this repo

1. **The core is frozen.** `src/protean.ts`, `src/inputWorkbook.ts`, `src/review.ts` and `src/template_columns.json` are the tested core from tds-agent 2.6.0, whose return files Protean's FVU 1.2 accepted. Do not edit them. New features go in **new files** that use the core.
2. **Parity must always pass:** `node test/parity.test.ts` checks the core still produces byte-for-byte the files in `test/fixtures` (made by the Python tool, frozen here — never regenerate them).
3. **No client data in this repo** — fixtures are made up. Real-data checks run on a local PC only.
4. **Privacy in the app:** everything runs in the browser; client files are not uploaded. Any future AI feature must send only masked data and ask the user first.

## Layout

```
src/                  frozen core (see rule 1) + new feature modules
test/parity.test.ts   core parity test
test/fixtures/        frozen golden files (made-up data)
AISTUDIO_BRIEF.md     build brief for Google AI Studio
AISTUDIO_PASTE.md     brief + code in one file (regenerate: py -3 make_paste.py)
```

## Setup

Node 22.6 or later. `npm install`, then `node test/parity.test.ts`.

## Plan

| Phase | What | Status |
|---|---|---|
| 0 | Separate repo with the frozen core and its tests | done |
| 1 | CSI checks (TAN, challan count, stale CSI, file name) and FVU result reader | done (1.1.0) |
| 2 | Section codes worked out from the section as written in the working | planned |
| 3 | Rows matched to challans by rules; challan matching review page | planned |
| 4 | AI layer: read challan PDFs; propose adjustments for exceptions (needs decisions: provider, data handling) | planned |
| 5 | Tests on every rule; local checks on real Q2 cases | ongoing |
