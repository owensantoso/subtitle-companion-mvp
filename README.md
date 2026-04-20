# Static Subtitle Companion MVP

A proof-of-concept static web app for following Japanese subtitles on a phone while watching a show elsewhere.

## What Works

- Load local `.srt`, `.vtt`, and basic `.ass` subtitle files.
- Try loading a direct subtitle URL when the host allows browser fetches.
- Start, pause, and re-anchor a local virtual subtitle clock.
- Highlight the current subtitle line.
- Tap known Japanese words for reading and English meaning.
- Toggle furigana for known words.
- Deploy as static assets to GitHub Pages or Vercel.

## POC Limits

- Dictionary coverage is intentionally tiny.
- URL import is best effort and blocked by many subtitle hosts because of CORS.
- ASS parsing extracts basic dialogue text and ignores styling/karaoke effects.
- There is no automatic audio/STT sync, backend, account system, or LLM explanation flow.

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
