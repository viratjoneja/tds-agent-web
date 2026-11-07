# Build brief: TDS / TCS Return File Builder (for Google AI Studio "Build")

## What to build

A single-page web app, **React + TypeScript + Vite**, that turns a filled Excel input workbook into an Indian quarterly TDS/TCS **return text file** in Protean's (NSDL) format, ready for validation with Protean's free File Validation Utility (FVU). Forms supported (Income-tax Act 2025 numbering, old numbers in brackets):

- **Form 138** (24Q) — TDS on salary, Q1 to Q4 (Q4 includes each employee's annual salary details)
- **Form 140** (26Q) — TDS on payments other than salary
- **Form 143** (27EQ) — TCS

## The engine is provided — do not rewrite it

Four files follow this brief. Put them in `src/core/` **exactly as given** and import from them. They are a tested port of a Python tool whose output Protean's FVU 1.2 has accepted on live returns; the TypeScript version is proven byte-for-byte identical to it. Do not change formatting, rounding, field order, dates or checks.

| File | Use |
|---|---|
| `src/core/protean.ts` | `buildStatement(...)` → lines of the return file; `checkStatement(lines, fyStart, quarter)` → problems (must be empty); `encodeReturn(lines)` → bytes to download; `checkFileName(name)`; `deductorFromFvu(text)` |
| `src/core/inputWorkbook.ts` | `makeTemplate(form)` → blank input .xlsx bytes; `readInputWorkbook(bytes, form, quarter)` → `{challans, deductor, salary, missing}` |
| `src/core/review.ts` | `reviewModel(lines)` → totals, problems, points to review, deductor details, challan / deductee / salary tables |
| `src/core/template_columns.json` | column headings shared with the Python tool |
| `src/core/csi.ts` | **Phase 1.** `parseCsi(text, fileName)` → CSI header info (challan count, TAN, name, download date, valid file name); `checkCsi(csi, lines, TARGET_FVU)` → findings `{level: 'error'│'warning'│'info', message}` |
| `src/core/sectionCodes.ts` + `src/core/sectionMap.json` | **Phase 2.** `makeTemplateWithSection(form)` → blank workbook with a "Section (as in working)" column; `suggestSections(bytes, form, deductorType)` → one suggestion per Deductees row `{row, pan, name, text, rate, result: {status: 'given'│'auto'│'choose'│'error', code, reason, options, rateNote}}`; `applySections(bytes, [{row, code}])` → workbook bytes with codes filled in, for `readInputWorkbook`; `SECTION_MAP[code]` → description |
| `src/core/challanMatch.ts` | **Phase 3.** `makeTemplateFull(form)` → blank workbook with the Phase 2 section column and two optional Challans columns (major head, section breakup); `readForMatching(bytes)` → `{challans, rows, problems}`; `matchChallans(challans, rows)` → `{rows: [{row, challanNo, status: 'given'│'matched'│'exception', reason}], challans: [{no, tax, usedHere, balance, interestPaid, interestDue, notes}], exceptions: [{kind, rows, challans, message}]}`; `applyChallanMatches(bytes, [{row, challanNo}])` → workbook bytes with "Challan #" filled |
| `src/core/fvuResult.ts` | **Phase 1.** `readErrFile(text, lines)`, `readWarningFile(html, lines)` → issues tied to the challan / deductee / employee row with a plain-English `hint`; `readStatistics(html)`, `compareStatistics(stats, rv.totals)` |

The core imports each other with `.ts` extensions (e.g. `from './protean.ts'`): enable `"allowImportingTsExtensions": true` and `"noEmit": true` in `tsconfig.json` (Vite handles this), or remove the extensions if your setup needs that — change nothing else. The JSON import uses `with { type: 'json' }`; if the toolchain objects, change it to a plain `import cols from './template_columns.json'`.

**Dependency:** SheetJS, installed from its official CDN (the npm-registry copy is outdated and has a known parser vulnerability):
```
npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

## Privacy rules (mandatory)

- **All processing happens in the browser.** Files are read with `FileReader` / `file.arrayBuffer()` and never uploaded. **No backend, no database, no storage** (not even localStorage) of file contents.
- **Gemini is called in exactly two places, both optional, both masked (Phase 4 below)**: reading a challan receipt the rules could not read, and proposing challans for rows the rules left open. Nothing else ever goes to Gemini or any other API - never the workbook, PANs, TANs, names, BSR codes or challan serial numbers. The engine itself is deterministic and needs no AI.
- Before each Gemini call, **show the user exactly what will be sent** (the masked payload) and send only after they click **"Send to Gemini"**. A setting "Never use AI" (default off) hides both buttons.
- **The Gemini API key must never reach the browser.** Calls go through a small server route (AI Studio's Cloud Run deployment with the key as a server secret, or `/api/gemini` on the hosting site) that forwards the request body unchanged and stores nothing. Use a paid-tier (billing-enabled) key so Google does not use the data to improve its products. Use the current Gemini Flash model with `responseMimeType: 'application/json'` and the `responseSchema` the core gives.
- No analytics or logging that captures file contents.
- Show this line near the upload box: *"Your files are processed in your browser and are never uploaded."*

## Screens and flow

1. **Setup** — choose Form (138 / 140 / 143), Financial year (start year, e.g. 2026 for 2026-27; offer 2026 onwards), Quarter (Q1–Q4).
   Button **"Download blank input workbook"** → `makeTemplate(form)` saved as `TDS_input_<form>.xlsx`. Short help text: fill sheets Challans and Deductees (and "Salary (Q4)" for Form 138 Q4); fill the Deductor sheet **or** upload last quarter's `.fvu` below; section codes are the 4-digit codes (1002 salary, 1023 contractor, 1073 TCS on scrap …).

2. **Upload**
   - Filled input workbook (.xlsx) — required.
   - Last quarter's accepted `.fvu` of the **same form** — optional; read as text with `TextDecoder('latin1')`; `deductorFromFvu(text)` gives the deductor; if its `form` differs from the chosen form, show an error.
   - **Previous statement RRR number** — text box, 15 digits starting 7700 (validate `^\d{15}$`), help: "on the e-filing acknowledgement of the previous quarter's return (not the 'e-Filing Acknowledgement Number'). Leave blank only if this form was never filed before."
   - **Output file name** — default `<first 3 letters of TAN><form>Q<n>.txt`, validate with `checkFileName` (max 12 characters incl. .txt).

3. **Read** — `readInputWorkbook(bytes, form, quarter)`. If `missing` is not empty, list every item and stop ("Fill these in the workbook and upload again"). If there is no deductor (empty Deductor sheet and no .fvu), ask for one. If the RRR is blank, warn that the file will say "no earlier statement filed".

4. **Build and check** — `lines = buildStatement({ form, deductor, challans, fyStart, quarter, prevToken: rrr || null, salary: salary ?? undefined })`; wrap in try/catch and show errors plainly. Then `rv = reviewModel(lines)`.

5. **Review** (the user must look at this before validating). Tabs:
   - **Summary**: deductor, TAN, FY, quarter, previous RRR, totals (`rv.totals`), and for Form 138 Q4 the salary totals. If `rv.problems` is not empty, show them in red and **disable the download**. Show `rv.pointsToReview` in amber.
   - **Deductor** (`rv.deductorDetails`), **Challans** (`rv.challans`; highlight rows with `balanceForOtherForms > 0` in amber with the note "part of this challan belongs to another form"), **Deductees** (`rv.deductees`), **Salary details** (`rv.salary`, Form 138 Q4 only; highlight `shortfall > 1`).
   - Tables: sortable, filterable, amounts in Indian format (`toLocaleString('en-IN', {minimumFractionDigits: 2})`), totals row.

6. **Download**
   - **Return file**: `new Blob([encodeReturn(lines)], {type: 'application/octet-stream'})`, saved under the chosen name. Do not alter the bytes.
   - **Review workbook**: export the review tabs to .xlsx with SheetJS (`XLSX.utils.json_to_sheet` per tab).

7. **Next steps panel** (static text):
   1. Download Protean's free e-TDS/TCS FVU from Protean's TIN website, unzip it, and run `TDS_STANDALONE_FVU_<version>.jar` (needs Java 8).
   2. Give it the return `.txt`, the CSI file for the TAN (download from the income-tax e-filing portal; rename it so the name has only letters/digits, max 25 characters) and an output folder.
   3. If the FVU reports errors, fix the input workbook and rebuild — never edit the `.txt` by hand.
   4. Upload the `.fvu` on the e-filing portal (DSC/EVC) yourself.
   5. Form 138 Q4: dates of employment and challans cannot be in the future, so a Q4 return validates only after 31 March.

## Phase 1 additions (CSI checks and FVU results)

**A. CSI upload — add to step 2 (Upload).** Optional file input "CSI file from the e-filing portal (.csi)". Read it as text (`TextDecoder('latin1')`), `csi = parseCsi(text, file.name)` (show its error plainly if it is not a CSI). After the return is built, run `checkCsi(csi, lines, TARGET_FVU)` and show the findings on the Review → Summary tab: `error` in red (**disable the return-file download** while any CSI error exists), `warning` in amber, `info` in grey. Explain under the upload box: *"The CSI lists the challans the bank reported. Its challan lines are encoded, so only Protean's FVU can match each challan; this tool checks the TAN, the number of challans and whether the CSI is recent enough."* Add a button **"Download CSI with a valid name"** that saves the same bytes as `csi.validName` (the FVU rejects names with spaces or brackets, e.g. `ABCD12345E101026 (1).csi`).

**B. New step 7 — "FVU results"** (after Download). Text: *"Ran Protean's FVU? Upload what it produced and we'll show which row to fix."* Three optional file inputs, any combination:
- `.err` file (FVU found errors) → `readErrFile(text, lines)`
- `…_Electronic_Statement_Warning_File.html` → `readWarningFile(html, lines)`
- statistics report `<name>.html` → `readStatistics(html)` then `compareStatistics(stats, rv.totals)`

Read all three with `TextDecoder('latin1')`. Show one table of issues: Errors first (red), then Warnings (amber); columns: Row (`where`), FVU code, FVU message, **What to do** (`hint`, or "See the FVU message" when empty). Group identical codes with a count ("T-FV-4015 × 79"). If the statistics agree with the return, show a green "FVU totals match the return"; otherwise list the differences. Keep the built `lines` in memory so this step works without rebuilding; if the page was reloaded, ask the user to rebuild first. Never offer to edit the `.txt` — fixes are made in the input workbook, then rebuild.

## Phase 2 additions (section codes worked out by the tool)

**A. Template.** The "Download blank input workbook" button now uses `makeTemplateWithSection(form)`. Help text: *"In Deductees, either type the 4-digit Section code, or leave it blank and copy the section as it appears in your working into 'Section (as in working)' - e.g. 194C, 94Q, CONTT. 194 C, Rent building, 393(1)-6(i).D(a), Salary. The tool works out the code and shows you why."*

**B. New step "Section codes"** between Upload and Build (always shown, even if every row has a code):
1. Get the deductor type: from the Deductor sheet (`readInputWorkbook(...).deductor?.deductor_type`) or from the uploaded .fvu (`deductorFromFvu(text).deductor.deductor_type`).
2. `rows = suggestSections(bytes, form, deductorType)`. Show a table: Row, Name, PAN, Rate %, Section as written, **Code**, **Why** (`result.reason`), Note (`result.rateNote`, amber).
   - `given` / `auto`: show the code (green); the user may override it with a drop-down of all codes for this form (`Object.entries(SECTION_MAP).filter(([,v]) => v.forms.includes(form))`).
   - `choose`: amber row; a required drop-down of `result.options` (show `label`); no default.
   - `error`: red row with `result.reason`; the user must fix the workbook (wrong form, unsupported section) or pick a code from the full list.
   - Summary line: "N worked out, N need your choice, N problems". Filter buttons for each status.
3. Button **"Apply codes"** (enabled only when every row has a code): `bytes2 = applySections(bytes, rows.map(r => ({row: r.row, code: chosen code})))`, then continue to Build with `readInputWorkbook(bytes2, form, quarter)` exactly as before. Also offer **"Download workbook with codes"** (`bytes2` as .xlsx) so the user can keep it.
4. Never change a code silently; never choose for a `choose` row. Rate notes are information only (the code stays as the working shows - SOP rule 11).

### Phase 2 acceptance tests
- Template from `makeTemplateWithSection('140')` has "Section (as in working)" right after "Section code".
- Take `test/fixtures/f140.xlsx`, clear the 3 Section codes and type 194C / 194J(b) / PURCHASE GOODS 194 Q in "Section (as in working)": the step shows 1023 / 1027 / 1031 with reasons, and the built return equals `f140.txt` (apart from the date in line 1).
- A row with "194J" and no rate shows a choice of 1026 / 1027 / 1028; a row with "194IA" in Form 140 shows an error (belongs in Form 141).
- Terminal: `node test/phase2.test.ts`.

## Phase 3 additions (challans matched by the tool)

**A. Template.** "Download blank input workbook" now uses `makeTemplateFull(form)` (replaces `makeTemplateWithSection`). Help text: *"'Challan #' on each deductee row is now optional - leave it blank and the tool matches rows to challans. On the Challans sheet, give the FULL challan (even if part of it is for another form, e.g. TCS paid with TDS). Optional but recommended when one challan covers several sections or forms: 'Section breakup' from the challan counterfoil, e.g. 1023=5000; 1073=180000; and the 'Major head' (0020 company / 0021 non-company)."*

**B. New step "Challan matching"** after "Section codes" (work on the bytes returned by `applySections`):
1. `{challans, rows, problems} = readForMatching(bytes2)`; show `problems` first if any.
2. `res = matchChallans(challans, rows)`. Show three panels:
   - **Rows** table: Row, Name, PAN, Section, Date deducted, Tax, **Challan**, **Why** (`reason`). `given` / `matched` green; `exception` red with a drop-down to pick a challan (all challans, showing number, date, amount, balance) - the user's choice is applied as typed-in.
   - **Challans** table from `res.challans`: Challan, Date, Tax, Used by this return, **Balance**, Interest paid, Interest due, Notes. Balance > 0: amber, note "part of this challan belongs to another form, or is excess - it must be used there". Interest due > paid: red.
   - **Points needing a decision** from `res.exceptions` (one card each, `message`): duplicates, shortfalls, rows too large for any challan, challans dated before the deduction, interest short. These are NOT decided by the rules (Phase 4 adds AI proposals here, applied only after the user approves).
3. Button **"Apply challan links"** - enabled only when every row has a challan (matched, given, or chosen by the user): `bytes3 = applyChallanMatches(bytes2, rows.map(r => ({row, challanNo})))`, then Build uses `readInputWorkbook(bytes3, form, quarter)` exactly as before. Offer **"Download workbook with challan links"**.
4. If the user re-runs matching after editing the workbook, start again from step 1 - never keep stale links.

### Phase 3 acceptance tests
- `test/fixtures/f140.xlsx` with its 'Challan #' cells cleared: matching links rows 1,2 → challan 1 and row 3 → challan 2 (as originally), and the built return equals `f140.txt` apart from the date in line 1.
- Two challans dated the same day that could each take a month's rows → the rows show as needing a decision (no guess) and a possible-duplicate card appears.
- Terminal: `node test/phase3.test.ts`.

## Phase 4 additions (challan receipts read by the tool; AI proposals for open points)

Add `src/core/challanPdf.ts` and `src/core/aiExceptions.ts` exactly as given, and the npm package `pdfjs-dist@4.10.38` (in the browser: `import * as pdfjs from 'pdfjs-dist'` and set `pdfjs.GlobalWorkerOptions.workerSrc` to the bundled `pdf.worker.min.mjs` via Vite's `?url` import).

**A. "Add challans from receipts"** (on the Challans step, before matching). The user drops the challan receipt PDFs downloaded from the e-filing portal (several at once).
1. `results = await readChallanPdfs(await Promise.all(fileList.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))), pdfjs)` - runs in the browser, nothing is sent anywhere. Show one line per file: green "read" with BSR / challan no / date / tax / interest / sections, or red with `problems`. Files that are not receipts (acknowledgements etc.) show "not a challan receipt" in grey.
2. For a red file whose text was found but whose layout was not recognised, show **"Try with Gemini"**: first show `maskReceiptText(text)` (identifiers replaced by placeholders) in a box for the user to read, then on **"Send to Gemini"** post `geminiChallanRequest(masked)` to the server route and pass the reply text to `fromGemini(reply)`. Its result goes through the same cross-checks; if it fails, show the problems - the user types that challan in. Scanned (image-only) PDFs: no AI button; message as returned.
3. **"Add N challans to the workbook"**: `bytes = addChallansToWorkbook(bytes, receipts)` (only green ones, duplicates removed), then continue to matching.

**B. "Ask Gemini to propose" on the Points needing a decision panel** (only when `res.exceptions` has rows open).
1. `payload = maskedPayload(challans, rows, res)`. Show it as a readable table ("This is all that will be sent: challan numbers, dates, amounts, major head, section breakup; rows as numbers with month, section, company/non-company and tax. No PAN, name, TAN, BSR or challan serial.") with **"Send to Gemini"**.
2. Post `geminiExceptionRequest(payload)`; pass the reply to `checkProposals(reply, challans, rows, res)`. `geminiExceptionRequest` throws if anything that looks like a PAN/TAN slipped in - show that error and send nothing.
3. Show each proposal as a card: rows, challan, Gemini's `explanation`, and the rule `checks`. Verdicts: **accepted** (green, pre-ticked), **needs-approval** (amber, NOT ticked - the user must tick it after reading the checks; e.g. a duplicate deposit used for a later month), **rejected** (red, cannot be ticked). Also list `unresolved`.
4. **"Apply ticked proposals"**: `{result, links} = applyProposals(challans, rows, res, ticked)`; replace `res` with `result` and redraw all three panels (the rules re-check everything; anything they still flag stays visible as a point needing a decision, with the user's approval noted). The Apply challan links button then uses `links`.
5. Never apply anything without the click; never send again automatically.

### Phase 4 acceptance tests
- `node test/phase4.test.ts` passes (made-up data, Gemini answers mocked).
- A made-up receipt whose section amounts do not add up to the tax is refused, not guessed.
- With two same-date challans and no major head, the rules leave the rows open; a mocked Gemini answer linking them sensibly is accepted, one naming a non-existent row is rejected, and one using a duplicate challan for a later month is "needs approval".
- With "Never use AI" on, no request is ever made (check the browser's network tab).

## Text to show on every page (footer)

"Prepares draft return files only. It is not tax advice. A qualified person must review every return before it is filed. Built for Protean FVU version 1.2 (`TARGET_FVU` in the core); if Protean releases a newer FVU, check for an updated version of this tool."

Also show `AGENT_VERSION` and `TARGET_FVU` from `protean.ts` in the footer.

## Look and feel

Clean, form-like, works on a laptop screen; plain language; no jargon beyond the field names used in returns. Step indicator 1–6. Accessible (labels on every input, keyboard navigation). No login.

## Acceptance tests (run these before calling it done)

Test files are in the repository at `web/test/fixtures/` (made-up data): `f140.xlsx`, `f143.xlsx`, `f138q2.xlsx`, `f138q4.xlsx` with expected output `*.txt`; for all of them use FY 2026, RRR `770000000000001`, and the Deductor sheet inside the workbook (no .fvu). Quarters: f140 Q2, f143 Q2, f138q2 Q2, f138q4 Q4.

For each: upload, build, download the `.txt`, and compare with the expected file. They must be identical **except field 5 of line 1** (the creation date, today's date as DDMMYYYY). The review must show no problems. Also check: uploading a workbook with a blank section code lists it under "fill these in"; Form 138 Q4 with a new-regime employee whose HRA is filled is reported as a problem and the download is disabled.

The core can also be checked from a terminal: `node web/test/parity.test.ts` (Node 22.6+; compares the TypeScript output with the Python tool's).

### Phase 1 acceptance tests
Files in `test/fixtures/` (made up): with `f143.xlsx` built for Q2 (RRR `770000000000001`):
- Upload `ABCD12345E101026.csi` → no CSI errors; renamed to `ABCD12345E101026.csi` if uploaded as `ABCD12345E101026 (1).csi`.
- FVU results: `sample.err` → 3 errors, the first tied to "Challan 1, row 1: E SCRAP TRADERS…" with the 4-decimal hint; `sample_Electronic_Statement_Warning_File.html` → 1 warning (challan not in CSI) with its hint; `sample_stats.html` → "FVU totals match the return".
The same checks run from a terminal: `node test/phase1.test.ts`.

## Hosting on an existing site

The app is entirely static once built (`npm run build` → `dist/`). Either deploy it from AI Studio to Cloud Run and link to it from the site, or set Vite's `base` (e.g. `/tds-tool/`) and copy `dist/` into the existing site under that path. Without the Phase 4 AI buttons no server code is needed. With them, add the one server route described under Privacy rules (key as a server secret, forwards the request, stores and logs nothing); if the site is static-only, deploy from AI Studio to Cloud Run, which provides that.
