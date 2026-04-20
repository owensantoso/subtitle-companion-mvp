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

## Static Build

```bash
npm run build
```

## GitHub Pages

This repo includes `.github/workflows/pages.yml`. Push `main` to GitHub and enable Pages with GitHub Actions as the source if needed.
