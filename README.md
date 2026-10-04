# Static Subtitle Companion MVP

A proof-of-concept static web app for following Japanese subtitles on a phone while watching a show elsewhere.

## What Works

- Load local `.srt`, `.vtt`, and basic `.ass` subtitle files.
- Try loading a direct subtitle URL when the host allows browser fetches.
- Start, pause, and re-anchor a local virtual subtitle clock.
- Highlight the current subtitle line.
- Tap Japanese words for reading and English meaning from a static JMdict-derived English lookup.
- Segment Japanese subtitle lines with Kuromoji and fall back to longest-match lookup if Kuromoji fails.
- Toggle furigana for kanji-containing tokens found in the dictionary.
- Auto-scroll the highlighted current subtitle line while playback is running.
- Automatically save tapped word lookups with sentence, source, and subtitle timing.
- Select saved lookup rows and export them as an Anki-importable TSV file.
- Deploy as static assets to GitHub Pages or Vercel.

## POC Limits

- The JMdict lookup is large: about 35 MB raw, about 10.6 MB gzip.
- Kuromoji dictionary assets add several more static files and must be deployed with the app.
- Saved lookups live in browser `localStorage`, so they are device/browser-specific.
- TSV export is supported, but native `.apkg` generation is not implemented yet.
- URL import is best effort and blocked by many subtitle hosts because of CORS.
- ASS parsing extracts basic dialogue text and ignores styling/karaoke effects.
- There is no automatic audio/STT sync, backend, account system, or LLM explanation flow.

## Rebuilding The Dictionary

The committed lookup file was generated from JMdict Simplified English `3.6.2+20260413165336`.

```bash
mkdir -p tmp/jmdict public/dictionaries
curl -L -o tmp/jmdict/jmdict-eng.json.tgz 'https://github.com/scriptin/jmdict-simplified/releases/download/3.6.2%2B20260413165336/jmdict-eng-3.6.2%2B20260413165336.json.tgz'
tar -xzf tmp/jmdict/jmdict-eng.json.tgz -C tmp/jmdict
node scripts/build-jmdict-lookup.mjs
```

## Local Development

```bash
npm install
npm run dev
```

## Import regression checks

Run `npm ci` and `npm test` with Node 20.19+ or 22.12+. The tests mount the app in
headless Chromium through Playwright and start an owned local Vite server. Windows
uses Chrome at its standard installation path when available. On other hosts,
install the test browser with `npx playwright install chromium`, or set
`CHROMIUM_PATH` to an existing compatible browser executable.

All subtitle, catalog and dictionary requests use synthetic fixtures; other remote
requests are blocked. Tests cover overlapping imports, stale errors/loading state,
catalog selection, queued deep links and attempt-specific resume positions. The
video fixture only checks attachment retention; real decoding, playback and native
picture in picture still need separate browser checks. Chooser cancellation uses
the native DOM event boundary, rather than accepting a particular OS dialog flow.

For a baseline comparison, `SUBTITLE_TEST_ROOT` can point at a separate checkout
with its own installed dependencies. The test module and browser remain those of
the current checkout; the app served by Vite comes from the specified root.

## Browser saving

History, saved words, reader settings and recent activity are stored separately in
this browser. Missing or valid data saves normally. If a saved collection cannot
be read or contains invalid entries, usable entries remain available for this
session, a notice explains that changes cannot be saved, and its original stored
data is left untouched. Other healthy collections can still save. This release
provides no automatic reset, cleanup or merge of damaged data.

If saving fails (for example, browser storage is full or unavailable), the reader
stays usable and shows a saving notice. A later change to that healthy collection
tries saving again. Unsaved changes may be lost when the page closes. Legacy
lookup history and font preferences remain supported; malformed legacy history
does not create an empty replacement history key.

`npm test` includes mounted browser persistence checks alongside the import
regressions, using synthetic records and storage faults in fresh contexts. These
checks do not use private browser data or certify native media/PiP behavior.

## Static Build

```bash
npm run build
```

## GitHub Pages

This repo includes `.github/workflows/pages.yml`. Push `main` to GitHub and enable Pages with GitHub Actions as the source if needed.
