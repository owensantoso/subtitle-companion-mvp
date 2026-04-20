/* eslint-disable react-hooks/purity */
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type SubtitleLine = {
  id: string
  index: number
  startMs: number
  endMs: number
  text: string
  plainText: string
}

type DictionaryEntry = {
  surface: string
  reading: string
  meaning: string
}

type Token = {
  id: string
  surface: string
  entry?: DictionaryEntry
}

type Tracker = {
  status: 'idle' | 'running' | 'paused'
  anchorSubtitleMs: number
  anchorClockMs: number
}

const dictionary: DictionaryEntry[] = [
  { surface: '私', reading: 'わたし', meaning: 'I; me' },
  { surface: '僕', reading: 'ぼく', meaning: 'I; me' },
  { surface: '猫', reading: 'ねこ', meaning: 'cat' },
  { surface: '水', reading: 'みず', meaning: 'water' },
  { surface: '飲む', reading: 'のむ', meaning: 'to drink' },
  { surface: '見る', reading: 'みる', meaning: 'to see; to watch' },
  { surface: '行く', reading: 'いく', meaning: 'to go' },
  { surface: '今日', reading: 'きょう', meaning: 'today' },
  { surface: '明日', reading: 'あした', meaning: 'tomorrow' },
  { surface: '大丈夫', reading: 'だいじょうぶ', meaning: 'okay; safe' },
  { surface: '何', reading: 'なに', meaning: 'what' },
  { surface: '人', reading: 'ひと', meaning: 'person' },
  { surface: '君', reading: 'きみ', meaning: 'you' },
  { surface: '好き', reading: 'すき', meaning: 'liked; fond of' },
]

const dictionaryBySurface = new Map(dictionary.map((entry) => [entry.surface, entry]))
const dictionarySurfaces = [...dictionaryBySurface.keys()].sort((a, b) => b.length - a.length)

function parseSrtTime(value: string) {
  const match = value.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
  if (!match) throw new Error(`Bad SRT timestamp: ${value}`)
  const [, hours, minutes, seconds, ms] = match.map(Number)
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms
}

function parseVttTime(value: string) {
  const match = value.match(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/)
  if (!match) throw new Error(`Bad VTT timestamp: ${value}`)
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const ms = Number(match[4])
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms
}

function parseAssTime(value: string) {
  const match = value.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/)
  if (!match) throw new Error(`Bad ASS timestamp: ${value}`)
  const [, hours, minutes, seconds, cs] = match.map(Number)
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + cs * 10
}

function parseSrt(input: string): SubtitleLine[] {
  return input
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block, index) => {
      const rows = block.split(/\r?\n/).filter(Boolean)
      const timing = rows.find((row) => row.includes('-->'))
      if (!timing) throw new Error('SRT cue is missing timing')
      const [start, end] = timing.split('-->').map((part) => part.trim())
      const text = rows.slice(rows.indexOf(timing) + 1).join('\n').trim()
      return { id: `srt-${index}`, index, startMs: parseSrtTime(start), endMs: parseSrtTime(end), text, plainText: text }
    })
}

function parseVtt(input: string): SubtitleLine[] {
  return input
    .replace(/^WEBVTT.*?(\r?\n){2}/s, '')
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block, index) => {
      const rows = block.split(/\r?\n/).filter(Boolean)
      const timing = rows.find((row) => row.includes('-->'))
      if (!timing) throw new Error('VTT cue is missing timing')
      const [start, end] = timing.split('-->').map((part) => part.trim())
      const text = rows.slice(rows.indexOf(timing) + 1).join('\n').trim()
      return { id: `vtt-${index}`, index, startMs: parseVttTime(start), endMs: parseVttTime(end), text, plainText: text }
    })
}

function stripAssTags(text: string) {
  return text.replace(/\{[^}]*}/g, '').replace(/\\N/g, '\n').trim()
}

function parseAss(input: string): SubtitleLine[] {
  const rows = input.split(/\r?\n/)
  const format = rows.find((row) => row.startsWith('Format:'))
  const fields = format
    ? format.replace('Format:', '').split(',').map((field) => field.trim().toLowerCase())
    : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const startIndex = fields.indexOf('start')
  const endIndex = fields.indexOf('end')
  const textIndex = fields.indexOf('text')

  return rows
    .filter((row) => row.startsWith('Dialogue:'))
    .map((row, index) => {
      const columns = row.replace('Dialogue:', '').trim().split(',')
      const text = stripAssTags(columns.slice(textIndex).join(','))
      return {
        id: `ass-${index}`,
        index,
        startMs: parseAssTime(columns[startIndex].trim()),
        endMs: parseAssTime(columns[endIndex].trim()),
        text,
        plainText: text,
      }
    })
}

function parseSubtitle(name: string, text: string) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.srt')) return parseSrt(text)
  if (lower.endsWith('.vtt')) return parseVtt(text)
  if (lower.endsWith('.ass')) return parseAss(text)
  throw new Error('Unsupported subtitle format. Try .srt, .vtt, or .ass.')
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < text.length) {
    const surface = dictionarySurfaces.find((candidate) => text.startsWith(candidate, index)) ?? text[index]
    tokens.push({ id: `${index}-${surface}`, surface, entry: dictionaryBySurface.get(surface) })
    index += surface.length
  }

  return tokens
}

function virtualTime(tracker: Tracker, now = performance.now()) {
  if (tracker.status !== 'running') return tracker.anchorSubtitleMs
  return tracker.anchorSubtitleMs + now - tracker.anchorClockMs
}

function currentSubtitle(lines: SubtitleLine[], tracker: Tracker, now = performance.now()) {
  const ms = virtualTime(tracker, now)
  return lines.find((line) => ms >= line.startMs && ms <= line.endMs) ?? lines.find((line) => line.startMs > ms) ?? lines.at(-1)
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function App() {
  const [sourceName, setSourceName] = useState('')
  const [url, setUrl] = useState('')
  const [lines, setLines] = useState<SubtitleLine[]>([])
  const [error, setError] = useState('')
  const [tracker, setTracker] = useState<Tracker>({ status: 'idle', anchorSubtitleMs: 0, anchorClockMs: performance.now() })
  const [tick, setTick] = useState(performance.now())
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [furigana, setFurigana] = useState(true)
  const liveRef = useRef<HTMLLIElement | null>(null)

  const current = currentSubtitle(lines, tracker, tick)
  const tokenizedLines = useMemo(() => lines.map((line) => ({ line, tokens: tokenize(line.plainText) })), [lines])

  useEffect(() => {
    const id = window.setInterval(() => setTick(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [])

  async function handleFile(file?: File) {
    if (!file) return
    try {
      const text = await file.text()
      const parsed = parseSubtitle(file.name, text)
      setLines(parsed)
      setSourceName(file.name)
      setError('')
      setTracker({ status: 'idle', anchorSubtitleMs: parsed[0]?.startMs ?? 0, anchorClockMs: performance.now() })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read this subtitle file.')
    }
  }

  async function handleUrlLoad() {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const parsed = parseSubtitle(url, text)
      setLines(parsed)
      setSourceName(url)
      setError('')
      setTracker({ status: 'idle', anchorSubtitleMs: parsed[0]?.startMs ?? 0, anchorClockMs: performance.now() })
    } catch {
      setError('This URL could not be loaded from the browser. The site may block cross-origin requests. Download the subtitle file and upload it here instead.')
    }
  }

  function start() {
    setTracker((state) => ({ ...state, status: 'running', anchorClockMs: performance.now() }))
  }

  function pause() {
    setTracker((state) => ({ status: 'paused', anchorSubtitleMs: virtualTime(state), anchorClockMs: performance.now() }))
  }

  function reanchor(line: SubtitleLine) {
    setTracker({ status: 'running', anchorSubtitleMs: line.startMs, anchorClockMs: performance.now() })
    window.requestAnimationFrame(() => liveRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }

  return (
    <main className="app-shell">
      <section className="intro">
        <p className="eyebrow">Static subtitle companion POC</p>
        <h1>Watch in Japanese. Tap when a word gets interesting.</h1>
        <p>Load local subtitles or a direct URL, run a local subtitle clock, and tap known words for readings and meanings. No backend required.</p>
      </section>

      <section className="import-card">
        <label>
          Subtitle file
          <input accept=".srt,.vtt,.ass" type="file" onChange={(event) => void handleFile(event.target.files?.[0])} />
        </label>

        <label>
          Subtitle URL
          <span className="url-row">
            <input placeholder="https://example.com/episode.srt" value={url} onChange={(event) => setUrl(event.target.value)} />
            <button type="button" onClick={() => void handleUrlLoad()}>Load URL</button>
          </span>
        </label>

        {error ? <p className="error">{error}</p> : null}
      </section>

      {lines.length > 0 ? (
        <section className="reader">
          <header className="reader-bar">
            <div>
              <p className="eyebrow">Loaded</p>
              <h2>{sourceName}</h2>
              <p>{lines.length} subtitle lines</p>
            </div>
            <button type="button" onClick={() => setFurigana((value) => !value)}>
              {furigana ? 'Hide furigana' : 'Show furigana'}
            </button>
          </header>

          <div className="controls">
            <button type="button" onClick={start}>{tracker.status === 'running' ? 'Resume' : 'Start'}</button>
            <button type="button" onClick={pause}>Pause</button>
            <button type="button" onClick={() => liveRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>Jump to live</button>
            <span>{tracker.status} · {formatTime(virtualTime(tracker, tick))}</span>
          </div>

          <ol className="subtitle-list">
            {tokenizedLines.map(({ line, tokens }) => {
              const isCurrent = line.id === current?.id
              return (
                <li className={isCurrent ? 'subtitle-line current' : 'subtitle-line'} key={line.id} ref={isCurrent ? liveRef : undefined}>
                  <button className="time" type="button" onClick={() => reanchor(line)}>
                    {formatTime(line.startMs)}
                    <span>Re-anchor</span>
                  </button>
                  <p className="line-text">
                    {tokens.map((token) => (
                      <button className="token" key={token.id} type="button" onClick={() => setSelectedToken(token)}>
                        {furigana && token.entry ? (
                          <ruby>{token.surface}<rt>{token.entry.reading}</rt></ruby>
                        ) : token.surface}
                      </button>
                    ))}
                  </p>
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      {selectedToken ? (
        <aside className="lookup" role="dialog" aria-label="Dictionary lookup">
          <button className="close" type="button" onClick={() => setSelectedToken(null)}>Close</button>
          <p className="eyebrow">Lookup</p>
          <h2>{selectedToken.surface}</h2>
          {selectedToken.entry ? (
            <>
              <p className="reading">{selectedToken.entry.reading}</p>
              <p>{selectedToken.entry.meaning}</p>
            </>
          ) : (
            <p>No dictionary match found.</p>
          )}
        </aside>
      ) : null}
    </main>
  )
}

export default App
