# TDS Agent — Web

Web app that turns a filled input workbook into a Protean (NSDL) e-TDS/TCS return text file for Forms 138, 140 and 143: section codes worked out from the working, challans matched and split automatically, a review before the FVU, and FVU results explained row by row. Everything runs in the browser; client files are never uploaded.

**Engine fingerprint for this release: `ecea70457ab6`** — the app's footer must show the same value and "self-test passed". If it does not, the deployment is not running the tested engine.

## Deploy with Google AI Studio (Build)

1. In AI Studio → Build, click **+** in the prompt box → **Import from GitHub**, connect your GitHub account and choose `viratjoneja/tds-agent-web`.
2. Deploy (Cloud Run) as usual. For the optional AI buttons, set the secret **`GEMINI_API_KEY`** (a billing-enabled key, so Google does not use the data for training). Optional `GEMINI_MODEL` (default `gemini-flash-latest`).
3. Open the app and check the footer: engine `ecea70457ab6`, **self-test passed**. Quick test: a workbook whose Tax column is `=Amount*Rate` (no /100) must stop at step 4 with "Tax looks like Amount x Rate % without dividing by 100".
4. Use AI Studio only for look and feel. Do not let it change the engine files (listed in `engine-files.mjs`); see `AGENTS.md`. After each new release here, pull the latest from GitHub in AI Studio's GitHub settings.

## Office portal (tools.ykjoneja.com/tds)

On branch `claude/office-portal` the app runs as the Cloud Run service `tds` behind TRUE GST's Firebase Hosting, at `/tds/`:
- Only signed-in `@ykjoneja.com` Google Workspace accounts can use it (`src/app/AuthGate.tsx`); `/api/gemini` checks the login token on the server (`auth.mjs`).
- Each downloaded return adds one line to the office run log (deductor, TAN, form, period, totals - no workbook or deductee rows) (`src/app/office.ts`).
- `BASE_PATH` (default `/tds`) sets where it is served; `BASE_PATH=/` serves it at the root as before.
- Engine files are unchanged: fingerprint `ecea70457ab6`.

## Run it anywhere else (Cloud Run, a VM, your PC)

```
npm install
npm run build
GEMINI_API_KEY=... npm start        # http://localhost:8080 ; without the key the AI buttons are simply off
```
`server.mjs` (no dependencies) serves the app and the one AI route `/api/gemini`, which holds the key, refuses anything that looks like a PAN/TAN, and stores nothing. Development: `npm run dev`.

**Private repository.** Separate from `tds-agent` (the Claude Code agent used for filed returns) on purpose: nothing here may change that agent, and nothing here depends on it.

## Rules for this repo

1. **The core is frozen.** `src/protean.ts`, `src/inputWorkbook.ts`, `src/review.ts` and `src/template_columns.json` are the tested core from tds-agent 2.6.0, whose return files Protean's FVU 1.2 accepted. Do not edit them. New features go in **new files** that use the core.
2. **Parity must always pass:** `node test/parity.test.ts` checks the core still produces byte-for-byte the files in `test/fixtures` (made by the Python tool, frozen here — never regenerate them).
3. **No client data in this repo** — fixtures are made up. Real-data checks run on a local PC only.
4. **Privacy in the app:** everything runs in the browser; client files are not uploaded. Any future AI feature must send only masked data and ask the user first.

## Layout

```
src/*.ts, *.json      the engine: frozen core (rule 1) + feature modules - listed in engine-files.mjs
src/app/              the screens (React) - safe to restyle
server.mjs            serves the app + /api/gemini (key stays on the server)
test/                 parity + phase tests; fixtures are made-up, frozen golden files
AISTUDIO_*.md         old paste-in brief (superseded by Import from GitHub; kept for reference)
```

## Tests

Node 22.6 or later: `npm install`, `npm test` (engine), `npm run typecheck`, `npm run engine-hash` (prints the fingerprint above).

## Plan

| Phase | What | Status |
|---|---|---|
| 0 | Separate repo with the frozen core and its tests | done |
| 1 | CSI checks (TAN, challan count, stale CSI, file name) and FVU result reader | done (1.1.0) |
| 2 | Section codes worked out from the section as written in the working | done (1.2.0) |
| 3 | Rows matched to challans by rules; challan matching review page | done (1.3.0) |
| 4 | Challan receipt PDFs read by rules in the browser (Gemini fallback, masked); Gemini proposals for open challan points, masked, checked by rules, applied only on approval | done (1.4.0) |
| 4.5 | Automatic challan split: month plan (interest shows the month paid late), same-date 0020/0021 pairs, overflow to top-up challans, salary share kept; Tax column check (missing /100) | done (1.5.0) |
| 6 | Full app in the repo (screens, Gemini route, self-test, engine fingerprint) for Import from GitHub | done (2.0.0) |
| 6.1 | Rate % cells formatted as Excel percentages (0.02 shown as 2%) read as 2 on upload | done (2.0.1) |
| 5 | Tests on every rule; local checks on real Q2 cases | ongoing |
