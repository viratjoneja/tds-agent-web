# Instructions for AI coding agents (Google AI Studio Build, Codex, Claude, etc.)

This app prepares statutory tax return files. The engine is tested byte-for-byte against output that Protean's FVU accepted on live returns.

## Never change the engine
Do not edit, reformat, rename, move or "improve" these files - not even whitespace or imports:
`src/protean.ts`, `src/inputWorkbook.ts`, `src/review.ts`, `src/template_columns.json`, `src/csi.ts`, `src/fvuResult.ts`,
`src/sectionCodes.ts`, `src/sectionMap.json`, `src/challanMatch.ts`, `src/challanPdf.ts`, `src/aiExceptions.ts`,
`engine-files.mjs`, `test/**`.
The footer shows a fingerprint of them (expected `ecea70457ab6` for this release) and a self-test; if either changes, the app blocks downloads.
Do not re-implement any engine logic in the UI (section codes, challan matching, return building, checks). Call the engine.

## You may change
`src/app/*` (layout, styling, wording, components) and `index.html`, as long as every step still calls the same engine functions.

## Privacy (must stay)
- Client files are read in the browser only; never upload them, never store them (no localStorage/database), no analytics on file contents.
- Gemini is called only through `/api/gemini` in `server.mjs` (key in the `GEMINI_API_KEY` secret, never in the browser), only with the masked payloads the engine builds, and only after the user sees the payload and clicks "Send to Gemini".
