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
1. `{challans, rows, problems, warnings} = readForMatching(bytes2)`. Show `problems` first in red and **stop** if any (e.g. the Tax column is Amount x Rate without /100 - every tax 100 times too big; the user must correct the workbook and upload again). Show `warnings` in amber (tax differs from Amount x Rate % / 100 - fine if it is the tax actually deducted) and let the user continue.
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

## Version 1.5 changes (automatic challan split) - replace src/core/challanMatch.ts with the new one

The matching engine now splits challans itself; the screens stay as in Phase 3 / 4. What changes for the user:
- **Tax column check** (step B.1 above): a Tax that is Amount x Rate (the /100 missing) stops the step with a plain message; other differences are warnings.
- **Month plan**: each challan is tied to the month it pays (no interest = the month it is on time for; with interest = the month it is late for). Rows go to their month's challan, even when another challan is dated earlier. Same-date pairs with no major head: the smaller is taken as 0020 (company) - say so on screen ("check with the challan receipts"); reading the receipt PDFs (Phase 4) gives the real major head.
- **Split**: rows that do not fit their month's challan move to another challan with money left (top-up challans first, same major head first; the other major head only as a last resort, noted per SOP rule 11).
- **Shared challans**: the section breakup now reserves only the share of sections this return has none of (e.g. 1002 salary for Form 138). It is used only as a last resort, and then the row and the challan say "check the other return still has enough". A breakup that differs from the rows is a note on the challan, not a block.
- Show every row's `reason` (it says which rule placed it) and every challan's `notes` in the tables. Exceptions now only appear for what is genuinely undecidable (possible duplicates, no challan dated after the deduction, interest short).

### Version 1.5 acceptance tests
- `node test/phase5.test.ts` passes (made-up data): July paid late with interest after August was paid on time - rows go 3,3,4,5,1,2; nothing is left for a decision.
- A workbook whose Tax column is `=Amount*Rate` (no /100) is stopped at the Challan matching step with the "without dividing by 100" message.

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


---

# Core files (put in src/core/ exactly as given)

## src/core/protean.ts

```ts
/**
 * Protean (NSDL) e-TDS/TCS return file writer — TypeScript port of
 * plugins/tds-agent/skills/tds-quarter/scripts/protean_writer.py (tds-agent 2.6.0 and later).
 *
 * Builds the caret-separated regular statement that Protean's free RPU writes with
 * "Create File", for Form 138 (TDS on salary, incl. Q4 salary details), Form 140
 * (TDS other than salary) and Form 143 (TCS). Validate the result with Protean's FVU
 * on the user's own PC — the FVU is Protean's Java software and cannot run in a browser.
 *
 * Pure functions, no I/O, no network: safe to run entirely in the browser so client
 * PANs / TANs / salaries never leave the user's machine.
 *
 * PARITY: output must be byte-for-byte identical to the Python writer. Run
 *   node web/test/parity.test.ts
 * after any change. Dates are 'YYYY-MM-DD' strings (no Date objects, no time zones).
 */

export const AGENT_VERSION = '2.6.0';
export const WRITER_NAME = 'TDSAGENT';      // FH field 10
export const TARGET_FVU = '1.2';            // FVU version this layout was taken from

export const FH_FIELDS = 18, BH_FIELDS = 72, CD_FIELDS = 30, DD_FIELDS = 45;
export const SD_FIELDS = 88, S16_FIELDS = 8, C6A_FIELDS = 10;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
export const SUPPORTED_FORMS = ['138', '140', '143'] as const;
export type Form = typeof SUPPORTED_FORMS[number];
export type Ymd = string;                   // 'YYYY-MM-DD'

// ---------------------------------------------------------------- data shapes
export interface Person {
  name: string; address1?: string; address2?: string; address3?: string; address4?: string;
  town?: string; state_code?: string; pin?: string; email?: string; std_code?: string; phone?: string;
  country?: string;                         // default 'INDIA'
}

export interface Deductor {
  tan: string; pan: string; entity: Person;
  deductor_type: string;                    // BH 32: F firm, K company, P individual/HUF ...
  responsible: Person; responsible_designation: string; responsible_pan: string;
  gstn?: string;
}

export interface Deductee {
  pan: string; name: string;
  section_code: string;                     // 4-digit internal code, e.g. '1023', '1067'
  date_paid: Ymd; amount: number; tds: number; date_deducted: Ymd;
  rate: number;                             // percent; ignored for Form 138
  deposited?: number | null;                // defaults to tds
  remarks?: string; certificate_no?: string;
  // Form 143 only
  non_resident?: string;                    // Y/N, default N
  opting_out?: string;                      // Y/N, default N
  collectee_code?: string;                  // '01'..'10'
  permanent_establishment?: string;         // non-residents only
  tds_liable?: string; tds_challan_no?: string; tds_paid_on?: Ymd | null;   // remark F only
}

export interface Challan {
  bsr: string; challan_no: string; date_deposited: Ymd;
  tax: number;                              // FULL physical challan tax, even if shared with other forms
  interest?: number; fee?: number; others?: number;
  minor_head?: string;                      // default '200'
  interest_allocated?: number | null; fee_allocated?: number | null;
  deductees: Deductee[];
}

export interface ViaItem { section: string; deductible: number; gross?: number | null; qualifying?: number | null }

export interface SalaryDetail {
  pan: string; name: string;
  category: string;                         // G / W / S / O
  old_regime: boolean;                      // true = opted OUT of the new regime
  employed_from: Ymd; employed_to: Ymd;
  salary_17_1: number; perquisites_17_2?: number; profits_17_3?: number; previous_employer_salary?: number;
  travel_concession?: number; gratuity?: number; commuted_pension?: number; leave_encashment?: number;
  hra_exemption?: number; other_exemption?: number; allowances_10_14?: number;
  standard_deduction?: number; entertainment_16ii?: number; professional_tax_16iii?: number;
  house_property?: number; other_income?: number;
  via?: ViaItem[];
  tax?: number; rebate_87a?: number; surcharge?: number; cess?: number; relief_89?: number;
  tds_current?: number; tds_previous?: number; tds_192_2b?: number;
  higher_rate?: string; rent_over_1lakh?: string; landlords?: [string, string][];
  interest_to_lender?: string; lenders?: [string, string][];
  taxable_income?: number | null;           // override (rounding u/s 288A)
}

// ---------------------------------------------------------------- formatting (matches Python)
/** Python f'{x:.Nf}': correctly rounded, ties to even on the exact binary value. */
function fixed(x: number, places: number): string {
  // Round the EXACT decimal value of the binary number, ties to even — what Python's
  // f'{x:.2f}' does. toPrecision(100) gives the exact expansion for any amount >= 1e-6
  // (a double has at most ~75 significant decimal digits in that range).
  if (!Number.isFinite(x)) throw new Error(`Not a number: ${x}`);
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let intPart: string, frac: string;
  if (ax !== 0 && ax < 1e-6) { intPart = '0'; frac = '0000001'; }   // tiny: rounds to zero at <= 6 places
  else {
    const s = ax === 0 ? '0' : ax.toPrecision(100);
    [intPart, frac = ''] = s.split('.');
  }
  frac = frac.padEnd(places + 1, '0');
  let digits = BigInt(intPart + frac.slice(0, places));
  const rest = frac.slice(places);                       // digits beyond the last kept place
  const first = rest[0], tail = rest.slice(1);
  if (first > '5' || (first === '5' && /[1-9]/.test(tail)) || (first === '5' && digits % 2n === 1n)) digits += 1n;
  let out = digits.toString().padStart(places + 1, '0');
  out = places ? `${out.slice(0, -places)}.${out.slice(-places)}` : out;
  return neg ? `-${out}` : out;                          // Python keeps the sign: -0.004 -> '-0.00'
}
export const amt = (v: number | null | undefined): string => fixed(Number(v || 0), 2);
export const rate4 = (v: number | null | undefined): string => fixed(Number(v || 0), 4);
export const dmy = (d: Ymd): string => { const [y, m, dd] = d.split('-'); return `${dd}${m}${y}`; };

export function clean(text: unknown, maxlen?: number): string {
  let t = String(text ?? '').replace(/[\^\r\n\t]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim().toUpperCase();
  return maxlen ? t.slice(0, maxlen) : t;
}

function line(fields: Record<number, string | number>, width: number): string {
  const out: string[] = [];
  for (let i = 1; i <= width; i++) out.push(fields[i] === undefined ? '' : String(fields[i]));
  return out.join('^');
}

// ---------------------------------------------------------------- Form 143 collectee codes
export const COLLECTEE_CODES: Record<string, string> = {
  '01': 'Company, other than domestic company', '02': 'Individual', '03': 'Hindu Undivided Family',
  '04': 'AOP (other than AOP of only companies)', '05': 'AOP consisting only of companies',
  '06': 'Co-operative society', '07': 'Firm', '08': 'Body of individuals',
  '09': 'Artificial juridical person', '10': 'Others',
};
const PAN4_TO_COLLECTEE: Record<string, string> = { P: '02', H: '03', A: '04', F: '07', E: '07', B: '08', J: '09' };
/** Code implied by the PAN's 4th letter, or '' when a person must decide (companies, trusts, govt). */
export const collecteeCodeFromPan = (pan: string): string => (pan.length === 10 ? PAN4_TO_COLLECTEE[pan[3]] ?? '' : '');

// ---------------------------------------------------------------- Form 138 Q4 salary details
export const VIA_ORDER = ['80CCE', '80CCF', '80CCG', 'OTHERS', '80C', '80CCC', '80CCD(1)', '80CCD(1B)', '80CCD(2)',
  '80D', '80E', '80G', '80TTA', '80CCH', '80CCH(1)'];
export const VIA_WITH_QUALIFYING = new Set(['OTHERS', '80G', '80TTA']);
export const VIA_DEDUCTIBLE_ONLY = new Set(['80CCE', '80CCF', '80CCG']);
export const VIA_NEW_REGIME = new Set(['80CCD(2)', '80CCH', '80CCH(1)']);
export const EMPLOYEE_CATEGORY: Record<string, string> = { G: 'Others', W: 'Woman', S: 'Senior citizen', O: 'Super senior citizen' };

const n0 = (v: number | null | undefined) => Number(v || 0);
export const salary = {
  exemptions: (s: SalaryDetail) => n0(s.travel_concession) + n0(s.gratuity) + n0(s.commuted_pension) +
    n0(s.leave_encashment) + n0(s.hra_exemption) + n0(s.other_exemption) + n0(s.allowances_10_14),
  s16: (s: SalaryDetail): [string, number][] =>
    ([['16(ii)', n0(s.entertainment_16ii)], ['16(iii)', n0(s.professional_tax_16iii)],
      ['16(ia)', n0(s.standard_deduction)]] as [string, number][]).filter(([, v]) => v),
  currentSalary: (s: SalaryDetail) => n0(s.salary_17_1) + n0(s.perquisites_17_2) + n0(s.profits_17_3),
  totalSalary: (s: SalaryDetail) => salary.currentSalary(s) + n0(s.previous_employer_salary),
  incomeSalaries: (s: SalaryDetail) =>
    salary.totalSalary(s) - salary.exemptions(s) - salary.s16(s).reduce((a, [, v]) => a + v, 0),
  gti: (s: SalaryDetail) => salary.incomeSalaries(s) + n0(s.house_property) + n0(s.other_income),
  viaLines: (s: SalaryDetail): ViaItem[] => {
    const order = new Map(VIA_ORDER.map((x, i) => [x, i]));
    return [...(s.via ?? [])].sort((a, b) => order.get(a.section)! - order.get(b.section)!).filter(v =>
      VIA_DEDUCTIBLE_ONLY.has(v.section) ? !!v.deductible
        : VIA_WITH_QUALIFYING.has(v.section) ? !!(v.deductible || v.gross || v.qualifying)
          : !!(v.deductible || v.gross));
  },
  viaTotal: (s: SalaryDetail) => salary.viaLines(s).reduce((a, v) => a + v.deductible, 0),
  taxable: (s: SalaryDetail) =>
    s.taxable_income !== null && s.taxable_income !== undefined ? s.taxable_income : salary.gti(s) - salary.viaTotal(s),
  netTax: (s: SalaryDetail) => n0(s.tax) + n0(s.surcharge) + n0(s.cess) - n0(s.rebate_87a) - n0(s.relief_89),
  totalTds: (s: SalaryDetail) => n0(s.tds_current) + n0(s.tds_previous) + n0(s.tds_192_2b),
};

function salaryLines(n: number, s: SalaryDetail, nextLine: number): string[] {
  const A = amt, S = salary;
  const isNew = !s.old_regime;
  const s16 = S.s16(s), via = S.viaLines(s);
  const agg80c = via.filter(v => ['80C', '80CCC', '80CCD(1)'].includes(v.section)).reduce((a, v) => a + v.deductible, 0);
  const landlords = s.landlords ?? [], lenders = s.lenders ?? [];
  const rent = s.rent_over_1lakh ?? 'N', lender = s.interest_to_lender ?? 'N';
  const sd: Record<number, string | number> = {
    2: 'SD', 3: 1, 4: n, 5: 'A', 7: s.pan, 9: clean(s.name, 75), 10: s.category,
    11: dmy(s.employed_from), 12: dmy(s.employed_to), 13: A(S.totalSalary(s)),
    15: s16.length, 16: A(s16.reduce((a, [, v]) => a + v, 0)), 17: A(S.incomeSalaries(s)), 18: A(s.house_property),
    19: A(S.gti(s)), 21: via.length, 22: A(S.viaTotal(s)), 23: A(S.taxable(s)),
    24: A(s.tax), 25: A(s.surcharge), 26: A(s.cess), 27: A(s.relief_89), 28: A(S.netTax(s)),
    29: A(S.totalTds(s)), 30: A(S.netTax(s) - S.totalTds(s)), 31: A(agg80c),
    34: A(S.currentSalary(s)), 35: A(s.previous_employer_salary), 36: A(s.tds_current), 37: A(s.tds_previous),
    38: s.higher_rate ?? 'N', 39: rent,
    40: rent === 'Y' ? String(landlords.length) : '0',
    49: lender, 50: lender === 'Y' ? String(lenders.length) : '0',
    59: 'N',
    67: A(s.salary_17_1), 68: A(s.perquisites_17_2), 69: A(s.profits_17_3),
    70: isNew ? '' : A(s.travel_concession), 71: A(s.gratuity), 72: A(s.commuted_pension),
    73: A(s.leave_encashment), 74: isNew ? '' : A(s.hra_exemption), 75: A(s.other_exemption),
    76: A(S.exemptions(s)), 77: A(s.other_income), 78: A(s.rebate_87a), 79: s.old_regime ? 'Y' : 'N',
    80: A(s.allowances_10_14), 81: A(s.tds_192_2b),
  };
  if (rent === 'Y') landlords.slice(0, 4).forEach(([p, nm], k) => { sd[41 + 2 * k] = p; sd[42 + 2 * k] = clean(nm, 75); });
  if (lender === 'Y') lenders.slice(0, 4).forEach(([p, nm], k) => { sd[51 + 2 * k] = p; sd[52 + 2 * k] = clean(nm, 75); });
  const out: string[] = [];
  sd[1] = nextLine; out.push(line(sd, SD_FIELDS));
  s16.forEach(([sid, v], k) =>
    out.push(line({ 1: nextLine + out.length, 2: 'S16', 3: 1, 4: n, 5: k + 1, 6: sid, 7: A(v) }, S16_FIELDS)));
  via.forEach((v, k) => {
    const f: Record<number, string | number> = { 1: nextLine + out.length, 2: 'C6A', 3: 1, 4: n, 5: k + 1, 6: v.section, 7: A(v.deductible) };
    if (!VIA_DEDUCTIBLE_ONLY.has(v.section)) f[8] = A(v.gross || 0);
    if (VIA_WITH_QUALIFYING.has(v.section)) f[9] = A(v.qualifying || 0);
    out.push(line(f, C6A_FIELDS));
  });
  return out;
}

// ---------------------------------------------------------------- builder
const FILE_TYPE: Record<string, string> = { '138': 'SL1', '140': 'NS1', '144': 'NS1', '143': 'TC1' };
const challanTotal = (c: Challan) => n0(c.tax) + n0(c.interest) + n0(c.fee) + n0(c.others);

function ddFields(form: Form, x: Deductee, c: Challan): Record<number, string> {
  if (form === '140') return {};
  if (form === '138') return { 28: '', 29: dmy(c.date_deposited) };   // salary: no rate; date of deposit instead
  const raw = String(x.collectee_code ?? '').trim();
  const f: Record<number, string> = { 11: x.non_resident ?? 'N', 12: /^\d+$/.test(raw) ? String(parseInt(raw, 10)) : '', 14: x.opting_out ?? 'N' };
  if ((x.non_resident ?? 'N') === 'Y') f[13] = x.permanent_establishment ?? '';
  if (x.remarks === 'F') {
    f[34] = x.tds_liable ?? '';
    if (x.tds_liable === 'Y') { f[35] = x.tds_challan_no ?? ''; f[36] = x.tds_paid_on ? dmy(x.tds_paid_on) : ''; }
  }
  return f;
}

export interface BuildOptions {
  form: Form; deductor: Deductor; challans: Challan[]; fyStart: number; quarter: 1 | 2 | 3 | 4;
  prevToken?: string | null;                // RRR no. of the previous regular statement of this form
  created?: Ymd;                            // file creation date, default today
  salary?: SalaryDetail[];                  // Form 138 Q4 only
}

const todayYmd = (): Ymd => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function buildStatement(o: BuildOptions): string[] {
  const { form, deductor: d, challans, fyStart, quarter } = o;
  if (!SUPPORTED_FORMS.includes(form)) throw new Error(`Form ${form} not supported (supported: ${SUPPORTED_FORMS.join(', ')})`);
  const q4 = form === '138' && quarter === 4;
  if (q4 && !o.salary) throw new Error("Form 138 Q4 needs every employee's annual salary details");
  if (o.salary && o.salary.length && !q4) throw new Error('Salary details belong only in Form 138 Q4');
  const sal = o.salary ?? [];
  const prev = o.prevToken || '';
  const lines: string[] = [];
  lines.push(line({ 1: 1, 2: 'FH', 3: FILE_TYPE[form], 4: 'R', 5: dmy(o.created ?? todayYmd()), 6: 1, 7: 'D',
    8: d.tan, 9: 1, 10: WRITER_NAME }, FH_FIELDS));
  const e = d.entity, r = d.responsible;
  lines.push(line({
    1: 2, 2: 'BH', 3: 1, 4: challans.length, 5: form, 9: prev, 13: d.tan, 15: d.pan,
    16: `${fyStart + 1}${String(fyStart + 2).slice(-2)}`, 17: `${fyStart}${String(fyStart + 1).slice(-2)}`, 18: `Q${quarter}`,
    19: clean(e.name, 75), 20: clean(e.country ?? 'INDIA'),
    21: clean(e.address1, 25), 22: clean(e.address2, 25), 23: clean(e.address3, 25), 24: clean(e.address4, 25),
    25: clean(e.town, 25), 26: e.state_code ?? '', 27: e.pin ?? '', 28: e.email ?? '', 29: e.std_code ?? '', 30: e.phone ?? '',
    32: d.deductor_type,
    33: clean(r.name, 75), 34: clean(d.responsible_designation, 20),
    35: clean(r.address1, 25), 36: clean(r.address2, 25), 37: clean(r.address3, 25), 38: clean(r.address4, 25),
    39: clean(r.town, 25), 40: r.state_code ?? '', 41: r.pin ?? '', 42: r.email ?? '', 43: clean(r.country ?? 'INDIA'),
    44: r.std_code ?? '', 45: r.phone ?? '',
    47: amt(challans.reduce((a, c) => a + challanTotal(c), 0)),
    49: form === '138' ? (q4 ? String(sal.length) : '0') : '',
    50: q4 ? amt(sal.reduce((a, s) => a + salary.gti(s), 0)) : '',
    70: q4 ? '0' : '', 71: q4 ? '0.00' : '',
    52: prev ? 'Y' : 'N', 59: d.responsible_pan, 69: d.gstn ?? '',
  }, BH_FIELDS));

  challans.forEach((c, ci0) => {
    const ci = ci0 + 1;
    const depOf = (x: Deductee) => (x.deposited !== null && x.deposited !== undefined ? x.deposited : x.tds);
    const depTotal = c.deductees.reduce((a, x) => a + Number(depOf(x)), 0);
    const nil = challanTotal(c) === 0;
    lines.push(line({
      1: lines.length + 1, 2: 'CD', 3: 1, 4: ci, 5: c.deductees.length, 6: nil ? 'Y' : 'N',
      8: amt(c.tax), 9: amt(c.interest), 10: amt(c.fee), 11: amt(c.others), 12: amt(nil ? 0 : challanTotal(c)),
      13: nil ? '' : 'C', 15: nil ? '' : c.bsr, 17: nil ? '' : c.challan_no, 19: dmy(c.date_deposited),
      21: amt(nil ? 0 : depTotal), 22: amt(nil ? 0 : depTotal), 23: nil ? '' : (c.minor_head ?? '200'),
      24: amt(c.interest_allocated ?? c.interest), 25: amt(c.fee_allocated ?? c.fee),
    }, CD_FIELDS));
    c.deductees.forEach((x, di) => {
      const dd: Record<number, string | number> = {
        1: lines.length + 1, 2: 'DD', 3: 1, 4: di + 1, 5: ci, 6: 'O', 8: x.pan, 9: clean(x.name, 75),
        15: x.section_code, 18: 'Y', 19: dmy(x.date_paid), 20: amt(x.amount),
        24: amt(x.tds), 25: amt(nil ? 0 : depOf(x)), 27: dmy(x.date_deducted), 28: rate4(x.rate),
        32: x.remarks ?? '', 33: x.certificate_no ?? '',
      };
      Object.assign(dd, ddFields(form, x, c));
      lines.push(line(dd, DD_FIELDS));
    });
  });
  sal.forEach((s, k) => lines.push(...salaryLines(k + 1, s, lines.length + 1)));
  return lines;
}

// ---------------------------------------------------------------- checks (same rules as Python)
export function checkStatement(lines: string[], fyStart: number, quarter: number): string[] {
  const probs: string[] = [];
  const form = (lines.map(l => l.split('^')).find(f => f[1] === 'BH') ?? [])[4] ?? '';
  const widths: Record<string, number> = { FH: FH_FIELDS, BH: BH_FIELDS, CD: CD_FIELDS, DD: DD_FIELDS, SD: SD_FIELDS, S16: S16_FIELDS, C6A: C6A_FIELDS };
  const qm = ({ 1: [4, 6], 2: [7, 9], 3: [10, 12], 4: [1, 3] } as Record<number, number[]>)[quarter];
  const qYear = quarter === 4 ? fyStart + 1 : fyStart;
  let batchTotal = 0, cdTotal = 0, cur: string[] | null = null, ddSum = 0, ddCount = 0;
  const closeCd = () => {
    if (!cur) return;
    if (Math.abs(ddSum - Number(cur[21])) > 0.001) probs.push(`CD ${cur[4]}: deductee deposited total ${ddSum.toFixed(2)} != CD field 21 ${cur[21]}`);
    if (ddCount !== Number(cur[5])) probs.push(`CD ${cur[4]}: ${ddCount} DD lines but count field says ${cur[5]}`);
  };
  lines.forEach((ln, i) => {
    const n = i + 1, f = ['', ...ln.split('^')], rt = f[2];
    if (!(rt in widths)) { probs.push(`line ${n}: unknown record type ${rt}`); return; }
    if (f.length - 1 !== widths[rt]) probs.push(`line ${n} ${rt}: ${f.length - 1} fields, expected ${widths[rt]}`);
    if (f[1] !== String(n)) probs.push(`line ${n} ${rt}: line number field is ${f[1]}`);
    if (rt === 'FH' && !TAN_RE.test(f[8])) probs.push('FH: TAN format invalid');
    if (rt === 'BH') {
      batchTotal = Number(f[47]);
      if (!PAN_RE.test(f[15])) probs.push('BH: deductor PAN format invalid');
      if (f[52] === 'Y' && !/^\d{15}$/.test(f[9])) probs.push('BH: previous statement filed = Y but field 9 is not a 15-digit RRR number');
      if (f[59] && !PAN_RE.test(f[59])) probs.push('BH: responsible person PAN invalid');
    }
    if (rt === 'CD') {
      closeCd(); cur = f; ddSum = 0; ddCount = 0;
      cdTotal += Number(f[12]);
      const tot = [8, 9, 10, 11].reduce((a, k) => a + Number(f[k]), 0);
      if (Math.abs(tot - Number(f[12])) > 0.001) probs.push(`CD ${f[4]}: tax+interest+fee+others ${tot.toFixed(2)} != total ${f[12]}`);
      if (f[6] === 'N' && !/^\d{7}$/.test(f[15])) probs.push(`CD ${f[4]}: BSR code not 7 digits`);
    }
    if (rt === 'DD') {
      ddCount++; ddSum += Number(f[25]);
      if (!PAN_RE.test(f[8]) && !['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'].includes(f[8])) probs.push(`line ${n} DD: PAN ${f[8]} invalid`);
      if (cur && f[5] !== cur[4]) probs.push(`line ${n} DD: challan number ${f[5]} does not match its CD ${cur[4]}`);
      for (const fi of [19, 27]) {
        const mo = Number(f[fi].slice(2, 4)), yr = Number(f[fi].slice(4));
        if (!(qm[0] <= mo && mo <= qm[1] && yr === qYear)) probs.push(`line ${n} DD: date ${f[fi]} (field ${fi}) outside Q${quarter}`);
      }
      if (Number(f[24]) > Number(f[20]) + 0.001) probs.push(`line ${n} DD: TDS more than amount paid`);
      if (form === '138') {
        if (f[28]) probs.push(`line ${n} DD: Form 138 has no rate of deduction (field 28 must be blank)`);
        if (cur && f[29] !== cur[19]) probs.push(`line ${n} DD: date of deposit ${f[29]} (field 29) must equal its challan date ${cur[19]}`);
      } else if (!/^\d{1,3}\.\d{4}$/.test(f[28])) probs.push(`line ${n} DD: rate ${f[28]} must have 4 decimal places (T-FV-4092)`);
      for (const fi of [20, 24, 25]) if (!/^\d+\.\d{2}$/.test(f[fi])) probs.push(`line ${n} DD: amount field ${fi} ${f[fi]} must have 2 decimal places`);
      if (form === '143') {
        for (const [fi, what] of [[11, 'non-resident'], [14, 'opting out of tax regime']] as [number, string][])
          if (!['Y', 'N'].includes(f[fi])) probs.push(`line ${n} DD: "${what}" (field ${fi}) must be Y or N`);
        if (!(/^\d+$/.test(f[12]) && Number(f[12]) >= 1 && Number(f[12]) <= 10))
          probs.push(`line ${n} DD: collectee code (field 12) missing - mandatory on every row (T_FV_6417)`);
        if (f[11] === 'Y' && !['Y', 'N'].includes(f[13])) probs.push(`line ${n} DD: non-resident collectee needs permanent establishment Y/N (field 13)`);
      }
    }
  });
  closeCd();
  if (Math.abs(batchTotal - cdTotal) > 0.001) probs.push(`BH field 47 ${batchTotal.toFixed(2)} != sum of challan totals ${cdTotal.toFixed(2)}`);
  return probs.concat(checkSalary(lines, form, fyStart, quarter));
}

function checkSalary(lines: string[], form: string, fyStart: number, quarter: number): string[] {
  const probs: string[] = [];
  const recs = lines.map(l => ['', ...l.split('^')]);
  const bh = recs.find(f => f[2] === 'BH')!;
  const sds = recs.map((f, i) => (f[2] === 'SD' ? i : -1)).filter(i => i >= 0);
  if (!(form === '138' && quarter === 4)) {
    if (sds.length || recs.some(f => f[2] === 'S16' || f[2] === 'C6A')) probs.push('salary detail lines (SD/S16/C6A) belong only in Form 138 Q4');
    return probs;
  }
  if (bh[49] !== String(sds.length)) probs.push(`BH field 49 says ${bh[49]} salary records, file has ${sds.length}`);
  const gtiSum = sds.reduce((a, i) => a + Number(recs[i][19]), 0);
  if (!bh[50] || Math.abs(Number(bh[50]) - gtiSum) > 0.005) probs.push(`BH field 50 ${bh[50]} != total gross total income ${gtiSum.toFixed(2)}`);
  const fyFrom = `${fyStart}0401`, fyTo = `${fyStart + 1}0331`;
  const ord = (d: string) => `${d.slice(4)}${d.slice(2, 4)}${d.slice(0, 2)}`;   // ddmmyyyy -> yyyymmdd
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  sds.forEach((i, k) => {
    const f = recs[i], who = `SD ${f[4]} (${f[7]})`;
    const end = k + 1 < sds.length ? sds[k + 1] : recs.length;
    const subs = recs.slice(i + 1, end);
    const s16 = subs.filter(s => s[2] === 'S16'), c6a = subs.filter(s => s[2] === 'C6A');
    if (subs.some(s => !['S16', 'C6A'].includes(s[2]))) probs.push(`${who}: only S16/C6A lines may follow a salary record`);
    if (subs.map(s => s[2]).join() !== [...s16.map(() => 'S16'), ...c6a.map(() => 'C6A')].join()) probs.push(`${who}: S16 lines must come before C6A lines`);
    if (!PAN_RE.test(f[7]) && !['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'].includes(f[7])) probs.push(`${who}: PAN invalid`);
    if (!(f[10] in EMPLOYEE_CATEGORY)) probs.push(`${who}: category ${f[10]} must be one of G/W/S/O`);
    if (/^\d{8}$/.test(f[11]) && /^\d{8}$/.test(f[12])) {
      const d1 = ord(f[11]), d2 = ord(f[12]);
      if (!(fyFrom <= d1 && d1 <= d2 && d2 <= fyTo)) probs.push(`${who}: employment period ${f[11]}-${f[12]} must fall inside the financial year`);
    } else probs.push(`${who}: employment dates must be ddmmyyyy`);
    if (!['Y', 'N'].includes(f[79])) probs.push(`${who}: regime flag (field 79) must be Y (old regime) or N (new regime)`);
    if (['PANNOTAVBL', 'PANINVALID', 'PANAPPLIED'].includes(f[7]) && f[38] !== 'Y')
      probs.push(`${who}: no valid PAN, so "tax deducted at higher rate" (field 38) must be Y (T-FV-4319)`);
    const sd16 = s16.reduce((a, s) => a + Number(s[7]), 0);
    if (sd16 > Number(f[13]) + 0.005) probs.push(`${who}: section 16 deductions exceed salary - the standard deduction is limited to the salary (T-FV-4026)`);
    if (Number(f[17]) < 0) probs.push(`${who}: income under salaries is negative (T-FV-4026)`);
    if (Number(f[19]) < 0 && Number(f[18]) >= 0) probs.push(`${who}: gross total income is negative (T-FV-4028)`);
    if (Number(f[23]) < 0 || Number(f[22]) > Math.max(Number(f[19]), 0) + 0.005) probs.push(`${who}: Chapter VI-A exceeds gross total income - taxable income cannot be negative (T-FV-4031)`);
    if (Number(f[24]) < 0) probs.push(`${who}: tax on total income is negative (T-FV-4032)`);
    if (f[79] === 'N') {
      if (f[70] || f[74]) probs.push(`${who}: new regime - travel concession and HRA exemption must be blank (T_FV_6354)`);
      if (Number(f[18]) < 0) probs.push(`${who}: new regime - house property loss not allowed`);
      const bad = c6a.map(s => s[6]).filter(x => !VIA_NEW_REGIME.has(x));
      if (bad.length) probs.push(`${who}: new regime - deductions ${bad.join(', ')} not allowed`);
    }
    if (Number(f[15]) !== s16.length || !near(Number(f[16]), sd16)) probs.push(`${who}: section 16 count/total (fields 15/16) do not match its S16 lines`);
    if (Number(f[21]) !== c6a.length || !near(Number(f[22]), c6a.reduce((a, s) => a + Number(s[7]), 0))) probs.push(`${who}: Chapter VI-A count/total (fields 21/22) do not match its C6A lines`);
    s16.forEach((s, j) => { if (s[4] !== f[4] || s[5] !== String(j + 1)) probs.push(`${who}: S16 numbering wrong`); });
    c6a.forEach((s, j) => { if (s[4] !== f[4] || s[5] !== String(j + 1)) probs.push(`${who}: C6A numbering wrong`); });
    const v = (k2: number) => (f[k2] ? Number(f[k2]) : 0);
    if (!near(v(13), v(34) + v(35))) probs.push(`${who}: total salary (13) != current (34) + previous (35)`);
    if (!near(v(34), v(67) + v(68) + v(69))) probs.push(`${who}: current salary (34) != 17(1)+17(2)+17(3)`);
    if (!near(v(17), v(13) - v(76) - v(16))) probs.push(`${who}: income under salaries (17) != salary - exemptions - s.16`);
    if (!near(v(19), v(17) + v(18) + v(77))) probs.push(`${who}: gross total income (19) != salaries + house property + other income`);
    if (!near(v(28), v(24) + v(25) + v(26) - v(78) - v(27))) probs.push(`${who}: net tax (28) != tax + surcharge + cess - rebate - relief`);
    if (!near(v(29), v(36) + v(37) + v(81))) probs.push(`${who}: total TDS (29) != current + previous + 192(2B)`);
    if (!near(v(30), v(28) - v(29))) probs.push(`${who}: shortfall (30) != net tax - TDS`);
  });
  return probs;
}

// ---------------------------------------------------------------- output file
/** Protean file name rule: at most 12 characters including ".txt", letters and digits only. */
export function checkFileName(name: string): string | null {
  return name.length <= 12 && /^[A-Za-z0-9]+\.txt$/.test(name) ? null : 'File name must be at most 12 letters/digits including ".txt", e.g. ABC140Q2.txt';
}

/** Bytes to save as the .txt: Windows line endings, Windows-1252 text (as the RPU writes). */
export function encodeReturn(lines: string[]): Uint8Array {
  const text = lines.join('\r\n') + '\r\n';
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 255 || (c >= 0x80 && c < 0xa0)) throw new Error(`Character "${text[i]}" cannot be written in a Protean return file (line text: ${text.slice(Math.max(0, i - 20), i + 20)})`);
    out[i] = c;
  }
  return out;
}

// ---------------------------------------------------------------- reuse last quarter's header
/** Deductor details from a previously accepted .fvu (its FH/BH lines are plain text). */
export function deductorFromFvu(fvuText: string): { deductor: Deductor; form: string } {
  for (const ln of fvuText.split(/\r?\n/)) {
    const f = ['', ...ln.split('^')];
    if (f.length > 2 && f[2] === 'BH') {
      return {
        form: f[5],
        deductor: {
          tan: f[13], pan: f[15], deductor_type: f[32], responsible_designation: f[34], responsible_pan: f[59],
          gstn: f.length > 69 ? f[69] : '',
          entity: { name: f[19], country: f[20] || 'INDIA', address1: f[21], address2: f[22], address3: f[23], address4: f[24],
            town: f[25], state_code: f[26], pin: f[27], email: f[28], std_code: f[29], phone: f[30] },
          responsible: { name: f[33], address1: f[35], address2: f[36], address3: f[37], address4: f[38], town: f[39],
            state_code: f[40], pin: f[41], email: f[42], country: f[43] || 'INDIA', std_code: f[44], phone: f[45] },
        },
      };
    }
  }
  throw new Error('No batch header (BH) line found in this .fvu file');
}
```

## src/core/inputWorkbook.ts

```ts
/**
 * Read the agent's standard input workbook (the one `tds template` makes) into the writer's
 * data model. TypeScript port of load_input / load_salary / deductor_from_sheet in tds_cli.py.
 *
 * Sheets: Challans, Deductees, Deductor (optional), Salary (Q4) (Form 138 Q4 only).
 * Column headings come from template_columns.json, exported from the Python tool, so the
 * two never drift apart. Runs in the browser: pass the file's ArrayBuffer.
 */
import * as XLSX from 'xlsx';
import cols from './template_columns.json' with { type: 'json' };
import {
  type Challan, type Deductee, type Deductor, type Form, type SalaryDetail, type ViaItem, type Ymd,
  COLLECTEE_CODES, EMPLOYEE_CATEGORY, VIA_ORDER, VIA_WITH_QUALIFYING,
} from './protean.ts';

export const SALARY_SHEET: string = cols.SALARY_SHEET;
const DEDUCTOR_FIELDS = cols.DEDUCTOR_FIELDS as [string, string][];
const SALARY_COLS = cols.SALARY_COLS as [string, string][];

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const blank = (v: unknown) => v === null || v === undefined || v === '';
const num0 = (v: unknown): number => (blank(v) ? 0 : toNumber(v));
function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
  return n;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y: number, m: number, d: number): Ymd => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Excel date serial or text (dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, dd-Mon-yyyy, dd.mm.yyyy) -> 'YYYY-MM-DD'. */
export function toYmd(v: unknown): Ymd {
  if (typeof v === 'number') {                              // Excel serial: days since 1899-12-30
    const ms = Math.floor(v) * 86400000 + Date.UTC(1899, 11, 30);   // drop any time of day, like Python .date()
    const d = new Date(ms);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const t = s(v);
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1], t);
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3], t);
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MON[m[2].toLowerCase()]) return valid(+m[3], MON[m[2].toLowerCase()], +m[1], t);
  throw new Error(`Cannot read date ${JSON.stringify(t)} (use dd/mm/yyyy)`);
}
function valid(y: number, mo: number, d: number, raw: string): Ymd {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`Cannot read date ${JSON.stringify(raw)}`);
  return ymd(y, mo, d);
}

/** Rows of a sheet as {heading: value}, skipping fully blank rows (like the Python _rows). */
function rows(ws: XLSX.WorkSheet): Row[] {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
  if (!grid.length) return [];
  const hdr = (grid[0] as unknown[]).map(s);
  return grid.slice(1).filter(r => r.some(v => !blank(v))).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? null])));
}

/** Blank input workbook for `form`, same sheets and headings as `tds template` (returns .xlsx bytes). */
export function makeTemplate(form: Form): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.CHALLAN_COLS]), 'Challans');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([form === '143' ? [...cols.DEDUCTEE_COLS, ...cols.TCS_COLS] : cols.DEDUCTEE_COLS]), 'Deductees');
  if (form === '138') XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([SALARY_COLS.map(([h]) => h)]), SALARY_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Field', 'Value'],
    ["Leave this sheet empty to take details from last quarter's .fvu (--prev-fvu)"], ...DEDUCTOR_FIELDS.map(([label]) => [label])]), 'Deductor');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Collectee codes (Form 143)', ''],
    ...Object.entries(COLLECTEE_CODES), [], ['Section codes: 4-digit internal codes (see the section map)']]), 'Codes');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

export interface InputResult {
  challans: Challan[];
  deductor: Deductor | null;                // null = Deductor sheet empty: take it from last quarter's .fvu
  salary: SalaryDetail[] | null;            // Form 138 Q4 only
  missing: string[];                        // things the user must fill in before building
}

export function readInputWorkbook(data: ArrayBuffer | Uint8Array, form: Form, quarter: number): InputResult {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });   // 'array' works for ArrayBuffer and Uint8Array, in browser and Node
  const missing: string[] = [];
  for (const sh of ['Challans', 'Deductees']) if (!wb.Sheets[sh]) missing.push(`Sheet "${sh}" not found - use the template`);
  if (missing.length) return { challans: [], deductor: null, salary: null, missing };

  const byNo = new Map<number, Challan>();
  for (const r of rows(wb.Sheets['Challans'])) {
    const n = parseInt(s(r['Challan #']), 10);
    byNo.set(n, {
      bsr: s(r['BSR code']).padStart(7, '0'), challan_no: s(r['Challan serial no.']).padStart(5, '0'),
      date_deposited: toYmd(r['Date deposited']), tax: num0(r['Tax']), interest: num0(r['Interest']),
      fee: num0(r['Fee']), others: num0(r['Others']), minor_head: s(r['Minor head']) || '200', deductees: [],
    });
  }
  rows(wb.Sheets['Deductees']).forEach((r, k) => {
    const i = k + 2;
    try {
      const code = s(r['Section code']);
      if (!/^\d{4}$/.test(code)) missing.push(`Deductees row ${i}: section code ${JSON.stringify(code)}`);
      const dep = r['Tax deposited (blank = Tax)'];
      const x: Deductee = {
        pan: s(r['PAN']).toUpperCase(), name: s(r['Name']), section_code: code,
        date_paid: toYmd(r['Date paid / credited']), amount: toNumber(r['Amount']), tds: toNumber(r['Tax']),
        date_deducted: toYmd(r['Date deducted']), rate: blank(r['Rate %']) ? 0 : toNumber(r['Rate %']),
        deposited: blank(dep) ? null : toNumber(dep),
        remarks: s(r['Reason code (lower/no deduction)']), certificate_no: s(r['Certificate no.']),
      };
      if (form === '143') {
        x.non_resident = s(r['Non-resident (Y/N)']).toUpperCase().slice(0, 1) || 'N';
        x.opting_out = s(r['Opting out of tax regime (Y/N)']).toUpperCase().slice(0, 1) || 'N';
        x.collectee_code = s(r['Collectee code (01-10)']);
        x.permanent_establishment = s(r['Permanent establishment (Y/N, non-residents)']).toUpperCase().slice(0, 1);
        if (!x.collectee_code) missing.push(`Deductees row ${i}: collectee code`);
      }
      const n = parseInt(s(r['Challan #']), 10);
      const c = byNo.get(n);
      if (!c) missing.push(`Deductees row ${i}: challan #${n} not on Challans sheet`);
      else c.deductees.push(x);
    } catch (e) {
      missing.push(`Deductees row ${i}: ${(e as Error).message}`);
    }
  });
  const challans = [...byNo.keys()].sort((a, b) => a - b).map(k => byNo.get(k)!);

  let salary: SalaryDetail[] | null = null;
  if (form === '138' && quarter === 4) {
    const r = readSalary(wb);
    salary = r.salary; missing.push(...r.missing);
  }
  let deductor: Deductor | null = null;
  try { deductor = readDeductor(wb); } catch (e) { missing.push((e as Error).message); }
  return { challans, deductor, salary, missing };
}

function readDeductor(wb: XLSX.WorkBook): Deductor | null {
  const ws = wb.Sheets['Deductor'];
  if (!ws) return null;
  const labels = new Map(DEDUCTOR_FIELDS);
  const vals: Record<string, string> = {};
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  for (const r of grid.slice(1)) {
    const key = labels.get(s(r[0]));
    if (key && s(r[1])) vals[key] = s(r[1]);
  }
  if (!Object.keys(vals).length) return null;
  const need = ['tan', 'pan', 'name', 'deductor_type', 'rp_name', 'rp_pan'].filter(k => !(k in vals));
  if (need.length) throw new Error(`Deductor sheet is missing: ${need.join(', ')}`);
  const g = (k: string) => vals[k] ?? '';
  return {
    tan: g('tan').toUpperCase(), pan: g('pan').toUpperCase(), deductor_type: g('deductor_type'),
    responsible_designation: g('rp_designation'), responsible_pan: g('rp_pan').toUpperCase(), gstn: g('gstn'),
    entity: { name: g('name'), address1: g('address1'), address2: g('address2'), address3: g('address3'),
      address4: g('address4'), town: g('town'), state_code: g('state_code'), pin: g('pin'), email: g('email'),
      std_code: g('std_code'), phone: g('phone'), country: 'INDIA' },
    responsible: { name: g('rp_name'), address1: g('rp_address1'), address2: g('rp_address2'), address3: g('rp_address3'),
      address4: g('rp_address4'), town: g('rp_town'), state_code: g('rp_state_code'), pin: g('rp_pin'),
      email: g('rp_email'), std_code: g('rp_std_code'), phone: g('rp_phone'), country: 'INDIA' },
  };
}

const NON_NUMERIC = new Set(['pan', 'name', 'category', 'regime', 'employed_from', 'employed_to', 'taxable_income',
  'higher_rate', 'rent_over_1lakh', 'interest_to_lender', 'landlord_pans', 'landlord_names', 'lender_pans', 'lender_names']);

function readSalary(wb: XLSX.WorkBook): { salary: SalaryDetail[]; missing: string[] } {
  const ws = wb.Sheets[SALARY_SHEET];
  if (!ws) return { salary: [], missing: [`Form 138 Q4 needs the "${SALARY_SHEET}" sheet (one row per employee)`] };
  const out: SalaryDetail[] = [], missing: string[] = [];
  rows(ws).forEach((r, k) => {
    const i = k + 2, who = `${SALARY_SHEET} row ${i}`;
    const g: Record<string, unknown> = Object.fromEntries(SALARY_COLS.map(([h, key]) => [key, r[h] ?? null]));
    const regime = s(g.regime).toLowerCase();
    if (regime !== 'old' && regime !== 'new') { missing.push(`${who}: regime must be Old or New`); return; }
    const cat = s(g.category).toUpperCase().slice(0, 1);
    if (!(cat in EMPLOYEE_CATEGORY)) { missing.push(`${who}: category must be G, W, S or O`); return; }
    try {
      const via: ViaItem[] = [];
      for (const sec of VIA_ORDER) {
        const ded = r[`${sec} deductible`];
        if (blank(ded) && blank(r[`${sec} gross`])) continue;
        via.push({ section: sec, deductible: num0(ded), gross: num0(r[`${sec} gross`]),
          qualifying: VIA_WITH_QUALIFYING.has(sec) ? num0(r[`${sec} qualifying`]) : null });
      }
      const split = (v: unknown) => s(v).split(',').map(x => x.trim()).filter(Boolean);
      const pairs = (p: unknown, n: unknown): [string, string][] => {
        const ps = split(p), ns = split(n);
        return ps.map((x, j) => [x, ns[j] ?? '']);
      };
      const nums: Record<string, number> = {};
      for (const [, key] of SALARY_COLS) if (!NON_NUMERIC.has(key) && !key.startsWith('via:')) nums[key] = num0(g[key]);
      out.push({
        ...(nums as unknown as Partial<SalaryDetail>),
        pan: s(g.pan).toUpperCase(), name: s(g.name), category: cat, old_regime: regime === 'old',
        employed_from: toYmd(g.employed_from), employed_to: toYmd(g.employed_to), via,
        salary_17_1: nums.salary_17_1,
        taxable_income: blank(g.taxable_income) ? null : toNumber(g.taxable_income),
        higher_rate: s(g.higher_rate).toUpperCase().slice(0, 1) || 'N',
        rent_over_1lakh: s(g.rent_over_1lakh).toUpperCase().slice(0, 1) || 'N',
        landlords: pairs(g.landlord_pans, g.landlord_names),
        interest_to_lender: s(g.interest_to_lender).toUpperCase().slice(0, 1) || 'N',
        lenders: pairs(g.lender_pans, g.lender_names),
      });
    } catch (e) {
      missing.push(`${who}: ${(e as Error).message}`);
    }
  });
  return { salary: out, missing };
}
```

## src/core/review.ts

```ts
/**
 * Review data read BACK from a return file's lines — what the user must check before running
 * Protean's FVU. Same content as the Python review workbook (protean_review.py), returned as
 * plain data for the page to show as tables (and to export with SheetJS if wanted).
 */
import { COLLECTEE_CODES, EMPLOYEE_CATEGORY, checkStatement } from './protean.ts';

const STATE: Record<string, string> = { '01': 'Andaman & Nicobar', '02': 'Andhra Pradesh', '03': 'Arunachal Pradesh',
  '04': 'Assam', '05': 'Bihar', '06': 'Chandigarh', '07': 'Dadra & Nagar Haveli', '08': 'Daman & Diu', '09': 'Delhi',
  '10': 'Goa', '11': 'Gujarat', '12': 'Haryana', '13': 'Himachal Pradesh', '14': 'Jammu & Kashmir', '15': 'Karnataka',
  '16': 'Kerala', '17': 'Lakshadweep', '18': 'Madhya Pradesh', '19': 'Maharashtra', '20': 'Manipur', '21': 'Meghalaya',
  '22': 'Mizoram', '23': 'Nagaland', '24': 'Odisha', '25': 'Puducherry', '26': 'Punjab', '27': 'Rajasthan',
  '28': 'Sikkim', '29': 'Tamil Nadu', '30': 'Tripura', '31': 'Uttar Pradesh', '32': 'West Bengal', '33': 'Chhattisgarh',
  '34': 'Uttarakhand', '35': 'Jharkhand', '36': 'Telangana', '37': 'Ladakh', '99': 'Overseas' };
const DEDUCTOR_TYPE: Record<string, string> = { A: 'Central Govt', S: 'State Govt', K: 'Company', F: 'Firm',
  P: 'Individual/HUF', T: 'Trust', J: 'Artificial juridical person', B: 'Body of individuals',
  Q: 'Association of persons', L: 'Local authority' };

const dmyToIso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}` : d);
const n = (v: string) => (v === '' ? null : Number(v));

export interface ReviewModel {
  form: string; tan: string; deductor: string; fy: string; quarter: string; prevRrr: string; software: string;
  totals: { challans: number; deducteeRows: number; distinctPans: number; amountPaid: number; taxDeducted: number;
    taxDeposited: number; challanTotal: number; batchHeaderTotal: number };
  problems: string[];                       // must be empty before running the FVU
  pointsToReview: string[];                 // FVU accepts these, but a person should look
  deductorDetails: { field: number; label: string; value: string }[];
  challans: { no: number; bsr: string; date: string; serial: string; tax: number; interest: number; fee: number;
    others: number; total: number; rows: number; thisFormTax: number; balanceForOtherForms: number; line: number }[];
  deductees: Record<string, string | number | null>[];
  salary: Record<string, string | number | null>[] | null;      // Form 138 Q4
}

const BH_LABELS: [number, string][] = [[5, 'Form'], [9, 'Previous statement RRR no.'], [13, 'TAN'], [15, 'PAN of deductor'],
  [16, 'Assessment year'], [17, 'Financial year'], [18, 'Quarter'], [19, 'Name of deductor'], [21, 'Address 1'],
  [22, 'Address 2'], [23, 'Address 3'], [24, 'Address 4'], [25, 'Town / city'], [26, 'State'], [27, 'PIN'],
  [28, 'Email'], [30, 'Telephone'], [32, 'Deductor type'], [33, 'Responsible person - name'],
  [34, 'Responsible person - designation'], [59, 'Responsible person - PAN'], [39, 'RP town / city'], [40, 'RP state'],
  [41, 'RP PIN'], [42, 'RP email'], [47, 'Total of challan amounts'], [49, 'Salary records (Form 138)'],
  [50, 'Total gross total income (Form 138 Q4)'], [52, 'Earlier regular statement filed?'], [69, 'GSTN']];

export function reviewModel(lines: string[]): ReviewModel {
  const recs = lines.map(l => ['', ...l.split('^')]);
  const fh = recs.find(f => f[2] === 'FH')!, bh = recs.find(f => f[2] === 'BH')!;
  const fyStart = Number(bh[17].slice(0, 4)), quarter = Number(bh[18].slice(1));
  const form = bh[5], tcs = form === '143';
  const problems = checkStatement(lines, fyStart, quarter);

  const challans: ReviewModel['challans'] = [];
  const deductees: ReviewModel['deductees'] = [];
  let cur: string[] | null = null;
  for (const f of recs) {
    if (f[2] === 'CD') {
      cur = f;
      challans.push({ no: +f[4], bsr: f[15], date: dmyToIso(f[19]), serial: f[17], tax: +f[8], interest: +f[9], fee: +f[10],
        others: +f[11], total: +f[12], rows: +f[5], thisFormTax: +f[21], balanceForOtherForms: +f[8] - +f[21], line: +f[1] });
    } else if (f[2] === 'DD' && cur) {
      const code = /^\d+$/.test(f[12]) ? String(+f[12]).padStart(2, '0') : '';
      deductees.push({
        challan: +f[5], rowInChallan: +f[4], pan: f[8], name: f[9], sectionCode: f[15],
        datePaid: dmyToIso(f[19]), amount: +f[20], rate: f[28] ? +f[28] : null, tax: +f[24], deposited: +f[25],
        dateDeducted: dmyToIso(f[27]), wholeTaxDeposited: f[18], reason: f[32], certificate: f[33],
        ...(tcs ? { nonResident: f[11], optingOut: f[14], collecteeCode: code ? `${code} - ${COLLECTEE_CODES[code] ?? '?'}` : '(missing)' } : {}),
        bsr: cur[15], challanSerial: cur[17], dateDeposited: dmyToIso(cur[19]), line: +f[1],
      });
    }
  }
  const pointsToReview: string[] = [];
  const same = deductees.filter(d => form === '138' && Math.abs(Number(d.amount) - Number(d.tax)) < 0.005).length;
  if (same) pointsToReview.push(`${same} salary row(s) show amount paid = TDS. The FVU accepts this, but the amount should be the salary paid/credited.`);
  const shared = challans.filter(c => c.balanceForOtherForms > 0.005).length;
  if (shared) pointsToReview.push(`${shared} challan(s) are shared with another form (balance left for other forms) - confirm that form uses the balance.`);

  let salary: ReviewModel['salary'] = null;
  const sdIdx = recs.map((f, i) => (f[2] === 'SD' ? i : -1)).filter(i => i >= 0);
  if (sdIdx.length) {
    salary = sdIdx.map((i, k) => {
      const f = recs[i], end = k + 1 < sdIdx.length ? sdIdx[k + 1] : recs.length;
      const subs = recs.slice(i + 1, end);
      return {
        sr: +f[4], pan: f[7], name: f[9], category: `${f[10]} - ${EMPLOYEE_CATEGORY[f[10]] ?? '?'}`,
        regime: f[79] === 'Y' ? 'Old' : 'New', employedFrom: dmyToIso(f[11]), employedTo: dmyToIso(f[12]),
        salary17_1: n(f[67]), perquisites17_2: n(f[68]), previousEmployer: n(f[35]), totalSalary: n(f[13]),
        hraExemption: n(f[74]), travelConcession: n(f[70]), totalExemptions: n(f[76]), section16Total: n(f[16]),
        section16Lines: subs.filter(x => x[2] === 'S16').map(x => `${x[6]} ${Number(x[7]).toLocaleString('en-IN')}`).join(', '),
        incomeUnderSalaries: n(f[17]), houseProperty: n(f[18]), otherIncome: n(f[77]), grossTotalIncome: n(f[19]),
        chapterVIALines: subs.filter(x => x[2] === 'C6A').map(x => `${x[6]} ${Number(x[7]).toLocaleString('en-IN')}`).join(', '),
        chapterVIATotal: n(f[22]), taxableIncome: n(f[23]), tax: n(f[24]), rebate87A: n(f[78]), surcharge: n(f[25]),
        cess: n(f[26]), relief89: n(f[27]), netTaxPayable: n(f[28]), tdsThisEmployer: n(f[36]),
        tdsPreviousEmployer: n(f[37]), totalTds: n(f[29]), shortfall: n(f[30]), line: +f[1],
      };
    });
    const short = salary.filter(r => Number(r.shortfall) > 1).length;
    if (short) pointsToReview.push(`${short} employee(s) have a TDS shortfall over Rs 1 - check before filing.`);
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    form, tan: bh[13], deductor: bh[19], fy: `${bh[17].slice(0, 4)}-${bh[17].slice(4)}`, quarter: bh[18],
    prevRrr: bh[9] || '(none - first statement)', software: fh[10],
    totals: { challans: challans.length, deducteeRows: deductees.length, distinctPans: new Set(deductees.map(d => d.pan)).size,
      amountPaid: sum(deductees.map(d => Number(d.amount))), taxDeducted: sum(deductees.map(d => Number(d.tax))),
      taxDeposited: sum(deductees.map(d => Number(d.deposited))), challanTotal: sum(challans.map(c => c.total)),
      batchHeaderTotal: Number(bh[47]) },
    problems, pointsToReview,
    deductorDetails: BH_LABELS.map(([i, label]) => {
      let v = bh[i] ?? '';
      if ((i === 26 || i === 40) && v) v = `${v} - ${STATE[v] ?? '?'}`;
      if (i === 32 && v) v = `${v} - ${DEDUCTOR_TYPE[v] ?? '?'}`;
      return { field: i, label, value: v };
    }),
    challans, deductees, salary,
  };
}
```

## src/core/template_columns.json

```json
{"CHALLAN_COLS": ["Challan #", "BSR code", "Challan serial no.", "Date deposited", "Tax", "Interest", "Fee", "Others", "Minor head"], "DEDUCTEE_COLS": ["Challan #", "PAN", "Name", "Section code", "Date paid / credited", "Amount", "Rate %", "Tax", "Tax deposited (blank = Tax)", "Date deducted", "Reason code (lower/no deduction)", "Certificate no."], "TCS_COLS": ["Non-resident (Y/N)", "Opting out of tax regime (Y/N)", "Collectee code (01-10)", "Permanent establishment (Y/N, non-residents)"], "DEDUCTOR_FIELDS": [["TAN", "tan"], ["PAN", "pan"], ["Name", "name"], ["Address 1 (flat/plot)", "address1"], ["Address 2 (building)", "address2"], ["Address 3 (road)", "address3"], ["Address 4 (area)", "address4"], ["Town / city", "town"], ["State code (2 digits, e.g. 12 Haryana)", "state_code"], ["PIN", "pin"], ["Email", "email"], ["STD code", "std_code"], ["Phone", "phone"], ["Deductor type (F firm, K company, P individual ...)", "deductor_type"], ["Responsible person - name", "rp_name"], ["Responsible person - designation", "rp_designation"], ["Responsible person - PAN", "rp_pan"], ["RP address 1", "rp_address1"], ["RP address 2", "rp_address2"], ["RP address 3", "rp_address3"], ["RP address 4", "rp_address4"], ["RP town / city", "rp_town"], ["RP state code", "rp_state_code"], ["RP PIN", "rp_pin"], ["RP email", "rp_email"], ["RP STD code", "rp_std_code"], ["RP phone", "rp_phone"], ["GSTN (optional)", "gstn"]], "SALARY_COLS": [["PAN", "pan"], ["Name", "name"], ["Category (G/W/S/O)", "category"], ["Regime (Old/New)", "regime"], ["Employed from", "employed_from"], ["Employed to", "employed_to"], ["Salary 17(1)", "salary_17_1"], ["Perquisites 17(2)", "perquisites_17_2"], ["Profits in lieu 17(3)", "profits_17_3"], ["Previous employer salary", "previous_employer_salary"], ["Travel concession 10(5)", "travel_concession"], ["Gratuity 10(10)", "gratuity"], ["Commuted pension 10(10A)", "commuted_pension"], ["Leave encashment 10(10AA)", "leave_encashment"], ["HRA exemption 10(13A)", "hra_exemption"], ["Other s.10 exemption", "other_exemption"], ["Allowances 10(14)", "allowances_10_14"], ["Standard deduction 16(ia)", "standard_deduction"], ["Entertainment allowance 16(ii)", "entertainment_16ii"], ["Professional tax 16(iii)", "professional_tax_16iii"], ["House property income (+) / loss (-)", "house_property"], ["Other income offered", "other_income"], ["80C gross", "via:80C:gross"], ["80C deductible", "via:80C:deductible"], ["80CCC gross", "via:80CCC:gross"], ["80CCC deductible", "via:80CCC:deductible"], ["80CCD(1) gross", "via:80CCD(1):gross"], ["80CCD(1) deductible", "via:80CCD(1):deductible"], ["80CCD(1B) gross", "via:80CCD(1B):gross"], ["80CCD(1B) deductible", "via:80CCD(1B):deductible"], ["80CCD(2) gross", "via:80CCD(2):gross"], ["80CCD(2) deductible", "via:80CCD(2):deductible"], ["80D gross", "via:80D:gross"], ["80D deductible", "via:80D:deductible"], ["80E gross", "via:80E:gross"], ["80E deductible", "via:80E:deductible"], ["80G gross", "via:80G:gross"], ["80G qualifying", "via:80G:qualifying"], ["80G deductible", "via:80G:deductible"], ["80TTA gross", "via:80TTA:gross"], ["80TTA qualifying", "via:80TTA:qualifying"], ["80TTA deductible", "via:80TTA:deductible"], ["80CCH gross", "via:80CCH:gross"], ["80CCH deductible", "via:80CCH:deductible"], ["80CCH(1) gross", "via:80CCH(1):gross"], ["80CCH(1) deductible", "via:80CCH(1):deductible"], ["OTHERS gross", "via:OTHERS:gross"], ["OTHERS qualifying", "via:OTHERS:qualifying"], ["OTHERS deductible", "via:OTHERS:deductible"], ["Taxable income (blank = computed)", "taxable_income"], ["Tax on total income", "tax"], ["Rebate 87A", "rebate_87a"], ["Surcharge", "surcharge"], ["Health & education cess", "cess"], ["Relief 89", "relief_89"], ["TDS by this employer", "tds_current"], ["TDS by previous employer", "tds_previous"], ["TDS/TCS u/s 192(2B)", "tds_192_2b"], ["Higher rate for no PAN (Y/N)", "higher_rate"], ["Rent over 1 lakh (Y/N)", "rent_over_1lakh"], ["Landlord PANs (comma separated)", "landlord_pans"], ["Landlord names (comma separated)", "landlord_names"], ["Interest to lender (Y/N)", "interest_to_lender"], ["Lender PANs (comma separated)", "lender_pans"], ["Lender names (comma separated)", "lender_names"]], "SALARY_SHEET": "Salary (Q4)"}
```

## src/core/csi.ts

```ts
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
```

## src/core/fvuResult.ts

```ts
/**
 * Phase 1 — read back what Protean's FVU reported, and point at the row to fix.
 *
 * Inputs (whichever the user uploads from the FVU output folder):
 *   <name>.err                                   caret text, one line per error (file NOT valid)
 *   <name>_Electronic_Statement_Warning_File.html warnings (file valid, but read them)
 *   <name>.html                                   statistics report (file valid)
 * plus the return lines, so each error/warning is tied to its challan / deductee / employee.
 *
 * New module — does not change the frozen core.
 */
export interface FvuIssue {
  kind: 'error' | 'warning';
  line: number;                    // line in the return file (0 = whole file)
  record: string;                  // FH / BH / CD / DD / SD / S16 / C6A as found in our file
  field: string;                   // FVU's field name or record label
  code: string;                    // e.g. T-FV-4092
  description: string;             // FVU's own text
  where: string;                   // our plain description of the row
  hint: string;                    // what usually fixes it ('' if unknown code)
}

/** Fixes learned from live FVU 1.2 runs (tds-agent Q2 / Q4 testing, Nov 2026). */
export const KNOWN_FIXES: Record<string, string> = {
  'T-FV-4092': 'Rate of deduction must have 4 decimal places. The tool writes this correctly - if you see it, the file was edited by hand.',
  'T-FV-6417': 'Form 143: give a collectee code (01-10) on every row, for residents too.',
  'T-FV-4319': 'No valid PAN: set "tax deducted at higher rate" to Y for this employee.',
  'T-FV-4015': "Employment 'to' date: cannot be in the future and must fall in the financial year. Q4 returns validate only after 31 March.",
  'T-FV-4014': "Employment 'from' date: cannot be in the future and must fall in the financial year.",
  'T-FV-3040': 'Challan date cannot be in the future - check the date, or validate after it.',
  'T-FV-3141': 'This challan is not in the CSI file. Download a fresh CSI (banks take days to report), then check the BSR code, date, serial number and amount against the challan counterfoil.',
  'T-FV-4026': 'Income under salaries is wrong: standard deduction cannot exceed the salary; income cannot be negative.',
  'T-FV-4028': 'Gross total income is wrong or negative - check salary, house property and other income.',
  'T-FV-4031': 'Taxable income is wrong: Chapter VI-A deductions cannot exceed gross total income.',
  'T-FV-4032': 'Income tax cannot be negative.',
  'T-FV-6354': 'New regime: leave HRA exemption and travel concession blank.',
  'T-FV-2092': 'Batch total of gross total income does not add up - usually caused by an invalid salary record; fix those first.',
};
const normCode = (c: string) => c.replace(/_/g, '-').toUpperCase();
const hintFor = (code: string) => KNOWN_FIXES[normCode(code)] ?? '';

function describe(lines: string[], lineNo: number): { record: string; where: string } {
  const f = (lines[lineNo - 1] ?? '').split('^');
  const rt = f[1] ?? '';
  const dmy = (d: string) => (d && d.length === 8 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : d);
  if (rt === 'CD') return { record: rt, where: `Challan ${f[3]} (BSR ${f[14]}, ${dmy(f[18])}, serial ${f[16]}, amount ${f[11]})` };
  if (rt === 'DD') return { record: rt, where: `Challan ${f[4]}, row ${f[3]}: ${f[8]} (${f[7]}), section ${f[14]}, tax ${f[23]}` };
  if (rt === 'SD') return { record: rt, where: `Employee ${f[3]}: ${f[8]} (${f[6]})` };
  if (rt === 'S16' || rt === 'C6A') return { record: rt, where: `Employee ${f[3]}, ${rt === 'S16' ? 'section 16' : 'Chapter VI-A'} line ${f[4]} (${f[5]})` };
  if (rt === 'BH') return { record: rt, where: 'Deductor / batch header' };
  if (rt === 'FH') return { record: rt, where: 'File header' };
  return { record: rt || '?', where: lineNo ? `Line ${lineNo}` : 'Whole file' };
}

/** <name>.err: "line^Regular^field^challan no^record no^code^description" per error. */
export function readErrFile(text: string, returnLines: string[]): FvuIssue[] {
  return text.split(/\r?\n/).filter(l => l.trim()).map(l => {
    const p = l.split('^');
    const codeIdx = p.findIndex(x => /^T[-_]FV[-_]\d+/i.test(x.trim()));
    const line = Number(p[0]) || 0;
    const code = codeIdx >= 0 ? p[codeIdx].trim() : '';
    const d = describe(returnLines, line);
    return { kind: 'error' as const, line, record: d.record, field: (p[2] ?? '').trim(), code,
      description: codeIdx >= 0 ? p.slice(codeIdx + 1).join('^').trim() : l.trim(), where: d.where, hint: hintFor(code) };
  });
}

const cellText = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cellText(c[1])));
}

/** <name>_Electronic_Statement_Warning_File.html: a table, one row per warning. */
export function readWarningFile(html: string, returnLines: string[]): FvuIssue[] {
  const rows = tableRows(html);
  const hi = rows.findIndex(r => r.some(c => /^Line no/i.test(c)));
  if (hi < 0) return [];
  const hdr = rows[hi].map(c => c.toLowerCase());
  const col = (re: RegExp) => hdr.findIndex(c => re.test(c));
  const [cLine, cType, cCode, cDesc] = [col(/^line no/), col(/^record type/), col(/^error code/), col(/^error desc/)];
  return rows.slice(hi + 1).filter(r => r.length >= hdr.length - 1 && r[cLine]).map(r => {
    const line = Number(r[cLine]) || 0, code = r[cCode] ?? '';
    const d = describe(returnLines, line);
    return { kind: 'warning' as const, line, record: d.record, field: r[cType] ?? '', code, description: r[cDesc] ?? '',
      where: d.where, hint: hintFor(code) };
  });
}

export interface FvuStatistics { [label: string]: string }
/** <name>.html statistics report: rows of labels, each followed by a row of values. */
export function readStatistics(html: string): FvuStatistics {
  const rows = tableRows(html).filter(r => r.some(c => c));
  const out: FvuStatistics = {};
  for (let i = 0; i + 1 < rows.length; i++) {
    const labels = rows[i], values = rows[i + 1];
    const looksLikeValues = values.every(v => /^[\d.,-]*$|^[A-Z0-9]{10}$|^(NA|Regular|Q\d|\d{4}-\d{2})$/.test(v) || v === '');
    if (labels.length > 1 && labels.length === values.length && looksLikeValues) {
      labels.forEach((l, k) => { out[l.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim()] = values[k]; });
      i++;
    }
  }
  return out;
}

/** Compare the FVU statistics with the return's own totals (from review.ts reviewModel totals). */
export function compareStatistics(stats: FvuStatistics, totals: { challans: number; deducteeRows: number; taxDeducted: number; challanTotal: number }): string[] {
  const out: string[] = [];
  const num = (k: string) => (stats[k] !== undefined ? Number(stats[k].replace(/,/g, '')) : NaN);
  const pairs: [string, number, string][] = [
    ['No. of Challans', totals.challans, 'challans'],
    ['Total Challan Amount', totals.challanTotal, 'total challan amount'],
    ['No. of Deductee Records', totals.deducteeRows, 'deductee rows'],
    ['No. of Party Records', totals.deducteeRows, 'collectee rows'],
  ];
  for (const [k, ours, label] of pairs) {
    const v = num(k);
    if (!Number.isNaN(v) && Math.abs(v - ours) > 0.005) out.push(`FVU shows ${label} ${v}, the return has ${ours}`);
  }
  return out;
}
```

## src/core/sectionCodes.ts

```ts
/**
 * Phase 2 — work out the 4-digit section code from the section as written in the working
 * ("194C", "94C", "Contract", "393(1)-6(i).D(a)", "194J(b)", "Salary 92B", "Scrap" ...).
 *
 * Rules only, no AI. Every result carries the reason. When the rules cannot decide (or the
 * section belongs in another form) the row is NOT guessed: it is returned as 'choose' with the
 * possible codes, or 'error'. A rate that does not fit the code is reported, never changed
 * (SOP rule 11: report under the section the tax was deposited in).
 *
 * The section map (sectionMap.json) gives code descriptions, rates and forms. Its "old section"
 * labels have errors, so the old-section rules below are written out here instead.
 * New module — does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import MAP from './sectionMap.json' with { type: 'json' };
import { makeTemplate } from './inputWorkbook.ts';
import type { Form } from './protean.ts';

export interface CodeInfo { ref: string; category: string; nature: string; rate: string; forms: string[] }
export const SECTION_MAP = MAP as Record<string, CodeInfo>;
export const SECTION_TEXT_COLUMN = 'Section (as in working)';

export interface SectionInput {
  text: string;                 // section as written in the working
  pan?: string;                 // payee PAN (company / non-company decides some codes)
  rate?: number | null;         // rate % from the working, if any
  form: Form;
  deductorType?: string;        // BH 32: A central govt, S state govt ... (salary codes)
}
export interface SectionResult {
  status: 'given' | 'auto' | 'choose' | 'error';
  code: string;                 // '' unless given/auto
  reason: string;
  options: { code: string; label: string }[];   // for 'choose'
  rateNote: string;             // '' or a note that the rate does not fit the code
}

const label = (c: string) => `${c} - ${SECTION_MAP[c]?.ref ?? ''} ${SECTION_MAP[c]?.nature ?? ''}`.trim();
const inForm = (c: string, form: Form) => (SECTION_MAP[c]?.forms ?? []).includes(form);
const pan4 = (pan?: string) => (pan && /^[A-Z]{5}\d{4}[A-Z]$/.test(pan.toUpperCase()) ? pan.toUpperCase()[3] : '');

function rateNote(code: string, rate?: number | null): string {
  const m = SECTION_MAP[code]?.rate.match(/^([\d.]+)%$/);
  if (!m || rate === null || rate === undefined || Number.isNaN(rate) || rate === 0) return '';
  return Math.abs(Number(m[1]) - rate) > 0.001
    ? `Rate ${rate}% in the working; the usual rate for ${code} is ${m[0]}. Check - if tax was deposited under ${code}, keep ${code} (SOP rule 11) and note the difference.`
    : '';
}

function finish(code: string, reason: string, i: SectionInput, status: 'given' | 'auto' = 'auto'): SectionResult {
  if (!SECTION_MAP[code]) return { status: 'error', code: '', reason: `Code ${code} is not in the section map`, options: [], rateNote: '' };
  if (!inForm(code, i.form)) {
    const forms = SECTION_MAP[code].forms.map(f => `Form ${f}`).join(' / ');
    return { status: 'error', code: '', options: [], rateNote: '',
      reason: `${label(code)} is reported in ${forms}, not Form ${i.form}${['141', '144'].some(f => SECTION_MAP[code].forms.includes(f)) && !SECTION_MAP[code].forms.some(f => ['138', '140', '143'].includes(f)) ? ' (that form is not supported by this tool)' : ''}.` };
  }
  return { status, code, reason, options: [], rateNote: rateNote(code, i.rate) };
}
function choose(codes: string[], reason: string, i: SectionInput): SectionResult {
  const ok = codes.filter(c => inForm(c, i.form));
  if (ok.length === 1) return finish(ok[0], `${reason} - only ${ok[0]} applies in Form ${i.form}`, i);
  if (!ok.length) return { status: 'error', code: '', reason: `${reason} - none of ${codes.join(', ')} belongs in Form ${i.form}`, options: [], rateNote: '' };
  return { status: 'choose', code: '', reason, options: ok.map(c => ({ code: c, label: label(c) })), rateNote: '' };
}
const err = (reason: string): SectionResult => ({ status: 'error', code: '', reason, options: [], rateNote: '' });

// ---------------------------------------------------------------- the rules
function contract(i: SectionInput, why: string): SectionResult {
  const p = pan4(i.pan);
  // The working's own label says which 194C section the tax went under (SOP rule 11): it decides,
  // and a PAN that says otherwise is noted, not "corrected".
  const t = (i.text ?? '').toUpperCase();
  const saysInd = /IND(IVIDUAL|IVIUAL|\.)?\s*(\/|OR|&)\s*HUF|IND\/HUF/.test(t) && !/OTHER THAN/.test(t);
  const saysOther = /OTHER(S)?\s+THAN\s+IND|CONTRACT\s+OTHERS?\b/.test(t);
  if (saysInd || saysOther) {
    const code = saysInd ? '1023' : '1024';
    const r = finish(code, `${why}; the working says ${saysInd ? 'individual/HUF' : 'other than individual/HUF'}`, i);
    const panInd = p === 'P' || p === 'H';
    if (p && panInd !== saysInd) r.rateNote = [r.rateNote, `Payee PAN 4th letter ${p} suggests ${panInd ? '1023' : '1024'}; kept ${code} as in the working (SOP rule 11) - check.`].filter(Boolean).join(' ');
    return r;
  }
  if (p === 'P' || p === 'H') return finish('1023', `${why}; payee PAN is an individual/HUF (4th letter ${p})`, i);
  if (p) return finish('1024', `${why}; payee PAN is not an individual/HUF (4th letter ${p})`, i);
  return choose(['1023', '1024'], `${why}; no valid PAN, so individual/HUF or not cannot be told`, i);
}
function salary(i: SectionInput, why: string): SectionResult {
  if (i.deductorType === 'A') return finish('1003', `${why}; deductor is the Central Government`, i);
  if (i.deductorType === 'S') return finish('1001', `${why}; deductor is a State Government`, i);
  if (i.deductorType) return finish('1002', `${why}; deductor type ${i.deductorType} (not government) - private employee`, i);
  return choose(['1001', '1002', '1003'], `${why}; deductor type not known`, i);
}
function fees(i: SectionInput, t: string, why: string): SectionResult {
  if (/DIRECTOR/.test(t)) return finish('1028', `${why}; director remuneration`, i);
  if (/TECHNICAL|ROYALTY|CALL CENT|FILM/.test(t)) return finish('1026', `${why}; technical services / royalty`, i);
  if (/\bPROF(ESSION|F\b|\.|\b)|LEGAL|AUDIT|ADVOCATE|DOCTOR|ARCHITECT/.test(t)) return finish('1027', `${why}; professional services`, i);
  if (i.rate === 2) return finish('1026', `${why}; rate 2% = technical services`, i);
  if (i.rate === 10) return finish('1027', `${why}; rate 10% = professional services (not director)`, i);
  return choose(['1026', '1027', '1028'], `${why}; technical / professional / director cannot be told from the working`, i);
}
function rent(i: SectionInput, t: string, why: string): SectionResult {
  if (/OTHER THAN (PLANT|MACHIN)/.test(t)) return finish('1009', `${why}; other than plant & machinery`, i);
  if (/PLANT|MACHIN|EQUIPMENT|VEHICLE|P\s*&\s*M\b/.test(t)) return finish('1008', `${why}; plant / machinery / equipment`, i);
  if (/BUILDING|BLDG|LAND|FURNITURE|OFFICE|PREMISES|GODOWN|WAREHOUSE|FLAT|SHOP/.test(t)) return finish('1009', `${why}; land / building / furniture`, i);
  if (i.rate === 2) return finish('1008', `${why}; rate 2% = plant & machinery`, i);
  if (i.rate === 10) return finish('1009', `${why}; rate 10% = land / building / furniture`, i);
  return choose(['1008', '1009'], `${why}; plant & machinery or building cannot be told`, i);
}
function cashKind(i: SectionInput, t: string, cash: string, kind: string, why: string): SectionResult {
  if (/KIND/.test(t)) return finish(kind, `${why}; in kind`, i);
  if (/CASH/.test(t)) return finish(cash, `${why}; in cash`, i);
  return choose([cash, kind], `${why}; cash or kind not stated`, i);
}
function tcs(i: SectionInput, t: string, why: string): SectionResult | null {
  const kw: [RegExp, string, string][] = [
    [/SCRAP/, '1073', 'sale of scrap'], [/LIQUOR|ALCOHOL/, '1068', 'alcoholic liquor'], [/TENDU/, '1069', 'tendu leaves'],
    [/TIMBER.*OTHER|OTHER.*TIMBER/, '1071', 'timber (other than forest lease)'], [/TIMBER/, '1070', 'timber under forest lease'],
    [/FOREST/, '1072', 'other forest produce'], [/MINERAL|COAL|LIGNITE|IRON ORE/, '1074', 'minerals'],
    [/MOTOR|VEHICLE|CAR\b/, '1075', 'motor vehicle'], [/WRIST|WATCH/, '1076', 'wristwatch'], [/ART/, '1077', 'art piece'],
    [/COIN|STAMP/, '1078', 'coin / stamp'], [/YACHT|BOAT|HELICOPTER/, '1079', 'yacht / boat / helicopter'],
    [/SUNGLASS/, '1080', 'sunglasses'], [/HANDBAG|PURSE/, '1081', 'handbag / purse'], [/SHOE/, '1082', 'shoes'],
    [/SPORT/, '1083', 'sportswear / equipment'], [/THEATRE|THEATER/, '1084', 'home theatre'], [/HORSE/, '1085', 'horse'],
    [/EDUCATION|MEDICAL/, '1086', 'LRS education / medical'], [/LRS|REMITTANCE/, '1087', 'LRS other purposes'],
    [/PARKING/, '1090', 'parking lot'], [/TOLL/, '1091', 'toll plaza'], [/MINE|QUARRY/, '1092', 'mine / quarry'],
  ];
  for (const [re, code, what] of kw) if (re.test(t)) return finish(code, `${why}; ${what}`, i);
  if (/TOUR/.test(t)) return choose(['1088', '1089'], `${why}; overseas tour package - up to or above the threshold?`, i);
  return null;
}

export function resolveSection(i: SectionInput): SectionResult {
  const raw = (i.text ?? '').toString();
  const t = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return err('No section given in the working');

  // 1. a 4-digit code already
  const four = t.match(/(?:^|[^\d])(1\d{3})(?:[^\d]|$)/);
  if (four && SECTION_MAP[four[1]]) return finish(four[1], `code ${four[1]} given in the working`, i, 'given');

  // 2. ITA 2025 reference, e.g. 393(1)-6(i).D(a), 394(1)-4, 392 - alone, or inside a label
  //    such as "Rent Bldg 393(1)-2(ii).D(b)" or "Contract Ind/HUF 393(1)-6(i).D(a)"
  const embedded = t.match(/39[234]\s*\(\s*\d\s*\)\s*-\s*\d+(\s*\(\s*[IVX]+\s*\))?(\s*\.\s*D\s*\(\s*[AB]\s*\))?/);
  const ref = (embedded && embedded[0] !== t ? embedded[0] : t).replace(/\s+/g, '').replace(/^(\d{3})\(1\)-(\d+)$/, '$1-$2');
  const exact = Object.entries(SECTION_MAP).filter(([, v]) => v.ref.toUpperCase() === ref).map(([c]) => c);
  const altRef = ref.replace(/^394\(1\)-/, '394-');
  const exact2 = exact.length ? exact : Object.entries(SECTION_MAP).filter(([, v]) => v.ref.toUpperCase() === altRef).map(([c]) => c);
  if (/^39[234]/.test(ref)) {
    const pref = Object.entries(SECTION_MAP).filter(([, v]) => v.ref.toUpperCase().startsWith(ref)).map(([c]) => c);
    const cands = exact2.length ? exact2 : pref;
    const inF = cands.filter(c => inForm(c, i.form));
    if (inF.length === 1) return finish(inF[0], `ITA 2025 reference ${raw.trim()}`, i);
    if (inF.every(c => ['1023', '1024'].includes(c)) && inF.length) return contract(i, `ITA 2025 reference ${raw.trim()} (contract)`);
    if (inF.every(c => ['1026', '1027', '1028'].includes(c)) && inF.length) return fees(i, t, `ITA 2025 reference ${raw.trim()} (fees)`);
    if (inF.every(c => ['1001', '1002', '1003'].includes(c)) && inF.length) return salary(i, `ITA 2025 reference ${raw.trim()} (salary)`);
    if (inF.every(c => ['1008', '1009'].includes(c)) && inF.length) return rent(i, t, `ITA 2025 reference ${raw.trim()} (rent)`);
    if (inF.length > 1) return choose(inF, `ITA 2025 reference ${raw.trim()} covers several codes`, i);
    if (cands.length) return choose(cands, `ITA 2025 reference ${raw.trim()}`, i);
  }

  // 3. old (ITA 1961) section, written loosely and anywhere in the text: "194 C", "94C", "194-J(b)",
  //    "Sec. 194Q", "CONTT. 194 C", "PROFF. 194 J", "SALARY 92B", "206C(1) scrap"
  let s = '';
  const tt = t.replace(/\b(SECTION|SEC|US|U\/S)(?=\d)/g, '$1 ');            // "Section194P" -> "Section 194P"
  const tcsHit = tt.match(/(?:^|[^0-9])206\s*-?\s*C\s*(\(\s*[0-9A-Z]{1,3}\s*\))?/);
  const secHit = tt.match(/(?:^|[^0-9A-Z])(1?9[2-6])(?![0-9])\s*-?\s*([A-Z]{1,3})?\s*(\(\s*[A-Z0-9]{1,3}\s*\))?/);
  if (tcsHit) s = `206C${(tcsHit[1] ?? '').replace(/\s+/g, '')}`;
  else if (secHit) s = `${secHit[1].length === 2 ? '1' + secHit[1] : secHit[1]}${secHit[2] ?? ''}${(secHit[3] ?? '').replace(/\s+/g, '')}`;
  const why = `section ${raw.trim()}`;
  if (/^192A/.test(s)) return finish('1004', `${why}: PF withdrawal`, i);
  if (/^192/.test(s)) return salary(i, `${why}: salary`);
  if (/^193/.test(s)) return finish('1019', `${why}: interest on securities`, i);
  if (/^194A/.test(s)) return /BANK|POST|CO-?OP/.test(t) ? choose(['1020', '1021'], `${why}: interest by a bank / post office / co-op - senior citizen or not?`, i)
    : finish('1022', `${why}: interest other than by banks`, i);
  if (/^194BB/.test(s)) return finish('1062', `${why}: horse race winnings`, i);
  if (/^194BA/.test(s)) return cashKind(i, t, '1060', '1061', `${why}: online gaming`);
  if (/^194B/.test(s)) return cashKind(i, t, '1058', '1059', `${why}: lottery / puzzle / game`);
  if (/^194C/.test(s)) return contract(i, `${why}: contract`);
  if (/^194DA/.test(s)) return finish('1030', `${why}: life insurance payout`, i);
  if (/^194D/.test(s)) return finish('1005', `${why}: insurance commission`, i);
  if (/^194EE/.test(s)) return finish('1066', `${why}: NSS withdrawal`, i);
  if (/^194E/.test(s)) return finish('1039', `${why}: non-resident sportsperson`, i);
  if (/^194G/.test(s)) return finish('1063', `${why}: commission on lottery tickets`, i);
  if (/^194H/.test(s)) return finish('1006', `${why}: commission / brokerage`, i);
  if (/^194IA/.test(s)) return finish('1010', `${why}: transfer of immovable property`, i);
  if (/^194IB/.test(s)) return finish('1007', `${why}: rent by individual / HUF`, i);
  if (/^194IC/.test(s)) return finish('1012', `${why}: compensation (joint development)`, i);
  if (/^194I\(A\)/.test(s)) return finish('1008', `${why}: rent of plant & machinery`, i);
  if (/^194I\(B\)/.test(s)) return finish('1009', `${why}: rent of land / building / furniture`, i);
  if (/^194I/.test(s)) return rent(i, t, `${why}: rent`);
  if (/^194J(A|\(A\))/.test(s)) return finish('1026', `${why}: technical services / royalty`, i);
  if (/^194J(B|\(B\))/.test(s)) return /DIRECTOR/.test(t) ? finish('1028', `${why}: director remuneration`, i) : finish('1027', `${why}: professional services`, i);
  if (/^194J/.test(s)) return fees(i, t, `${why}: fees`);
  if (/^194K/.test(s)) return finish('1013', `${why}: mutual fund units`, i);
  if (/^194LBC/.test(s)) return finish('1018', `${why}: securitisation trust`, i);
  if (/^194LBA/.test(s)) return choose(['1014', '1015', '1016', '1017'], `${why}: business trust - interest / dividend / rent / REIT?`, i);
  if (/^194M/.test(s)) return finish('1025', `${why}: payments by individuals / HUF`, i);
  if (/^194N/.test(s)) return /CO-?OP/.test(t) ? finish('1064', `${why}: cash withdrawal (co-operative society)`, i) : choose(['1064', '1065'], `${why}: cash withdrawal - co-operative society or not?`, i);
  if (/^194O/.test(s)) return finish('1035', `${why}: e-commerce operator`, i);
  if (/^194P/.test(s)) return err(`${why}: specified senior citizen (Annexure III of Form 138) is not supported by this tool`);
  if (/^194Q/.test(s)) return finish('1031', `${why}: purchase of goods`, i);
  if (/^194R/.test(s)) return cashKind(i, t, '1033', '1034', `${why}: business perquisite`);
  if (/^194S/.test(s)) return /KIND/.test(t) ? finish('1038', `${why}: virtual digital asset (kind)`, i) : finish('1037', `${why}: virtual digital asset`, i);
  if (/^194T/.test(s)) return finish('1067', `${why}: payment to partner`, i);
  if (/^194($|[^0-9A-Z])/.test(s) || /^194DIV/.test(s)) return finish('1029', `${why}: dividend`, i);
  if (/^195|^196/.test(s)) return err(`${why}: non-resident payments go in Form 144, which this tool does not support`);
  if (/^206C\(?1H/.test(s)) return err(`${why}: TCS on sale of goods (206C(1H)) no longer applies from 1 April 2025 - check the working`);
  if (/^206C/.test(s)) return tcs(i, t, `${why}: TCS`) ?? choose(Object.keys(SECTION_MAP).filter(c => inForm(c, '143')), `${why}: TCS - nature of the goods / receipt not stated`, i);

  // 4. words only (partner first: "Partner salary" is 194T, not salary)
  if (/PARTNER/.test(t)) return finish('1067', `"${raw.trim()}": payment to partner`, i);
  if (/SALAR/.test(t)) return salary(i, `"${raw.trim()}": salary`);
  if (/CONTRACT|\bCONTT\b|JOB ?WORK|TRANSPORT|LABOU?R|CARRIAGE|FREIGHT/.test(t)) return contract(i, `"${raw.trim()}": contract`);
  if (/DIRECTOR|\bPROF(ESSION|F\b|\.|\b)|TECHNICAL|ROYALTY|LEGAL|AUDIT|CONSULT/.test(t)) return fees(i, t, `"${raw.trim()}": fees`);
  if (/COMMISSION|BROKERAGE/.test(t)) return finish('1006', `"${raw.trim()}": commission / brokerage`, i);
  if (/RENT|HIRE|LEASE/.test(t)) return rent(i, t, `"${raw.trim()}": rent`);
  if (/PURCHASE|GOODS/.test(t)) return finish('1031', `"${raw.trim()}": purchase of goods`, i);
  if (/PARTNER/.test(t)) return finish('1067', `"${raw.trim()}": payment to partner`, i);
  if (/INTEREST/.test(t)) return finish('1022', `"${raw.trim()}": interest (not by a bank)`, i);
  if (i.form === '143') { const r = tcs(i, t, `"${raw.trim()}"`); if (r) return r; }
  return err(`"${raw.trim()}" not recognised - choose the code from the section map`);
}

// ---------------------------------------------------------------- workbook helpers
/** Blank input workbook with an extra "Section (as in working)" column on Deductees. */
export function makeTemplateWithSection(form: Form): Uint8Array {
  const wb = XLSX.read(makeTemplate(form), { type: 'array' });
  const ws = wb.Sheets['Deductees'];
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[];
  const at = hdr.indexOf('Section code');
  hdr.splice(at + 1, 0, SECTION_TEXT_COLUMN);
  wb.Sheets['Deductees'] = XLSX.utils.aoa_to_sheet([hdr]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

export interface RowSuggestion { row: number; pan: string; name: string; text: string; rate: number | null; result: SectionResult }

/** One suggestion per Deductees row: rows that already have a 4-digit code are checked against the form. */
export function suggestSections(data: ArrayBuffer | Uint8Array, form: Form, deductorType?: string): RowSuggestion[] {
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets['Deductees'];
  if (!ws) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const hdr = ((grid[0] ?? []) as unknown[]).map(v => String(v ?? '').trim());
  const col = (h: string) => hdr.indexOf(h);
  const [cCode, cText, cPan, cName, cRate] = [col('Section code'), col(SECTION_TEXT_COLUMN), col('PAN'), col('Name'), col('Rate %')];
  const out: RowSuggestion[] = [];
  grid.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    const code = String(r[cCode] ?? '').trim(), text = cText >= 0 ? String(r[cText] ?? '').trim() : '';
    const rateRaw = cRate >= 0 ? r[cRate] : null;
    const rate = rateRaw === null || rateRaw === '' ? null : Number(rateRaw);
    const pan = String(r[cPan] ?? '').trim().toUpperCase();
    out.push({ row: k + 2, pan, name: String(r[cName] ?? '').trim(), text: code || text, rate,
      result: resolveSection({ text: code || text, pan, rate, form, deductorType }) });
  });
  return out;
}

/** Write the chosen codes into the "Section code" column; returns new workbook bytes for the core reader. */
export function applySections(data: ArrayBuffer | Uint8Array, choices: { row: number; code: string }[]): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Deductees'];
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[];
  const c = hdr.indexOf('Section code');
  for (const { row, code } of choices) {
    if (!/^\d{4}$/.test(code)) throw new Error(`Row ${row}: "${code}" is not a 4-digit section code`);
    ws[XLSX.utils.encode_cell({ r: row - 1, c })] = { t: 's', v: code };
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
```

## src/core/sectionMap.json

```json
{
 "1001": {
  "ref": "392(7)",
  "category": "TDS on Salary",
  "nature": "Government employee (other than union)",
  "rate": "Avg Rate",
  "forms": [
   "138"
  ]
 },
 "1002": {
  "ref": "392(7)",
  "category": "TDS on Salary",
  "nature": "Private employee",
  "rate": "Avg Rate",
  "forms": [
   "138"
  ]
 },
 "1003": {
  "ref": "392(7)",
  "category": "TDS on Salary",
  "nature": "Indian government employee",
  "rate": "Avg Rate",
  "forms": [
   "138"
  ]
 },
 "1004": {
  "ref": "392(7)",
  "category": "TDS on PF Withdrawal",
  "nature": "PF Withdrawal Payment",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1005": {
  "ref": "393(1)-1(i)",
  "category": "Commission",
  "nature": "Insurance Commission",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1006": {
  "ref": "393(1)-1(ii)",
  "category": "Commission",
  "nature": "Other than insurance",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1007": {
  "ref": "393(1)-2(i)",
  "category": "Rent by Individual/HUF",
  "nature": "Rent by Individual/HUF",
  "rate": "2%",
  "forms": [
   "141"
  ]
 },
 "1008": {
  "ref": "393(1)-2(ii).D(a)",
  "category": "Rent by Specified Person",
  "nature": "Plant & Machinery",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1009": {
  "ref": "393(1)-2(ii).D(b)",
  "category": "Rent by Specified Person",
  "nature": "Building",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1010": {
  "ref": "393(1)-3(i)",
  "category": "Immovable Property",
  "nature": "Transfer of Immovable Property (Other than agri)",
  "rate": "1%",
  "forms": [
   "141"
  ]
 },
 "1011": {
  "ref": "393(1)-3(ii)",
  "category": "Immovable Property",
  "nature": "Joint Development Agreement",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1012": {
  "ref": "393(1)-3(iii)",
  "category": "Immovable Property",
  "nature": "Compensation or enhanced compensation",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1013": {
  "ref": "393(1)-4(i)",
  "category": "Specified Mutual Fund",
  "nature": "Specified Mutual Fund",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1014": {
  "ref": "393(1)-4(ii)",
  "category": "Business Trust",
  "nature": "Interest",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1015": {
  "ref": "393(1)-4(ii)",
  "category": "Business Trust",
  "nature": "Dividend",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1016": {
  "ref": "393(1)-4(ii)",
  "category": "Business Trust",
  "nature": "Rent",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1017": {
  "ref": "393(1)-4(iii)",
  "category": "Capital Market Income",
  "nature": "REIT",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1018": {
  "ref": "393(1)-4(iv)",
  "category": "Capital Market Income",
  "nature": "Securitisation Trust",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1019": {
  "ref": "393(1)-5(i)",
  "category": "Interest Income",
  "nature": "Interest on Securities",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1020": {
  "ref": "393(1)-5(ii).D(a)",
  "category": "Interest Income",
  "nature": "Interest from Banks/Post Office/Co-op Senior Citizen",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1021": {
  "ref": "393(1)-5(ii).D(b)",
  "category": "Interest Income",
  "nature": "Interest from Banks/Post Office/Co-op other than senior citizen",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1022": {
  "ref": "393(1)-5(iii)",
  "category": "Interest Income",
  "nature": "Interest other than banks",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1023": {
  "ref": "393(1)-6(i).D(a)",
  "category": "Contract, Professional & Technical",
  "nature": "Contract - Individual/HUF",
  "rate": "1%",
  "forms": [
   "140"
  ]
 },
 "1024": {
  "ref": "393(1)-6(i).D(b)",
  "category": "Contract, Professional & Technical",
  "nature": "Contract - Other than Individual/HUF",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1025": {
  "ref": "393(1)-6(ii)",
  "category": "Contract, Professional & Technical",
  "nature": "Any sum for Contract/Professional/Commission (not covered otherwise)",
  "rate": "2%",
  "forms": [
   "141"
  ]
 },
 "1026": {
  "ref": "393(1)-6(iii).D(a)",
  "category": "Contract, Professional & Technical",
  "nature": "Technical Service/Royalty/Film Distribution/Call Center",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1027": {
  "ref": "393(1)-6(iii).D(b)",
  "category": "Contract, Professional & Technical",
  "nature": "Professional Service (Other)",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1028": {
  "ref": "393(1)-6(iii).D(b)",
  "category": "Contract, Professional & Technical",
  "nature": "Director Remuneration",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1029": {
  "ref": "393(1)-7",
  "category": "Dividend",
  "nature": "Dividend from Domestic Company",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1030": {
  "ref": "393(1)-8(i)",
  "category": "Others",
  "nature": "LIC payment",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1031": {
  "ref": "393(1)-8(ii)",
  "category": "Others",
  "nature": "Purchase of Goods",
  "rate": "0.1%",
  "forms": [
   "140"
  ]
 },
 "1032": {
  "ref": "393(1)-8(iii)",
  "category": "Others",
  "nature": "Specified Senior citizen",
  "rate": "Slab rate",
  "forms": [
   "138"
  ]
 },
 "1033": {
  "ref": "393(1)-8(iv)",
  "category": "Others",
  "nature": "Perquisite & benefit (Cash)",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1034": {
  "ref": "393(1)-8(iv)-6",
  "category": "Others",
  "nature": "Perquisite & benefit (Kind)",
  "rate": "10%",
  "forms": [
   "140"
  ]
 },
 "1035": {
  "ref": "393(1)-8(v)",
  "category": "Others",
  "nature": "TDS by ECO",
  "rate": "0.1%",
  "forms": [
   "140"
  ]
 },
 "1036": {
  "ref": "393(1)-8(vi)",
  "category": "Others",
  "nature": "VDA - individual or HUF (Cash or Kind)",
  "rate": "1%",
  "forms": [
   "141"
  ]
 },
 "1037": {
  "ref": "393(1)-8(vi)",
  "category": "Others",
  "nature": "VDA- Other than individual (Cash)",
  "rate": "1%",
  "forms": [
   "140"
  ]
 },
 "1038": {
  "ref": "393(1)-8(vi)-6",
  "category": "Others",
  "nature": "VDA- Other than individual (Kind)",
  "rate": "1%",
  "forms": [
   "140"
  ]
 },
 "1039": {
  "ref": "393(2)-1",
  "category": "Others - NRI Payments",
  "nature": "Payment to Sportsperson/Sports Association (NRI)",
  "rate": "20%",
  "forms": [
   "144"
  ]
 },
 "1040": {
  "ref": "393(2)-2",
  "category": "Others - NRI Payments",
  "nature": "Interest on money borrowed in foreign currency",
  "rate": "5%",
  "forms": [
   "144"
  ]
 },
 "1041": {
  "ref": "393(2)-3",
  "category": "Others - NRI Payments",
  "nature": "Interest on Rupee Bond",
  "rate": "5%",
  "forms": [
   "144"
  ]
 },
 "1042": {
  "ref": "393(2)-4.E(a)",
  "category": "Others - NRI Payments",
  "nature": "Interest on Rupee Bond (IFSC listed before 1 July 2023)",
  "rate": "4%",
  "forms": [
   "144"
  ]
 },
 "1043": {
  "ref": "393(2)-4.E(b)",
  "category": "Others - NRI Payments",
  "nature": "Interest on Rupee Bond (IFSC listed on/after 1 July 2023)",
  "rate": "9%",
  "forms": [
   "144"
  ]
 },
 "1044": {
  "ref": "393(2)-5",
  "category": "Others - NRI Payments",
  "nature": "Interest by Infra Debt Fund (NRI)",
  "rate": "5%",
  "forms": [
   "144"
  ]
 },
 "1045": {
  "ref": "393(2)-6.E(a)",
  "category": "Others - NRI Payments",
  "nature": "Distributed income (Sec 223 Schedule V Table Sl. No. 3.B(a))",
  "rate": "5%",
  "forms": [
   "144"
  ]
 },
 "1046": {
  "ref": "393(2)-6.E(a)",
  "category": "Others - NRI Payments",
  "nature": "Distributed income (Sec 223 Schedule V Table Sl. No. 3.B(b))",
  "rate": "10%",
  "forms": [
   "144"
  ]
 },
 "1047": {
  "ref": "393(2)-7",
  "category": "Others - NRI Payments",
  "nature": "Distributed income (Sec 223 Schedule V Table Sl. No. 4)",
  "rate": "12.5%",
  "forms": [
   "144"
  ]
 },
 "1048": {
  "ref": "393(2)-8",
  "category": "Others - NRI Payments",
  "nature": "Investment Fund (Sec 224) - other than exempt under Schedule V",
  "rate": "10%",
  "forms": [
   "144"
  ]
 },
 "1049": {
  "ref": "393(2)-9",
  "category": "Others - NRI Payments",
  "nature": "Securitisation Trust (Sec 221)",
  "rate": "12.5%",
  "forms": [
   "144"
  ]
 },
 "1050": {
  "ref": "393(2)-10",
  "category": "Others - NRI Payments",
  "nature": "Units of MF (Schedule VII Table Sl. No. 20 or 21) / Specified Company",
  "rate": "20%",
  "forms": [
   "144"
  ]
 },
 "1051": {
  "ref": "393(2)-11",
  "category": "Others - NRI Payments",
  "nature": "Units referred to in Sec 208",
  "rate": "10%",
  "forms": [
   "144"
  ]
 },
 "1052": {
  "ref": "393(2)-12",
  "category": "Others - NRI Payments",
  "nature": "Long-term capital gains - Transfer of units (Sec 208)",
  "rate": "10%",
  "forms": [
   "144"
  ]
 },
 "1053": {
  "ref": "393(2)-13",
  "category": "Others - NRI Payments",
  "nature": "Interest/Dividends - Bonds/GDR (Sec 209)",
  "rate": "Rate in force",
  "forms": [
   "144"
  ]
 },
 "1054": {
  "ref": "393(2)-14",
  "category": "Others - NRI Payments",
  "nature": "Long-term capital gains - Bonds/GDR (Sec 209)",
  "rate": "12.5%",
  "forms": [
   "144"
  ]
 },
 "1055": {
  "ref": "393(2)-15",
  "category": "Others - NRI Payments",
  "nature": "Securities (Sec 210(1) Table Sl. No. 1)",
  "rate": "20%",
  "forms": [
   "144"
  ]
 },
 "1056": {
  "ref": "393(2)-16",
  "category": "Others - NRI Payments",
  "nature": "Securities (Sec 210(1) Table Sl. No. 1)",
  "rate": "10%",
  "forms": [
   "144"
  ]
 },
 "1057": {
  "ref": "393(2)-17",
  "category": "Others - NRI Payments",
  "nature": "Interest (not under Serial 2-5) or other sum (not being Salary)",
  "rate": "Rate in force",
  "forms": [
   "144"
  ]
 },
 "1058": {
  "ref": "393(3)-1",
  "category": "Payment to any person",
  "nature": "Lottery, Puzzle, Card Game, Gambling (Cash)",
  "rate": "30%",
  "forms": [
   "140"
  ]
 },
 "1059": {
  "ref": "393(3)-1-Note-2",
  "category": "Payment to any person",
  "nature": "Lottery, Puzzle, Card Game, Gambling (Kind)",
  "rate": "30%",
  "forms": [
   "140"
  ]
 },
 "1060": {
  "ref": "393(3)-2",
  "category": "Payment to any person",
  "nature": "Online Gaming - Net Winnings (Cash)",
  "rate": "30%",
  "forms": [
   "140"
  ]
 },
 "1061": {
  "ref": "393(3)-2-Note-2",
  "category": "Payment to any person",
  "nature": "Online Gaming - Net Winnings (Kind)",
  "rate": "30%",
  "forms": [
   "140"
  ]
 },
 "1062": {
  "ref": "393(3)-3",
  "category": "Payment to any person",
  "nature": "Horse Race Winnings",
  "rate": "30%",
  "forms": [
   "140"
  ]
 },
 "1063": {
  "ref": "393(3)-4",
  "category": "Payment to any person",
  "nature": "Commission on Lottery Sale",
  "rate": "2%",
  "forms": [
   "140"
  ]
 },
 "1064": {
  "ref": "393(3)-5.D(a)",
  "category": "Payment to any person",
  "nature": "TDS on Cash Withdrawal (Co-operative Society)",
  "rate": "2%",
  "forms": [
   "140",
   "144"
  ]
 },
 "1065": {
  "ref": "393(3)-5.D(b)",
  "category": "Payment to any person",
  "nature": "TDS on Cash Withdrawal (other than co-operative Society)",
  "rate": "2%",
  "forms": [
   "140",
   "144"
  ]
 },
 "1066": {
  "ref": "393(3)-6",
  "category": "Payment to any person",
  "nature": "NSS Withdrawal",
  "rate": "10%",
  "forms": [
   "140",
   "144"
  ]
 },
 "1067": {
  "ref": "393(3)-7",
  "category": "Payment to any person",
  "nature": "Payment to Partner",
  "rate": "10%",
  "forms": [
   "140",
   "144"
  ]
 },
 "1068": {
  "ref": "394-1",
  "category": "TCS",
  "nature": "Sale of Alcoholic Liquor for Human Consumption",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1069": {
  "ref": "394-2",
  "category": "TCS",
  "nature": "Sale of Tendu Leaves",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1070": {
  "ref": "394-3",
  "category": "TCS",
  "nature": "Timber obtained under forest lease",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1071": {
  "ref": "394-3",
  "category": "TCS",
  "nature": "Timber obtained other than forest lease",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1072": {
  "ref": "394-3",
  "category": "TCS",
  "nature": "Other Forest Product",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1073": {
  "ref": "394-4",
  "category": "TCS",
  "nature": "Sale of Scrap",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1074": {
  "ref": "394-5",
  "category": "TCS",
  "nature": "Sale of Minerals (Coal, Lignite, Iron Ore)",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1075": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Motor Vehicle (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1076": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Wristwatch (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1077": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Art Piece (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1078": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Coin/Stamp (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1079": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Yacht/Boat/Helicopter (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1080": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Sunglasses (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1081": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Handbag/Purse (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1082": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Shoes (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1083": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Sportswear & Sport Equipment (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1084": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Home Theatre (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1085": {
  "ref": "394-6",
  "category": "TCS",
  "nature": "Horse (Value > Rs 10 Lakh)",
  "rate": "1%",
  "forms": [
   "143"
  ]
 },
 "1086": {
  "ref": "394-7",
  "category": "TCS",
  "nature": "Remittance under LRS - Education/Medical",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1087": {
  "ref": "394-7",
  "category": "TCS",
  "nature": "Remittance under LRS - Other Purposes",
  "rate": "20%",
  "forms": [
   "143"
  ]
 },
 "1088": {
  "ref": "394(1)-8.D(a)",
  "category": "TCS",
  "nature": "Overseas Tour Package (up to threshold limit)",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1089": {
  "ref": "394(1)-8.D(b)",
  "category": "TCS",
  "nature": "Overseas Tour Package (above threshold limit)",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1090": {
  "ref": "394-9",
  "category": "TCS",
  "nature": "Parking Lot",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1091": {
  "ref": "394-9",
  "category": "TCS",
  "nature": "Toll Plaza",
  "rate": "2%",
  "forms": [
   "143"
  ]
 },
 "1092": {
  "ref": "394-9",
  "category": "TCS",
  "nature": "Mine or Quarry (except oil mining)",
  "rate": "2%",
  "forms": [
   "143"
  ]
 }
}
```

## src/core/challanMatch.ts

```ts
/**
 * Phase 3 — match deductee/collectee rows to challans by rules, and check the challans.
 *
 * Rules (no AI):
 *  - A row deducted in month M is paid by a challan dated from the 1st of M; due by the 7th of M+1
 *    (30 April for March). Later challans are allowed but late (interest is checked).
 *  - Major head must fit the payee: company PAN (4th letter C) -> 0020, others -> 0021
 *    (only when the challan's major head is given).
 *  - With a section breakup on the challan (e.g. "1023=5000; 1073=180000"), only that section's
 *    share is used; without one, the whole challan tax is available. What this form does not use
 *    stays as balance for other forms (shared challans - e.g. TCS paid with TDS).
 *  - Within Rs 1 counts as rounding.
 * Month plan (v1.5, first): each challan is tied to the month it pays - a challan with no interest
 *  to the earliest month it is on time for; a challan with interest to the month it is late for
 *  (unique, and the interest must fit 1.5% a month on at most the challan amount). Same-date pairs
 *  with no major head: the smaller is taken as 0020 when the month has company and other payees.
 *  A month's rows (per major head) go to its challan; rows that do not fit are split off to other
 *  challans with money left (top-up challans first). Section breakups only reserve the share of
 *  sections this return does not have (e.g. 1002 salary); otherwise a difference is a note.
 * Never decided here (returned as exceptions for a person, or for the Phase 4 AI to propose):
 *  rows larger than any challan, a challan dated before the month of deduction, possible duplicate
 *  challans, a typed-in challan that does not fit.
 *
 * New module — does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import type { Form, Ymd } from './protean.ts';
import { makeTemplateWithSection } from './sectionCodes.ts';

export const MAJOR_HEAD_COLUMN = 'Major head (0020 company / 0021 non-company)';
export const BREAKUP_COLUMN = 'Section breakup (code=amount; ...)';

export interface ChallanIn {
  no: number; bsr: string; serial: string; date: Ymd;
  tax: number; interest: number; fee: number; others: number;
  majorHead: string;                          // '0020' | '0021' | '' (not given)
  breakup: Record<string, number> | null;     // section code -> tax, if given
}
export interface RowIn {
  row: number; pan: string; name: string; code: string; dateDeducted: Ymd; tax: number;
  challanNo: number | null;                   // typed in the workbook, if any
}
export interface RowMatch { row: number; challanNo: number | null; status: 'given' | 'matched' | 'exception'; reason: string }
export interface ChallanUse {
  no: number; tax: number; usedHere: number; balance: number;
  interestPaid: number; interestDue: number; notes: string[];
}
export interface MatchException {
  kind: 'too-large' | 'no-challan' | 'duplicate' | 'given-mismatch' | 'interest-short';
  rows: number[]; challans: number[]; message: string;
}
export interface MatchResult { rows: RowMatch[]; challans: ChallanUse[]; exceptions: MatchException[] }

// ---------------------------------------------------------------- dates and money
const parts = (d: Ymd) => d.split('-').map(Number) as [number, number, number];
const monthKey = (d: Ymd) => d.slice(0, 7);
export function dueDate(deducted: Ymd): Ymd {
  const [y, m] = parts(deducted);
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}
/** Months for interest on late deposit: from the month of deduction to the month of payment, part months counting as whole. */
export function lateMonths(deducted: Ymd, paid: Ymd): number {
  if (paid <= dueDate(deducted)) return 0;
  const [y1, m1] = parts(deducted), [y2, m2] = parts(paid);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}
const majorHeadFor = (pan: string) => (/^[A-Z]{3}C[A-Z]\d{4}[A-Z]$/.test(pan) ? '0020' : /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? '0021' : '');
const r2 = (x: number) => Math.round(x * 100) / 100;
const inr = (x: number) => x.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export function parseBreakup(text: unknown): Record<string, number> | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const out: Record<string, number> = {};
  for (const part of t.split(/[;,\n]+/)) {
    const m = part.trim().match(/^(\d{4})\s*[=:]\s*([\d.]+)$/);
    if (!m) throw new Error(`Section breakup "${part.trim()}" should look like 1023=5000`);
    out[m[1]] = (out[m[1]] ?? 0) + Number(m[2]);
  }
  return out;
}

// ---------------------------------------------------------------- matching
export function matchChallans(challans: ChallanIn[], rows: RowIn[]): MatchResult {
  const used = new Map<string, number>();                       // `${challan}|${code or *}` -> amount used
  const capKey = (c: ChallanIn, code: string) => `${c.no}|${c.breakup ? code : '*'}`;
  const capacity = (c: ChallanIn, code: string) =>
    Math.min((c.breakup ? (c.breakup[code] ?? 0) : c.tax) - (used.get(capKey(c, code)) ?? 0), free(c));
  const usedTotal = new Map<number, number>();
  const use = (c: ChallanIn, code: string, amt: number) => {
    used.set(capKey(c, code), (used.get(capKey(c, code)) ?? 0) + amt);
    usedTotal.set(c.no, (usedTotal.get(c.no) ?? 0) + amt);
  };
  // money of a challan this return may use: its tax less the breakup share of sections this return has no rows for
  const codesHere = new Set(rows.map(r => r.code));
  const reserved = (c: ChallanIn) => (c.breakup ? Object.entries(c.breakup).filter(([k]) => !codesHere.has(k)).reduce((a, [, v]) => a + v, 0) : 0);
  const free = (c: ChallanIn) => r2(c.tax - reserved(c) - (usedTotal.get(c.no) ?? 0));
  const reserveUsed = new Set<number>();
  const byNo = new Map(challans.map(c => [c.no, c]));
  const out: RowMatch[] = [];
  const exceptions: MatchException[] = [];

  // possible duplicates: same date, same tax, same major head
  const seen = new Map<string, number[]>();
  for (const c of challans) {
    const k = `${c.date}|${c.tax}|${c.majorHead}`;
    seen.set(k, [...(seen.get(k) ?? []), c.no]);
  }
  for (const [k, nos] of seen) if (nos.length > 1)
    exceptions.push({ kind: 'duplicate', rows: [], challans: nos, message: `Challans ${nos.join(' and ')} have the same date (${k.split('|')[0]}) and amount (Rs ${inr(Number(k.split('|')[1]))}) - possible duplicate payment. Decide which one this return uses; the other may be adjusted later (needs approval).` });

  // 1. rows with a challan typed in: check, then reserve
  for (const r of rows.filter(r => r.challanNo !== null)) {
    const c = byNo.get(r.challanNo!);
    const problems: string[] = [];
    if (!c) problems.push(`challan #${r.challanNo} is not on the Challans sheet`);
    else {
      if (c.date < `${monthKey(r.dateDeducted)}-01`) problems.push(`challan dated ${c.date} is before the month of deduction (${r.dateDeducted})`);
      const mh = majorHeadFor(r.pan);
      if (c.majorHead && mh && c.majorHead !== mh) problems.push(`payee needs major head ${mh}, challan is ${c.majorHead}`);
      if (c.breakup && !(r.code in c.breakup)) problems.push(`challan breakup has no section ${r.code}`);
    }
    if (problems.length) {
      out.push({ row: r.row, challanNo: r.challanNo, status: 'exception', reason: problems.join('; ') });
      exceptions.push({ kind: 'given-mismatch', rows: [r.row], challans: c ? [c.no] : [], message: `Row ${r.row} (${r.name}): ${problems.join('; ')}.` });
    } else {
      use(c!, r.code, r.tax);
      out.push({ row: r.row, challanNo: c!.no, status: 'given', reason: `challan #${c!.no} as typed in the workbook` });
    }
  }

  const describe = (month: string, mh: string, code: string, grp: RowIn[], total: number) =>
    `${grp.length} row(s) deducted in ${month}${mh ? `, payee major head ${mh}` : ''}${code !== '*' ? `, section ${code}` : ''} (Rs ${inr(total)})`;
  const headNote = (c: ChallanIn, mh: string) => (c.majorHead && mh && c.majorHead !== mh
    ? `; challan is major head ${c.majorHead} although the payee needs ${mh} - reported as deposited (SOP rule 11), check` : '');
  const lateNote = (c: ChallanIn, month: string) => (c.date > dueDate(`${month}-01`) ? `; paid after the due date ${dueDate(`${month}-01`)}` : '');

  // 1b. MONTH PLAN (v1.5): tie challans to the month they pay, then fill and split.
  const monthsWithRows = [...new Set(rows.map(r => monthKey(r.dateDeducted)))].sort();
  const tagOf = new Map<number, string>();           // challan -> month it pays
  for (const c of challans) {
    const possible = monthsWithRows.filter(m => c.date >= `${m}-01`);
    if (c.interest > 0) {
      const late = possible.filter(m => c.date > dueDate(`${m}-01`) && c.interest / (0.015 * lateMonths(`${m}-01`, c.date)) <= c.tax * 1.02 + 1);
      if (late.length === 1) tagOf.set(c.no, late[0]);
    } else {
      const onTime = possible.filter(m => c.date <= dueDate(`${m}-01`));
      if (onTime.length) tagOf.set(c.no, onTime[0]);
    }
  }
  // same-date pairs without a major head: the smaller one is the company (0020) challan
  const headOf = new Map<number, string>(challans.map(c => [c.no, c.majorHead]));
  const headNoteOf = new Map<number, string>();
  for (const date of new Set(challans.map(c => c.date))) {
    const pair = challans.filter(c => c.date === date);
    const m = tagOf.get(pair[0]?.no);
    if (pair.length !== 2 || pair.some(c => c.majorHead) || !m || tagOf.get(pair[1].no) !== m || pair[0].tax === pair[1].tax) continue;
    const mr = rows.filter(r => monthKey(r.dateDeducted) === m);
    if (!mr.some(r => majorHeadFor(r.pan) === '0020') || !mr.some(r => majorHeadFor(r.pan) === '0021')) continue;
    const [small, big] = [...pair].sort((a, b) => a.tax - b.tax);
    headOf.set(small.no, '0020'); headOf.set(big.no, '0021');
    for (const c of pair) headNoteOf.set(c.no, `; major head not given - #${small.no} (the smaller of the two challans of ${date}) taken as 0020 and #${big.no} as 0021, check with the challan receipts`);
  }
  const planned = (r: RowIn) => {
    const m = monthKey(r.dateDeducted), mh = majorHeadFor(r.pan);
    const mine = challans.filter(c => tagOf.get(c.no) === m && c.date >= r.dateDeducted);
    const sameHead = mine.filter(c => headOf.get(c.no) === mh);
    if (sameHead.length === 1) return sameHead[0];
    if (!sameHead.length && mine.length === 1 && !headOf.get(mine[0].no)) return mine[0];
    return undefined;
  };
  {
    const g = new Map<number, RowIn[]>();
    for (const r of rows.filter(r => r.challanNo === null)) { const c = planned(r); if (c) g.set(c.no, [...(g.get(c.no) ?? []), r]); }
    const overflow: { r: RowIn; home: ChallanIn }[] = [];
    for (const [no, grp] of [...g.entries()].sort(([a], [b]) => a - b)) {
      const c = byNo.get(no)!;
      const total = r2(grp.reduce((a, r) => a + r.tax, 0));
      const fits = total <= free(c) + 1;
      // if not all fit, keep the most rows by value: largest first while they fit, the rest overflow
      const take = fits ? grp : [];
      if (!fits) { let left = free(c); for (const r of [...grp].sort((a, b) => b.tax - a.tax)) if (r.tax <= left + 1) { take.push(r); left = r2(left - r.tax); } }
      const m = monthKey(grp[0].dateDeducted);
      for (const r of take) {
        use(c, r.code, r.tax);
        out.push({ row: r.row, challanNo: c.no, status: 'matched',
          reason: `deducted in ${m} -> challan #${c.no} of ${c.date}, the challan for ${m}${c.interest > 0 ? ' (paid late, with interest)' : ''}${headOf.get(c.no) ? `, major head ${headOf.get(c.no)}` : ''}${headNoteOf.get(c.no) ?? ''}${headNote({ ...c, majorHead: headOf.get(c.no) ?? '' }, majorHeadFor(r.pan))}${lateNote(c, m)}` });
      }
      for (const r of grp) if (!take.includes(r)) overflow.push({ r, home: c });
    }
    // split: overflow rows to other challans with money left - same major head, dated after the deduction;
    // challans not tied to a month (top-ups) first, then by date
    for (const { r, home } of overflow.sort((a, b) => b.r.tax - a.r.tax)) {
      const mh = majorHeadFor(r.pan);
      // same major head first (top-ups, then by date); the other head only as a last resort (SOP rule 11, noted)
      const sameHead = (c: ChallanIn) => !headOf.get(c.no) || !mh || headOf.get(c.no) === mh;
      const cands = challans.filter(c => c.no !== home.no && c.date >= r.dateDeducted && free(c) + 1 >= r.tax)
        .sort((a, b) => (sameHead(a) ? 0 : 1) - (sameHead(b) ? 0 : 1) || (tagOf.has(a.no) ? 1 : 0) - (tagOf.has(b.no) ? 1 : 0) || a.date.localeCompare(b.date));
      const c = cands[0];
      if (!c) continue;                                  // left for the passes / exceptions below
      use(c, r.code, r.tax);
      const m = monthKey(r.dateDeducted);
      out.push({ row: r.row, challanNo: c.no, status: 'matched',
        reason: `deducted in ${m}; the challan for ${m} (#${home.no}) has no room left, so split off to challan #${c.no} of ${c.date} (Rs ${inr(free(c))} left there)${headNote({ ...c, majorHead: headOf.get(c.no) ?? '' }, mh)}${lateNote(c, m)}` });
    }
  }

  // 2. the rest. Passes, most certain first:
  //    a. with a section breakup on the challans: by month + section, using that section's share
  //    b. without: a challan whose amount EXACTLY equals a section's rows for the month
  //    c. a challan whose amount exactly equals all of the month's rows (per major head)
  //    d. only ONE challan can take the month's rows -> that one (balance noted)
  //    otherwise: an exception (ambiguous / too large / no challan) - never a guess.
  //    Major head: the payee's first; if no challan fits, the other one (SOP rule 11: tax deposited
  //    under the other head is reported as deposited), with a note.
  const anyBreakup = challans.some(c => c.breakup);
  const pending = () => rows.filter(r => r.challanNo === null && !out.some(m => m.row === r.row));
  const groupBy = (rs: RowIn[], withCode: boolean) => {
    const g = new Map<string, RowIn[]>();
    for (const r of rs) { const k = `${monthKey(r.dateDeducted)}|${majorHeadFor(r.pan)}|${withCode ? r.code : '*'}`; g.set(k, [...(g.get(k) ?? []), r]); }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  // A challan can only pay tax already deducted: its date must be on/after the LATEST deduction in the group.
  let groupFrom = '';
  const candidates = (month: string, code: string, mhWanted: string, otherHead: boolean) => {
    const due = dueDate(`${month}-01`);
    return challans.filter(c => c.date >= (groupFrom || `${month}-01`))
      .filter(c => !c.majorHead || !mhWanted || (otherHead ? c.majorHead !== mhWanted : c.majorHead === mhWanted))
      .filter(c => code === '*' || !c.breakup || (c.breakup[code] ?? 0) > 0)
      .sort((a, b) => (a.date <= due) === (b.date <= due) ? a.date.localeCompare(b.date) : (a.date <= due ? -1 : 1));
  };

  // A pass groups the pending rows (by month, optionally section, optionally payee major head) and
  // either looks for an EXACT amount (challan, or its section share) or the EARLIEST challan that
  // can take the rows. Earliest = the first deposit after the deduction; a tie on that date is
  // ambiguous and is never decided here.
  const runPass = (withCode: boolean, withHead: boolean, mode: 'exact' | 'fit') => {
    const g = new Map<string, RowIn[]>();
    for (const r of pending()) {
      const k = `${monthKey(r.dateDeducted)}|${withHead ? majorHeadFor(r.pan) : ''}|${withCode ? r.code : '*'}`;
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    for (const [k, grp] of [...g.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [month, mh, code] = k.split('|');
      const total = r2(grp.reduce((a, r) => a + r.tax, 0));
      groupFrom = grp.map(r => r.dateDeducted).sort().at(-1)!;
      for (const other of withHead ? [false, true] : [false]) {
        // a challan with a breakup can only serve a single-section group, from that section's share
        const cands = candidates(month, code, mh, other).filter(c => code !== '*' || !c.breakup);
        const cap = (c: ChallanIn) => capacity(c, c.breakup ? code : '*');
        let pick: ChallanIn | undefined, how = '';
        if (mode === 'exact') {
          const exact = cands.filter(c => Math.abs(cap(c) - total) <= 1);
          const first = exact.filter(c => c.date === exact[0]?.date);
          if (first.length === 1) { pick = first[0]; how = pick.breakup ? `its section ${code} share equals these rows exactly` : 'challan amount equals these rows exactly'; }
        } else {
          const fits = cands.filter(c => cap(c) + 1 >= total).sort((a, b) => a.date.localeCompare(b.date));
          const first = fits.filter(c => c.date === fits[0]?.date);
          if (first.length === 1) { pick = first[0]; how = `first challan after the deduction that can take these rows; Rs ${inr(r2(cap(pick) - total))} left${pick.breakup ? ` in its section ${code} share` : ''} - balance for other forms or rows`; }
          else if (first.length > 1) {
            const msg = `${describe(month, mh, code, grp, total)}: challans ${first.map(c => '#' + c.no).join(', ')} (same date ${first[0].date}) could each take these rows. Add the section breakup / major head on the challans, or choose (needs a decision).`;
            exceptions.push({ kind: 'too-large', rows: grp.map(r => r.row), challans: first.map(c => c.no), message: msg });
            for (const r of grp) out.push({ row: r.row, challanNo: null, status: 'exception', reason: msg });
            break;
          }
        }
        if (pick) {
          for (const r of grp) {
            const rmh = majorHeadFor(r.pan);
            use(pick, pick.breakup ? r.code : '*', r.tax);
            out.push({ row: r.row, challanNo: pick.no, status: 'matched',
              reason: `${describe(month, mh, code, grp, total)} -> challan #${pick.no} of ${pick.date}; ${how}${headNote(pick, rmh)}${lateNote(pick, month)}` });
          }
          break;
        }
      }
    }
  };
  runPass(true, false, 'exact');      // a section's rows for the month = the challan (or its section share)
  runPass(true, true, 'exact');       // ... per payee major head
  runPass(false, false, 'exact');     // all the month's rows = the challan
  runPass(false, true, 'exact');      // ... per payee major head
  runPass(true, true, 'fit');         // earliest challan (section share) that can take a section's rows
  runPass(false, true, 'fit');        // earliest challan that can take the month's rows

  // last resort: a challan's share reserved for sections this return does not have (e.g. 1002 salary)
  // is used only when nothing else is left - with a note to check the other return still has enough
  for (const r of pending().sort((a, b) => b.tax - a.tax)) {
    const mh = majorHeadFor(r.pan), m = monthKey(r.dateDeducted);
    const sameHead = (c: ChallanIn) => !headOf.get(c.no) || !mh || headOf.get(c.no) === mh;
    const c = challans.filter(c => reserved(c) > 0 && c.date >= r.dateDeducted && c.tax - (usedTotal.get(c.no) ?? 0) + 1 >= r.tax)
      .sort((a, b) => (sameHead(a) ? 0 : 1) - (sameHead(b) ? 0 : 1) || (tagOf.get(a.no) === m ? 0 : 1) - (tagOf.get(b.no) === m ? 0 : 1) || a.date.localeCompare(b.date))[0];
    if (!c) continue;
    use(c, r.code, r.tax);
    const other = Object.keys(c.breakup!).filter(k => !codesHere.has(k)).join(', ');
    out.push({ row: r.row, challanNo: c.no, status: 'matched',
      reason: `deducted in ${m}; no challan has room left for this return's sections, so it uses part of challan #${c.no}'s share for section ${other} (another return) - check that return still has enough${headNote({ ...c, majorHead: headOf.get(c.no) ?? '' }, mh)}${lateNote(c, m)}` });
    reserveUsed.add(c.no);
  }

  // whatever is left: no challan, or too large for any one challan
  for (const [k, grp] of groupBy(pending(), anyBreakup)) {
    const [month, mh, code] = k.split('|');
    const total = r2(grp.reduce((a, r) => a + r.tax, 0));
    groupFrom = grp.map(r => r.dateDeducted).sort().at(-1)!;
    const cands = [...candidates(month, code, mh, false), ...candidates(month, code, mh, true)];
    const msg = cands.length
      ? `${describe(month, mh, code, grp, total)}: no single challan has enough left (most left: Rs ${inr(r2(Math.max(0, ...cands.map(c => capacity(c, c.breakup ? code : '*')))))}). Split across challans, a short deposit, or a challan missing from the sheet - needs a decision.`
      : `${describe(month, mh, code, grp, total)}: no challan dated on or after ${groupFrom}${code !== '*' ? ` covering section ${code}` : ''}.Add the challan, or decide how this is to be paid (needs a decision).`;
    exceptions.push({ kind: cands.length ? 'too-large' : 'no-challan', rows: grp.map(r => r.row), challans: [...new Set(cands.map(c => c.no))], message: msg });
    for (const r of grp) out.push({ row: r.row, challanNo: null, status: 'exception', reason: msg });
  }

  // 3. per-challan summary: use, balance, interest on late deposit
  const rowByNo = new Map(rows.map(r => [r.row, r]));
  const useSummary: ChallanUse[] = challans.map(c => {
    const mine = out.filter(m => m.challanNo === c.no && m.status !== 'exception').map(m => rowByNo.get(m.row)!);
    const usedHere = r2(mine.reduce((a, r) => a + r.tax, 0));
    const interestDue = Math.round(mine.reduce((a, r) => a + r.tax * 0.015 * lateMonths(r.dateDeducted, c.date), 0));
    const notes: string[] = [];
    const balance = r2(c.tax - usedHere);
    if (!mine.length) notes.push('not used by this return (may belong to another form or quarter)');
    else if (balance > 1) notes.push(`Rs ${inr(balance)} not used by this return - must be used by another form, or is excess`);
    if (reserveUsed.has(c.no)) notes.push(`part of the share for sections this return does not have was used (Rs ${inr(r2(usedHere - (c.tax - reserved(c))))}) - check the other return (e.g. salary, Form 138) still has enough`);
    else if (c.breakup && mine.length) {
      const diff = Object.entries(c.breakup).filter(([k]) => codesHere.has(k)).map(([k, v]) => [k, r2(mine.filter(r => r.code === k).reduce((a, r) => a + r.tax, 0) - v)] as const).filter(([, d]) => Math.abs(d) > 1);
      if (diff.length) notes.push(`rows by section differ from the challan's section breakup (${diff.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${inr(d)}`).join(', ')}) - allowed, but check`);
    }
    if (c.breakup) {
      const bsum = r2(Object.values(c.breakup).reduce((a, b) => a + b, 0));
      if (Math.abs(bsum - c.tax) > 1) notes.push(`section breakup adds to Rs ${inr(bsum)}, challan tax is Rs ${inr(c.tax)}`);
    }
    if (interestDue > c.interest + 1) {
      notes.push(`late deposit: interest due about Rs ${inr(interestDue)}, paid Rs ${inr(c.interest)}`);
      exceptions.push({ kind: 'interest-short', rows: mine.map(r => r.row), challans: [c.no], message: `Challan #${c.no} of ${c.date}: interest on late deposit about Rs ${inr(interestDue)} (1.5% a month or part), challan shows Rs ${inr(c.interest)}. Pay the shortfall or check the dates.` });
    }
    return { no: c.no, tax: c.tax, usedHere, balance, interestPaid: c.interest, interestDue, notes };
  });
  out.sort((a, b) => a.row - b.row);
  return { rows: out, challans: useSummary, exceptions };
}

// ---------------------------------------------------------------- workbook helpers
/** Blank input workbook with the Phase 2 section column and the Phase 3 challan columns. */
export function makeTemplateFull(form: Form): Uint8Array {
  const wb = XLSX.read(makeTemplateWithSection(form), { type: 'array' });
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Challans'], { header: 1 })[0] ?? []) as string[];
  wb.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([[...hdr, MAJOR_HEAD_COLUMN, BREAKUP_COLUMN]]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

const serialToYmd = (v: unknown): Ymd => {
  if (typeof v === 'number') { const d = new Date(Math.floor(v) * 86400000 + Date.UTC(1899, 11, 30)); return d.toISOString().slice(0, 10); }
  const s = String(v ?? '').trim(); const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  throw new Error(`Cannot read date "${s}"`);
};
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(String(v).replace(/,/g, '')));

/** Read challans and rows for matching. Section codes must already be filled (Phase 2 applySections). */
/**
 * Tax column check (v1.5): Tax should be about Amount x Rate % / 100. A Tax equal to Amount x Rate
 * (the /100 left out of a formula) makes every row 100 times too big - that stops matching.
 * Other differences over Rs 1 are only warnings (lower deduction, rounding to rupees, short deduction).
 */
export function checkTaxColumn(rows: { row: number; amount: number; rate: number; tax: number }[]): { problems: string[]; warnings: string[] } {
  const hundred = rows.filter(r => r.amount > 0 && r.rate > 0 && r.tax > 0 && Math.abs(r.tax - r.amount * r.rate) <= Math.max(1, r.amount * r.rate * 0.001));
  const other = rows.filter(r => r.amount > 0 && r.rate > 0 && !hundred.includes(r) && Math.abs(r.tax - r.amount * r.rate / 100) > 1);
  const problems: string[] = [];
  if (hundred.length) {
    const e = hundred[0];
    problems.push(`Tax looks like Amount x Rate % without dividing by 100 on ${hundred.length} row(s) - e.g. row ${e.row}: ${inr(e.amount)} x ${e.rate} = ${inr(e.tax)}, but the tax should be about ${inr(r2(e.amount * e.rate / 100))}. Correct the Tax column (if it is a formula, e.g. =G2*H2/100) and upload again. Put the tax actually deducted, as in the books.`);
  }
  const warnings = other.slice(0, 20).map(r => `Row ${r.row}: Tax ${inr(r.tax)} differs from Amount x Rate % (${inr(r2(r.amount * r.rate / 100))}) - fine if it is the tax actually deducted (lower deduction, rounding); otherwise correct it`);
  if (other.length > 20) warnings.push(`... and ${other.length - 20} more row(s) like this`);
  return { problems, warnings };
}

export function readForMatching(data: ArrayBuffer | Uint8Array): { challans: ChallanIn[]; rows: RowIn[]; problems: string[]; warnings: string[] } {
  const wb = XLSX.read(data, { type: 'array' });
  const grid = (sh: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sh], { header: 1, raw: true, defval: null });
  const problems: string[] = [];
  const cg = grid('Challans'), ch = (cg[0] ?? []).map(v => String(v ?? '').trim());
  const ci = (h: string) => ch.indexOf(h);
  const challans: ChallanIn[] = [];
  cg.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    try {
      challans.push({
        no: Number(r[ci('Challan #')]), bsr: String(r[ci('BSR code')] ?? '').padStart(7, '0'),
        serial: String(r[ci('Challan serial no.')] ?? '').padStart(5, '0'), date: serialToYmd(r[ci('Date deposited')]),
        tax: num(r[ci('Tax')]), interest: num(r[ci('Interest')]), fee: num(r[ci('Fee')]), others: num(r[ci('Others')]),
        majorHead: ci(MAJOR_HEAD_COLUMN) >= 0 ? String(r[ci(MAJOR_HEAD_COLUMN)] ?? '').trim().padStart(4, '0').replace(/^0000$/, '') : '',
        breakup: ci(BREAKUP_COLUMN) >= 0 ? parseBreakup(r[ci(BREAKUP_COLUMN)]) : null,
      });
    } catch (e) { problems.push(`Challans row ${k + 2}: ${(e as Error).message}`); }
  });
  const dg = grid('Deductees'), dh = (dg[0] ?? []).map(v => String(v ?? '').trim());
  const di = (h: string) => dh.indexOf(h);
  const rows: RowIn[] = [];
  dg.slice(1).forEach((r, k) => {
    if (!r.some(v => v !== null && v !== '')) return;
    const code = String(r[di('Section code')] ?? '').trim();
    if (!/^\d{4}$/.test(code)) { problems.push(`Deductees row ${k + 2}: section code missing - work out section codes first`); return; }
    try {
      const cn = r[di('Challan #')];
      rows.push({ row: k + 2, pan: String(r[di('PAN')] ?? '').trim().toUpperCase(), name: String(r[di('Name')] ?? '').trim(), code,
        dateDeducted: serialToYmd(r[di('Date deducted')]), tax: num(r[di('Tax')]),
        challanNo: cn === null || cn === '' ? null : Number(cn) });
    } catch (e) { problems.push(`Deductees row ${k + 2}: ${(e as Error).message}`); }
  });
  const amt = di('Amount'), rate = di('Rate %');
  const tc = amt >= 0 && rate >= 0 ? checkTaxColumn(dg.slice(1).map((r, k) => ({ row: k + 2, amount: num(r[amt]), rate: num(r[rate]), tax: num(r[di('Tax')]) })).filter(r => r.amount || r.tax))
    : { problems: [], warnings: [] };
  return { challans, rows, problems: [...tc.problems, ...problems], warnings: tc.warnings };
}

/** Write the matched challan numbers into the Deductees "Challan #" column (approved rows only). */
export function applyChallanMatches(data: ArrayBuffer | Uint8Array, matches: { row: number; challanNo: number }[]): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Deductees'];
  const hdr = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[];
  const c = hdr.indexOf('Challan #');
  for (const { row, challanNo } of matches) ws[XLSX.utils.encode_cell({ r: row - 1, c })] = { t: 'n', v: challanNo };
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
```

## src/core/challanPdf.ts

```ts
/**
 * Phase 4a — read challan receipts (PDF) into the Challans sheet.
 *
 * The e-filing portal's "Challan Receipt" (ITNS 281) is a text PDF with fixed labels, including a
 * section-wise table with the 4-digit codes. So it is read by RULES, in the browser - nothing is
 * sent anywhere. Every read is cross-checked (section amounts = tax; tax breakup = receipt total);
 * a receipt that fails is not used.
 *
 * Gemini is only a fallback for a receipt in another layout: maskReceiptText() removes the TAN, PAN,
 * name, CIN and bank reference first, and geminiChallanRequest() builds the request. Scanned
 * (image-only) PDFs cannot be masked, so they are refused - type those challans in.
 *
 * New module — does not change the frozen core.
 */
import * as XLSX from 'xlsx';
import { BREAKUP_COLUMN, MAJOR_HEAD_COLUMN } from './challanMatch.ts';
import type { Ymd } from './protean.ts';

export interface ChallanReceipt {
  bsr: string; serial: string; tenderDate: Ymd; depositDate: Ymd | null; cin: string;
  majorHead: string; minorHead: string;
  tax: number; surcharge: number; cess: number; interest: number; penalty: number; fee: number; others: number; total: number;
  breakup: Record<string, number>;   // section code -> tax + surcharge + cess for that section
  source: 'rules' | 'gemini';
}
export interface ReadResult { ok: boolean; receipt: ChallanReceipt | null; problems: string[] }

// ---------------------------------------------------------------- text from the PDF (pdf.js)
/** Minimal shape of pdf.js used here, so browser and Node builds both fit. */
interface PdfJs { getDocument(src: { data: Uint8Array; useSystemFonts?: boolean; disableFontFace?: boolean }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }> } }

/** Text of a PDF, rebuilt line by line (items grouped by their vertical position). */
export async function pdfText(data: Uint8Array, pdfjs: PdfJs): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      const key = [...rows.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
      rows.set(key, [...(rows.get(key) ?? []), { x: it.transform[4], s: it.str }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) out.push(rows.get(y)!.sort((a, b) => a.x - b.x).map(r => r.s).join(' '));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- the rules
const money = (s: string | undefined) => (s === undefined ? NaN : Number(s.replace(/[₹,\s]/g, '')));
const ymdFromDmy = (d: string) => { const [dd, mm, yy] = d.split(/[/-]/); return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; };
const MON: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

export function parseChallanReceipt(text: string): ReadResult {
  const t = text.replace(/ /g, ' ');
  const one = (re: RegExp) => t.match(re)?.[1]?.trim();
  const problems: string[] = [];
  if (!/Challan Receipt/i.test(t) || !/BSR\s*code/i.test(t)) return { ok: false, receipt: null, problems: ['Not an e-filing portal challan receipt (layout not recognised)'] };

  const bsr = one(/BSR\s*code\s*:\s*(\d{7})/i) ?? '';
  const serial = one(/Challan\s*No\.?\s*:\s*(\d{1,5})/i) ?? '';
  const tender = one(/Tender\s*Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const dep = t.match(/Date\s*of\s*Deposit\s*:\s*(\d{2})-([A-Za-z]{3})-(\d{4})/i);
  const majorHead = one(/Major\s*Head\s*:[^\n]*?\((00\d{2})\)/i) ?? '';
  const minorHead = one(/Minor\s*Head\s*:[^\n]*?\((\d{3})\)/i) ?? '';
  const cin = one(/CIN\s*:\s*([0-9A-Z]{14,20})/i) ?? '';
  const brk = (label: string) => money(t.match(new RegExp(`\\b${label}\\s+₹\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'))?.[1]);
  const tax = brk('A\\s+Tax'), surcharge = brk('B\\s+Surcharge'), cess = brk('C\\s+Education\\s+Cess'), interest = brk('D\\s+Interest'),
    penalty = brk('E\\s+Penalty'), fee = brk('F\\s+Fee[^₹\\n]*'), others = brk('G\\s+Others');
  const total = money(t.match(/Total\s*\(A\+B\+C\+D\+E\+F\+G\)\s*₹\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
  const amount = money(t.match(/Amount\s*\(in\s*Rs\.?\)\s*:\s*₹\s*([\d,]+(?:\.\d+)?)/i)?.[1]);

  // section-wise table: "<code> ₹ tax ₹ surcharge ₹ cess ₹ total" (code is 1001-1092)
  const breakup: Record<string, number> = {};
  for (const m of t.matchAll(/\b(10\d{2})\s+₹\s*([\d,]+)\s+₹\s*([\d,]+)\s+₹\s*([\d,]+)\s+₹\s*([\d,]+)/g))
    breakup[m[1]] = (breakup[m[1]] ?? 0) + money(m[5]);

  if (!/^\d{7}$/.test(bsr)) problems.push('BSR code not found');
  if (!serial) problems.push('Challan number not found');
  if (!tender) problems.push('Tender date not found');
  if (!majorHead) problems.push('Major head code not found');
  for (const [k, v] of Object.entries({ tax, interest, fee, others, total })) if (Number.isNaN(v)) problems.push(`${k} not found in the tax breakup`);
  const bsum = Object.values(breakup).reduce((a, b) => a + b, 0);
  const abc = tax + (surcharge || 0) + (cess || 0);
  if (!Object.keys(breakup).length) problems.push('Section-wise table not found');
  else if (Math.abs(bsum - abc) > 0.5) problems.push(`Section amounts add to ${bsum}, tax + surcharge + cess is ${abc} - the table was not read completely`);
  if (!Number.isNaN(total) && Math.abs(abc + (interest || 0) + (penalty || 0) + (fee || 0) + (others || 0) - total) > 0.5) problems.push('Tax breakup does not add up to the total');
  if (!Number.isNaN(amount) && !Number.isNaN(total) && Math.abs(amount - total) > 0.5) problems.push(`Amount ${amount} differs from the breakup total ${total}`);

  if (problems.length) return { ok: false, receipt: null, problems };
  return { ok: true, problems: [], receipt: {
    bsr, serial: serial.padStart(5, '0'), tenderDate: ymdFromDmy(tender!), cin, majorHead, minorHead,
    depositDate: dep ? `${dep[3]}-${MON[dep[2].toUpperCase()]}-${dep[1]}` : null,
    tax: abc, surcharge: surcharge || 0, cess: cess || 0, interest: interest || 0, penalty: penalty || 0, fee: fee || 0, others: others || 0,
    total, breakup, source: 'rules',
  } };
}

/** Read several receipt PDFs; duplicates (same BSR + date + serial) are reported once. */
export async function readChallanPdfs(files: { name: string; data: Uint8Array }[], pdfjs: PdfJs):
  Promise<{ name: string; result: ReadResult; text: string }[]> {
  const out: { name: string; result: ReadResult; text: string }[] = [];
  for (const f of files) {
    let text = '';
    try { text = await pdfText(f.data, pdfjs); } catch (e) { out.push({ name: f.name, text: '', result: { ok: false, receipt: null, problems: [`Could not open the PDF: ${(e as Error).message}`] } }); continue; }
    if (text.replace(/\s/g, '').length < 50) { out.push({ name: f.name, text, result: { ok: false, receipt: null, problems: ['No text in this PDF (scanned image?). It cannot be masked, so it is not sent to AI - type this challan in.'] } }); continue; }
    out.push({ name: f.name, text, result: parseChallanReceipt(text) });
  }
  const seen = new Map<string, string>();
  for (const o of out) {
    const r = o.result.receipt; if (!r) continue;
    const k = `${r.bsr}|${r.tenderDate}|${r.serial}`;
    if (seen.has(k)) { o.result = { ok: false, receipt: null, problems: [`Same challan as ${seen.get(k)} - not added twice`] }; } else seen.set(k, o.name);
  }
  return out;
}

/** Put read receipts on the Challans sheet (numbered after any challans already there). */
export function addChallansToWorkbook(data: ArrayBuffer | Uint8Array, receipts: ChallanReceipt[]): Uint8Array {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const ws = wb.Sheets['Challans'];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const hdr = (grid[0] ?? []).map(v => String(v ?? '')) as string[];
  for (const h of [MAJOR_HEAD_COLUMN, BREAKUP_COLUMN]) if (!hdr.includes(h)) hdr.push(h);
  const body = grid.slice(1).filter(r => r.some(v => v !== null && v !== ''));
  let next = Math.max(0, ...body.map(r => Number(r[hdr.indexOf('Challan #')]) || 0)) + 1;
  for (const r of [...receipts].sort((a, b) => a.tenderDate.localeCompare(b.tenderDate))) {
    const row: unknown[] = new Array(hdr.length).fill(null);
    const set = (h: string, v: unknown) => { row[hdr.indexOf(h)] = v; };
    const [y, m, d] = r.tenderDate.split('-');
    set('Challan #', next++); set('BSR code', r.bsr); set('Challan serial no.', r.serial); set('Date deposited', `${d}/${m}/${y}`);
    set('Tax', r.tax); set('Interest', r.interest); set('Fee', r.fee); set('Others', r.others + r.penalty); set('Minor head', r.minorHead || '200');
    set(MAJOR_HEAD_COLUMN, r.majorHead);
    set(BREAKUP_COLUMN, Object.entries(r.breakup).map(([c, v]) => `${c}=${v}`).join('; '));
    body.push(row);
  }
  wb.Sheets['Challans'] = XLSX.utils.aoa_to_sheet([hdr, ...body]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

// ---------------------------------------------------------------- Gemini fallback (masked)
/** Remove what identifies the deductor or a person before any text leaves the browser. */
export function maskReceiptText(text: string): string {
  return text
    .replace(/\b[A-Z]{4}\d{5}[A-Z]\b/g, '[TAN]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]')
    .replace(/^(\s*(Name|Deductor|Collector|Taxpayer|Assessee)[^:\n]*:).*$/gim, '$1 [NAME]')
    .replace(/^(\s*CIN\s*:).*$/gim, '$1 [CIN]')
    .replace(/^(\s*Bank\s*Reference[^:\n]*:).*$/gim, '$1 [REF]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .replace(/\b\d{10}\b/g, '[NUMBER]');
}

/** Request for Gemini (responseMimeType 'application/json' + this schema). The text must already be masked. */
export function geminiChallanRequest(maskedText: string) {
  if (/\b[A-Z]{5}\d{4}[A-Z]\b|\b[A-Z]{4}\d{5}[A-Z]\b/.test(maskedText)) throw new Error('Text is not masked - refusing to build the request');
  return {
    systemInstruction: 'You read Indian income-tax challan receipts (TDS/TCS, ITNS 281). Return ONLY the JSON asked for. Never guess: use null for anything not printed in the text. Amounts in rupees as numbers. Dates as DD/MM/YYYY exactly as printed.',
    prompt: `Extract the challan details from this receipt text (identifiers have been replaced by placeholders):\n\n${maskedText}`,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        bsr: { type: 'STRING', nullable: true }, challanNo: { type: 'STRING', nullable: true }, tenderDate: { type: 'STRING', nullable: true },
        majorHead: { type: 'STRING', nullable: true, description: '4 digits, e.g. 0020 or 0021' }, minorHead: { type: 'STRING', nullable: true },
        tax: { type: 'NUMBER', nullable: true }, surcharge: { type: 'NUMBER', nullable: true }, cess: { type: 'NUMBER', nullable: true },
        interest: { type: 'NUMBER', nullable: true }, penalty: { type: 'NUMBER', nullable: true }, fee: { type: 'NUMBER', nullable: true },
        others: { type: 'NUMBER', nullable: true }, total: { type: 'NUMBER', nullable: true },
        sections: { type: 'ARRAY', items: { type: 'OBJECT', properties: { code: { type: 'STRING' }, amount: { type: 'NUMBER' } }, required: ['code', 'amount'] } },
      },
      required: ['bsr', 'challanNo', 'tenderDate', 'tax', 'total', 'sections'],
    },
  };
}

/** Check Gemini's answer with the same cross-checks as the rules; only a clean answer is usable. */
export function fromGemini(json: string): ReadResult {
  let o: Record<string, unknown>;
  try { o = JSON.parse(json); } catch { return { ok: false, receipt: null, problems: ['AI answer was not valid JSON'] }; }
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  const sections = Array.isArray(o.sections) ? (o.sections as { code: string; amount: number }[]) : [];
  const fake = [
    'Challan Receipt', `BSR code : ${o.bsr ?? ''}`, `Challan No : ${o.challanNo ?? ''}`, `Tender Date : ${o.tenderDate ?? ''}`,
    `Major Head : x (${o.majorHead ?? ''})`, `Minor Head : x (${o.minorHead ?? '200'})`,
    ...sections.map(s => `${s.code} ₹ ${s.amount} ₹ 0 ₹ 0 ₹ ${s.amount}`),
    `A Tax ₹ ${n('tax')}`, `B Surcharge ₹ ${n('surcharge')}`, `C Education Cess ₹ ${n('cess')}`, `D Interest ₹ ${n('interest')}`,
    `E Penalty ₹ ${n('penalty')}`, `F Fee ₹ ${n('fee')}`, `G Others ₹ ${n('others')}`, `Total (A+B+C+D+E+F+G) ₹ ${n('total')}`,
  ].join('\n');
  const r = parseChallanReceipt(fake);
  if (r.receipt) r.receipt.source = 'gemini';
  return r;
}
```

## src/core/aiExceptions.ts

```ts
/**
 * Phase 4b — AI proposals for the challan exceptions the rules left open.
 *
 * Only what the rules could not decide goes to Gemini, and only MASKED:
 *   challans: number, date, tax, interest, major head, section breakup, balance left
 *   rows:     an id, month of deduction, section code, payee type (company / non-company), tax
 * No PAN, name, TAN, BSR code, challan serial or CIN is ever in the payload.
 *
 * Gemini only PROPOSES links. Every proposal is checked here by rules (row exists and is open,
 * challan exists, enough money left, section share, dates). A proposal that breaks a rule the
 * law or the SOP sets - e.g. a challan dated before the deduction, or using a duplicate challan to
 * fund a later month - is not dropped silently: it is marked as needing the user's approval.
 * Accepted links are applied as typed-in challan numbers and matchChallans() is run again,
 * so the final answer is always the rules' answer.
 *
 * New module — does not change the frozen core.
 */
import { matchChallans, type ChallanIn, type MatchResult, type RowIn } from './challanMatch.ts';

const payeeType = (pan: string) => (/^[A-Z]{3}C/.test(pan) ? 'company' : 'non-company');
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface MaskedPayload {
  challans: { challan: number; date: string; tax: number; interest: number; majorHead: string; breakup: Record<string, number> | null; balance: number }[];
  rows: { id: number; month: string; section: string; payee: 'company' | 'non-company'; tax: number; challan: number | null; status: string }[];
  exceptions: { kind: string; rows: number[]; challans: number[]; message: string }[];
}

/** Masked payload: only exception rows are open; matched rows are shown for context with their challan. */
export function maskedPayload(challans: ChallanIn[], rows: RowIn[], result: MatchResult): MaskedPayload {
  const st = new Map(result.rows.map(r => [r.row, r]));
  const bal = new Map(result.challans.map(c => [c.no, c.balance]));
  const strip = (s: string) => s.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]').replace(/\b[A-Z]{4}\d{5}[A-Z]\b/g, '[TAN]').replace(/\b\d{7}\b/g, '[BSR]');
  return {
    challans: challans.map(c => ({ challan: c.no, date: c.date, tax: c.tax, interest: c.interest, majorHead: c.majorHead, breakup: c.breakup, balance: bal.get(c.no) ?? c.tax })),
    rows: rows.map(r => ({ id: r.row, month: r.dateDeducted.slice(0, 7), section: r.code, payee: payeeType(r.pan), tax: r.tax,
      challan: st.get(r.row)?.status === 'exception' ? null : (st.get(r.row)?.challanNo ?? null), status: st.get(r.row)?.status ?? 'open' })),
    exceptions: result.exceptions.map(e => ({ kind: e.kind, rows: e.rows, challans: e.challans, message: strip(e.message) })),
  };
}

/** Throws if anything that looks like an identifier is in the payload (last line of defence). */
export function assertMasked(payload: unknown): void {
  const s = JSON.stringify(payload);
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(s)) throw new Error('PAN found in the AI payload - not sent');
  if (/\b[A-Z]{4}\d{5}[A-Z]\b/.test(s)) throw new Error('TAN found in the AI payload - not sent');
  if (/"(pan|name|bsr|serial|cin|tan)"/i.test(s)) throw new Error('Identifier field found in the AI payload - not sent');
}

/** Gemini request (responseMimeType 'application/json' + responseSchema). Show `payload` to the user before sending. */
export function geminiExceptionRequest(payload: MaskedPayload) {
  assertMasked(payload);
  return {
    systemInstruction: [
      'You help an Indian chartered accountant link TDS/TCS deduction rows to the challans (bank deposits) that paid them, for a quarterly e-TDS/TCS statement.',
      'Rules: a challan can only pay tax deducted on or before its date. A challan cannot be used beyond its balance; if it has a section breakup, rows of a section use only that section\'s amount.',
      'Company payees are normally paid under major head 0020, others under 0021; report what was actually deposited (note any mismatch).',
      'Only propose links for rows whose challan is null. Never invent challans. If nothing fits, say so instead of forcing a link.',
      'If a proposal needs a rule to be bent (for example using an excess or duplicate challan to cover a later month), set needsApproval true and explain in plain words.',
      'Return ONLY the JSON asked for.',
    ].join(' '),
    prompt: `Propose challans for the open rows. Data (identifiers removed):\n${JSON.stringify(payload)}`,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        proposals: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          rows: { type: 'ARRAY', items: { type: 'INTEGER' } }, challan: { type: 'INTEGER' },
          needsApproval: { type: 'BOOLEAN' }, explanation: { type: 'STRING' } }, required: ['rows', 'challan', 'explanation'] } },
        unresolved: { type: 'ARRAY', items: { type: 'OBJECT', properties: { rows: { type: 'ARRAY', items: { type: 'INTEGER' } }, explanation: { type: 'STRING' } }, required: ['rows', 'explanation'] } },
      },
      required: ['proposals'],
    },
  };
}

export interface CheckedProposal {
  rows: number[]; challan: number; explanation: string;
  verdict: 'accepted' | 'needs-approval' | 'rejected';
  checks: string[];                                    // what the rules found
}

/** Check Gemini's proposals against the rules. Nothing is applied here. */
export function checkProposals(json: string, challans: ChallanIn[], rows: RowIn[], result: MatchResult): { proposals: CheckedProposal[]; unresolved: { rows: number[]; explanation: string }[]; problems: string[] } {
  let o: { proposals?: unknown; unresolved?: unknown };
  try { o = JSON.parse(json); } catch { return { proposals: [], unresolved: [], problems: ['AI answer was not valid JSON'] }; }
  const list = Array.isArray(o.proposals) ? (o.proposals as { rows: number[]; challan: number; explanation?: string; needsApproval?: boolean }[]) : [];
  const byRow = new Map(rows.map(r => [r.row, r]));
  const byCh = new Map(challans.map(c => [c.no, c]));
  const status = new Map(result.rows.map(r => [r.row, r]));
  const dupChallans = new Set(result.exceptions.filter(e => e.kind === 'duplicate').flatMap(e => e.challans));
  // money still free per challan and per challan+section (after rows already matched or given)
  const free = new Map(result.challans.map(c => [c.no, c.balance]));
  const freeSec = new Map<string, number>();
  for (const c of challans) if (c.breakup) for (const [k, v] of Object.entries(c.breakup)) freeSec.set(`${c.no}|${k}`, v);
  for (const r of result.rows) if (r.challanNo && r.status !== 'exception') {
    const k = `${r.challanNo}|${byRow.get(r.row)?.code}`; if (freeSec.has(k)) freeSec.set(k, freeSec.get(k)! - (byRow.get(r.row)?.tax ?? 0));
  }
  const taken = new Set<number>();
  const out: CheckedProposal[] = [];
  for (const p of list) {
    const checks: string[] = []; let reject = false; let approve = !!p.needsApproval;
    const ids = Array.isArray(p.rows) ? p.rows : [];
    const c = byCh.get(p.challan);
    if (!c) { checks.push(`Challan ${p.challan} does not exist`); reject = true; }
    for (const id of ids) {
      if (!byRow.has(id)) { checks.push(`Row ${id} does not exist`); reject = true; continue; }
      if (status.get(id)?.status !== 'exception') { checks.push(`Row ${id} is already settled by the rules - left as it is`); reject = true; }
      if (taken.has(id)) { checks.push(`Row ${id} is in two proposals`); reject = true; }
    }
    if (!ids.length) { checks.push('No rows given'); reject = true; }
    if (!reject && c) {
      const rs = ids.map(id => byRow.get(id)!);
      const total = r2(rs.reduce((a, r) => a + r.tax, 0));
      const late = rs.filter(r => r.dateDeducted > c.date);
      if (late.length) { checks.push(`Challan dated ${c.date} is before the deduction of row(s) ${late.map(r => r.row).join(', ')} - a challan cannot pay tax deducted after it`); approve = true; }
      if (total > (free.get(c.no) ?? 0) + 0.5) { checks.push(`Rows total Rs ${total} but only Rs ${r2(free.get(c.no) ?? 0)} of challan ${c.no} is free`); reject = true; }
      if (c.breakup) for (const code of new Set(rs.map(r => r.code))) {
        const need = r2(rs.filter(r => r.code === code).reduce((a, r) => a + r.tax, 0));
        const have = freeSec.get(`${c.no}|${code}`);
        if (have === undefined) { checks.push(`Challan ${c.no} has no amount for section ${code}`); approve = true; }
        else if (need > have + 0.5) { checks.push(`Section ${code}: rows need Rs ${need}, challan ${c.no} has Rs ${r2(have)} left for it`); approve = true; }
      }
      const wrongHead = c.majorHead ? rs.filter(r => (payeeType(r.pan) === 'company' ? '0020' : '0021') !== c.majorHead) : [];
      if (wrongHead.length) checks.push(`Major head ${c.majorHead} differs from the payee type for row(s) ${wrongHead.map(r => r.row).join(', ')} - report as deposited (SOP rule 11) and note it`);
      if (dupChallans.has(c.no)) { checks.push(`Challan ${c.no} was flagged as a possible duplicate deposit - using it needs your decision`); approve = true; }
      if (!checks.length) checks.push('Fits: dates, balance and section share all check out');
      if (!reject) { free.set(c.no, (free.get(c.no) ?? 0) - total); for (const r of rs) { const k = `${c.no}|${r.code}`; if (freeSec.has(k)) freeSec.set(k, freeSec.get(k)! - r.tax); } ids.forEach(id => taken.add(id)); }
    }
    out.push({ rows: ids, challan: p.challan, explanation: String(p.explanation ?? ''), verdict: reject ? 'rejected' : approve ? 'needs-approval' : 'accepted', checks });
  }
  const unresolved = Array.isArray(o.unresolved) ? (o.unresolved as { rows: number[]; explanation: string }[]) : [];
  return { proposals: out, unresolved, problems: [] };
}

/**
 * Apply the proposals the user accepted (verdict 'accepted', plus any 'needs-approval' they approved)
 * as typed-in challan numbers, then run the rules again. Returns the new result and the links to write
 * with applyChallanMatches().
 */
export function applyProposals(challans: ChallanIn[], rows: RowIn[], result: MatchResult, approved: CheckedProposal[]) {
  const link = new Map<number, number>();
  for (const r of result.rows) if (r.challanNo && r.status !== 'exception') link.set(r.row, r.challanNo);
  for (const p of approved) if (p.verdict !== 'rejected') for (const id of p.rows) link.set(id, p.challan);
  const again = matchChallans(challans, rows.map(r => ({ ...r, challanNo: link.get(r.row) ?? null })));
  return { result: again, links: again.rows.filter(r => r.challanNo).map(r => ({ row: r.row, challanNo: r.challanNo! })) };
}
```
