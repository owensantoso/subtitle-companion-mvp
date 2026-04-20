/* eslint-disable react-hooks/purity */
import { useEffect, useMemo, useRef, useState } from 'react'
import kuromoji from 'kuromoji/build/kuromoji.js'
import type { IpadicFeatures, Tokenizer } from 'kuromoji'
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

type DictionaryBuckets = Record<string, [string, string, string][]>

type Token = {
  id: string
  surface: string
  reading?: string
  hasKanji: boolean
  entry?: DictionaryEntry
}

type Tracker = {
  status: 'idle' | 'running' | 'paused'
  anchorSubtitleMs: number
  anchorClockMs: number
}

type SavedLookup = {
  id: string
  sourceName: string
  surface: string
  reading: string
  meaning: string
  sentence: string
  startMs: number
  endMs: number
  lookedUpAt: string
  selected: boolean
}

const savedLookupsKey = 'subtitle-companion:saved-lookups:v1'

const seedDictionary: DictionaryEntry[] = [
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

function buildSeedBuckets() {
  const buckets: DictionaryBuckets = {}

  for (const entry of seedDictionary) {
    const first = [...entry.surface][0]
    buckets[first] ??= []
    buckets[first].push([entry.surface, entry.reading, entry.meaning])
  }

  for (const entries of Object.values(buckets)) {
    entries.sort((a, b) => b[0].length - a[0].length)
  }

  return buckets
}

const seedBuckets = buildSeedBuckets()

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
  const format = rows.find((row) => row.trim().startsWith('Format:'))
  const fields = format
    ? format.replace('Format:', '').split(',').map((field) => field.trim().toLowerCase())
    : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const startIndex = fields.indexOf('start')
  const endIndex = fields.indexOf('end')
  const textIndex = fields.indexOf('text')
  if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
    throw new Error('ASS file is missing Start, End, or Text fields')
  }

  return rows
    .filter((row) => row.trim().startsWith('Dialogue:'))
    .map((row, index) => {
      const columns = row.trim().replace('Dialogue:', '').trim().split(',')
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

function detectSubtitleFormat(name: string, text: string) {
  const lower = name.toLowerCase().split(/[?#]/)[0]
  if (lower.endsWith('.srt')) return parseSrt(text)
  if (lower.endsWith('.vtt')) return parseVtt(text)
  if (lower.endsWith('.ass')) return parseAss(text)
  if (/^WEBVTT/m.test(text)) return parseVtt(text)
  if (/\[Events\][\s\S]*Dialogue:/m.test(text)) return parseAss(text)
  if (/\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(text)) return parseSrt(text)
  throw new Error('Unsupported subtitle format. Try .srt, .vtt, or .ass.')
}

function parseSubtitle(name: string, text: string) {
  return detectSubtitleFormat(name, text)
}

function lookupSurface(surface: string, buckets: DictionaryBuckets): DictionaryEntry | undefined {
  const first = [...surface][0]
  const entry = buckets[first]?.find((candidate) => candidate[0] === surface)
  return entry ? { surface: entry[0], reading: entry[1], meaning: entry[2] } : undefined
}

function containsKanji(text: string) {
  return /\p{Script=Han}/u.test(text)
}

function katakanaToHiragana(text?: string) {
  if (!text) return undefined
  return text.replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
}

function lookupToken(surface: string, basicForm: string | undefined, buckets: DictionaryBuckets) {
  return lookupSurface(surface, buckets) ?? (basicForm && basicForm !== '*' ? lookupSurface(basicForm, buckets) : undefined)
}

function fallbackTokenize(text: string, buckets: DictionaryBuckets): Token[] {
  const tokens: Token[] = []
  const chars = [...text]

  let index = 0
  while (index < chars.length) {
    const remaining = chars.slice(index).join('')
    const candidates = buckets[chars[index]] ?? []
    const match = candidates.find(([surface]) => remaining.startsWith(surface))
    const surface = match?.[0] ?? chars[index]
    const entry = match ? { surface: match[0], reading: match[1], meaning: match[2] } : lookupSurface(surface, buckets)
    tokens.push({ id: `${index}-${surface}`, surface, reading: entry?.reading, hasKanji: containsKanji(surface), entry })
    index += [...surface].length
  }

  return tokens
}

function tokenize(text: string, buckets: DictionaryBuckets, tokenizer: Tokenizer<IpadicFeatures> | null): Token[] {
  if (!tokenizer) return fallbackTokenize(text, buckets)

  return tokenizer.tokenize(text).map((part, index) => {
    const surface = part.surface_form
    const entry = lookupToken(surface, part.basic_form, buckets)
    const reading = entry?.reading ?? katakanaToHiragana(part.reading)
    return {
      id: `${index}-${surface}-${part.word_position}`,
      surface,
      reading,
      hasKanji: containsKanji(surface),
      entry,
    }
  })
}

function virtualTime(tracker: Tracker, now = performance.now()) {
  if (tracker.status !== 'running') return tracker.anchorSubtitleMs
  return tracker.anchorSubtitleMs + now - tracker.anchorClockMs
}

function currentSubtitle(lines: SubtitleLine[], tracker: Tracker, now = performance.now()) {
  const ms = virtualTime(tracker, now)
  return lines.find((line) => ms >= line.startMs && ms <= line.endMs)
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function makeLookupId(source: string, line: SubtitleLine, token: Token) {
  return [source, line.startMs, line.endMs, token.surface, line.plainText].join('|')
}

function loadSavedLookups(): SavedLookup[] {
  try {
    const raw = localStorage.getItem(savedLookupsKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function escapeTsv(value: string | number) {
  return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, '<br>')
}

function buildAnkiTsv(lookups: SavedLookup[]) {
  const rows = [
    ['Word', 'Reading', 'Meaning', 'Sentence', 'Timing', 'Source'],
    ...lookups.map((lookup) => [
      lookup.surface,
      lookup.reading,
      lookup.meaning,
      lookup.sentence,
      `${formatTime(lookup.startMs)}-${formatTime(lookup.endMs)}`,
      lookup.sourceName,
    ]),
  ]

  return rows.map((row) => row.map(escapeTsv).join('\t')).join('\n')
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
  const [dictionaryBuckets, setDictionaryBuckets] = useState<DictionaryBuckets>(seedBuckets)
  const [dictionaryStatus, setDictionaryStatus] = useState('Loading full JMdict...')
  const [tokenizer, setTokenizer] = useState<Tokenizer<IpadicFeatures> | null>(null)
  const [tokenizerStatus, setTokenizerStatus] = useState('Loading Kuromoji tokenizer...')
  const [savedLookups, setSavedLookups] = useState<SavedLookup[]>(() => loadSavedLookups())
  const liveRef = useRef<HTMLLIElement | null>(null)

  const current = currentSubtitle(lines, tracker, tick)
  const tokenizedLines = useMemo(() => lines.map((line) => ({ line, tokens: tokenize(line.plainText, dictionaryBuckets, tokenizer) })), [dictionaryBuckets, lines, tokenizer])

  useEffect(() => {
    const id = window.setInterval(() => setTick(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (tracker.status === 'running' && current) {
      liveRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [current, tracker.status])

  useEffect(() => {
    let cancelled = false

    async function loadDictionary() {
      try {
        const response = await fetch('./dictionaries/jmdict-eng-lookup.json')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as { entryCount: number; buckets: DictionaryBuckets }
        if (!cancelled) {
          setDictionaryBuckets(data.buckets)
          setDictionaryStatus(`JMdict loaded: ${data.entryCount.toLocaleString()} entries`)
        }
      } catch {
        if (!cancelled) {
          setDictionaryStatus('Using tiny fallback dictionary; full JMdict could not load')
        }
      }
    }

    void loadDictionary()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(savedLookupsKey, JSON.stringify(savedLookups))
  }, [savedLookups])

  useEffect(() => {
    let cancelled = false

    kuromoji.builder({ dicPath: './kuromoji/' }).build((err, builtTokenizer) => {
      if (cancelled) return
      if (err) {
        setTokenizerStatus('Using fallback tokenizer; Kuromoji could not load')
        return
      }
      setTokenizer(builtTokenizer)
      setTokenizerStatus('Kuromoji tokenizer loaded')
    })

    return () => {
      cancelled = true
    }
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
    let text = ''
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      text = await response.text()
    } catch {
      setError('This URL could not be loaded from the browser. The site may block cross-origin requests. Download the subtitle file and upload it here instead.')
      return
    }

    try {
      const parsed = parseSubtitle(url, text)
      setLines(parsed)
      setSourceName(url)
      setError('')
      setTracker({ status: 'idle', anchorSubtitleMs: parsed[0]?.startMs ?? 0, anchorClockMs: performance.now() })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unsupported subtitle format. Try .srt, .vtt, or .ass.')
    }
  }

  function start() {
    setTracker((state) => ({ ...state, status: 'running', anchorClockMs: performance.now() }))
  }

  function pause() {
    setTracker((state) => ({ status: 'paused', anchorSubtitleMs: virtualTime(state), anchorClockMs: performance.now() }))
  }

  function togglePlayback() {
    if (tracker.status === 'running') {
      pause()
    } else {
      start()
    }
  }

  function reanchor(line: SubtitleLine) {
    setTracker({ status: 'running', anchorSubtitleMs: line.startMs, anchorClockMs: performance.now() })
    window.requestAnimationFrame(() => liveRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }

  function saveLookup(token: Token, line: SubtitleLine) {
    const meaning = token.entry?.meaning ?? 'No dictionary match found.'
    const reading = token.reading ?? token.entry?.reading ?? ''
    const id = makeLookupId(sourceName, line, token)
    const nextLookup: SavedLookup = {
      id,
      sourceName,
      surface: token.surface,
      reading,
      meaning,
      sentence: line.plainText,
      startMs: line.startMs,
      endMs: line.endMs,
      lookedUpAt: new Date().toISOString(),
      selected: true,
    }

    setSavedLookups((currentLookups) => {
      const existing = currentLookups.find((lookup) => lookup.id === id)
      if (!existing) return [nextLookup, ...currentLookups]
      return currentLookups.map((lookup) => lookup.id === id ? { ...lookup, lookedUpAt: nextLookup.lookedUpAt, selected: true } : lookup)
    })
  }

  function handleTokenSelect(token: Token, line: SubtitleLine) {
    setSelectedToken(token)
    saveLookup(token, line)
  }

  function toggleSavedLookup(id: string) {
    setSavedLookups((currentLookups) => currentLookups.map((lookup) => lookup.id === id ? { ...lookup, selected: !lookup.selected } : lookup))
  }

  function clearSavedLookups() {
    setSavedLookups([])
  }

  function exportSelectedLookups() {
    const selected = savedLookups.filter((lookup) => lookup.selected)
    if (selected.length === 0) return

    const blob = new Blob([buildAnkiTsv(selected)], { type: 'text/tab-separated-values;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = 'subtitle-lookups-anki.tsv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
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
          <input type="file" onChange={(event) => void handleFile(event.target.files?.[0])} />
          <span className="hint">iOS Safari can hide unknown extensions, so this picker allows any file and validates after selection.</span>
        </label>

        <label>
          Subtitle URL
          <span className="url-row">
            <input placeholder="https://example.com/episode.srt" value={url} onChange={(event) => setUrl(event.target.value)} />
            <button type="button" onClick={() => void handleUrlLoad()}>Load URL</button>
          </span>
        </label>

        {error ? <p className="error">{error}</p> : null}
        <p className="dictionary-status">{dictionaryStatus}</p>
        <p className="dictionary-status">{tokenizerStatus}</p>
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
            <button type="button" onClick={togglePlayback}>{tracker.status === 'running' ? 'Pause' : tracker.status === 'paused' ? 'Resume' : 'Start'}</button>
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
                      <button className="token" key={token.id} type="button" onClick={() => handleTokenSelect(token, line)}>
                        {furigana && token.hasKanji && token.reading ? (
                          <ruby>{token.surface}<rt>{token.reading}</rt></ruby>
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

      <section className="saved-lookups">
        <header className="saved-lookups-header">
          <div>
            <p className="eyebrow">Saved lookups</p>
            <h2>{savedLookups.length} saved · {savedLookups.filter((lookup) => lookup.selected).length} selected</h2>
          </div>
          <div className="saved-actions">
            <button type="button" onClick={exportSelectedLookups} disabled={savedLookups.every((lookup) => !lookup.selected)}>Export selected TSV</button>
            <button className="secondary" type="button" onClick={clearSavedLookups} disabled={savedLookups.length === 0}>Clear</button>
          </div>
        </header>

        {savedLookups.length === 0 ? (
          <p className="empty-lookups">Tap words in subtitles and they will appear here for Anki export.</p>
        ) : (
          <ol className="saved-list">
            {savedLookups.map((lookup) => (
              <li className="saved-item" key={lookup.id}>
                <label className="saved-check">
                  <input checked={lookup.selected} type="checkbox" onChange={() => toggleSavedLookup(lookup.id)} />
                  <span>
                    <strong>{lookup.surface}</strong>
                    {lookup.reading ? <span className="saved-reading"> {lookup.reading}</span> : null}
                  </span>
                </label>
                <p>{lookup.meaning}</p>
                <blockquote>{lookup.sentence}</blockquote>
                <small>{formatTime(lookup.startMs)}-{formatTime(lookup.endMs)} · {lookup.sourceName}</small>
              </li>
            ))}
          </ol>
        )}
      </section>

      {selectedToken ? (
        <aside className="lookup" role="dialog" aria-label="Dictionary lookup">
          <button className="close" type="button" onClick={() => setSelectedToken(null)}>Close</button>
          <p className="eyebrow">Lookup</p>
          <h2>{selectedToken.surface}</h2>
          {selectedToken.entry ? (
            <>
              <p className="reading">{selectedToken.reading ?? selectedToken.entry.reading}</p>
              <p>{selectedToken.entry.meaning}</p>
            </>
          ) : selectedToken.reading ? (
            <>
              <p className="reading">{selectedToken.reading}</p>
              <p>No dictionary match found.</p>
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
