import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import kuromoji from 'kuromoji/build/kuromoji.js'
import type { IpadicFeatures, Tokenizer } from 'kuromoji'
import {
  listAjattSubtitleFiles,
  loadAjattSubtitleFile,
  loadAnimeCatalog,
  searchAnimeCatalog,
} from './subtitleSources'
import type { AnimeCatalogEntry, SubtitleFile } from './subtitleSources'
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

type SelectedLookup = {
  token: Token
  lookup: SavedLookup
}

type RecentSubtitle = {
  id: string
  name: string
  kind: 'catalog' | 'url' | 'local'
  viewedAt: string
  animeId?: string
  animeTitle?: string
  file?: SubtitleFile
  url?: string
}

type RecentSearch = {
  id: string
  title: string
  japaneseName?: string
  viewedAt: string
}

type RecentActivity = {
  subtitles: RecentSubtitle[]
  searches: RecentSearch[]
}

const legacySavedLookupsKey = 'subtitle-companion:saved-lookups:v1'
const lookupHistoryKey = 'subtitle-companion:lookup-history:v1'
const favoriteWordsKey = 'subtitle-companion:favorite-words:v1'
const subtitleFontSizeKey = 'subtitle-companion:subtitle-font-size:v1'
const readerSettingsKey = 'subtitle-companion:reader-settings:v1'
const recentActivityKey = 'subtitle-companion:recent-activity:v1'
const recentActivityLimit = 6

type ExportFormat = 'tsv' | 'csv' | 'txt'
type ReaderSettings = {
  furigana: boolean
  furiganaOpacity: number
  subtitleFontSize: number
}

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

function cleanSubtitleText(text: string) {
  return text.replace(/\{[^}]*}/g, '').replace(/\\N/g, '\n').trim()
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
      const text = cleanSubtitleText(rows.slice(rows.indexOf(timing) + 1).join('\n'))
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
      const text = cleanSubtitleText(rows.slice(rows.indexOf(timing) + 1).join('\n'))
      return { id: `vtt-${index}`, index, startMs: parseVttTime(start), endMs: parseVttTime(end), text, plainText: text }
    })
}

function parseAss(input: string): SubtitleLine[] {
  const rows = input.split(/\r?\n/)
  const eventsIndex = rows.findIndex((row) => row.trim().toLowerCase() === '[events]')
  const eventRows = (eventsIndex >= 0 ? rows.slice(eventsIndex + 1) : rows)
    .filter((row) => !row.trim().startsWith(';'))
  const nextSectionIndex = eventRows.findIndex((row) => /^\s*\[[^\]]+]\s*$/.test(row))
  const scopedEventRows = nextSectionIndex >= 0 ? eventRows.slice(0, nextSectionIndex) : eventRows
  const fallbackFields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const formatCandidates = scopedEventRows
    .filter((row) => row.trim().toLowerCase().startsWith('format:'))
    .map((row) => row.trim().replace(/^Format:/i, '').split(',').map((field) => field.trim().toLowerCase()))
  const fields = formatCandidates.find((candidate) => (
    candidate.includes('start') && candidate.includes('end') && candidate.includes('text')
  )) ?? fallbackFields
  const startIndex = fields.indexOf('start')
  const endIndex = fields.indexOf('end')
  const textIndex = fields.indexOf('text')
  if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
    throw new Error('ASS file is missing Start, End, or Text fields')
  }

  return scopedEventRows
    .filter((row) => row.trim().startsWith('Dialogue:'))
    .map((row, index) => {
      const columns = row.trim().replace('Dialogue:', '').trim().split(',')
      const text = cleanSubtitleText(columns.slice(textIndex).join(','))
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
  let latest: SubtitleLine | undefined

  for (const line of lines) {
    if (line.startMs > ms) break
    latest = line
  }

  return latest
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

function loadLookups(key: string, fallbackKey?: string): SavedLookup[] {
  try {
    const raw = localStorage.getItem(key) ?? (fallbackKey ? localStorage.getItem(fallbackKey) : null)
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

function escapeCsv(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function buildCsv(lookups: SavedLookup[]) {
  const rows = [
    ['Word', 'Reading', 'Meaning', 'Sentence', 'Start', 'End', 'Source'],
    ...lookups.map((lookup) => [
      lookup.surface,
      lookup.reading,
      lookup.meaning,
      lookup.sentence,
      formatTime(lookup.startMs),
      formatTime(lookup.endMs),
      lookup.sourceName,
    ]),
  ]

  return rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')
}

function buildPlainText(lookups: SavedLookup[]) {
  return lookups.map((lookup) => [
    `${lookup.surface}${lookup.reading ? ` 【${lookup.reading}】` : ''}`,
    lookup.meaning,
    lookup.sentence,
    `${formatTime(lookup.startMs)}–${formatTime(lookup.endMs)} · ${lookup.sourceName}`,
  ].join('\n')).join('\n\n')
}

function loadReaderSettings(): ReaderSettings {
  const defaults: ReaderSettings = {
    furigana: true,
    furiganaOpacity: 100,
    subtitleFontSize: 22,
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(readerSettingsKey) ?? '{}') as Partial<ReaderSettings>
    const legacyFontSize = Number(localStorage.getItem(subtitleFontSizeKey))
    const params = new URLSearchParams(window.location.search)
    const linkedFontSize = Number(params.get('font'))
    const linkedOpacity = Number(params.get('furigana'))
    const storedOpacity = Number(parsed.furiganaOpacity)
    return {
      furigana: typeof parsed.furigana === 'boolean' ? parsed.furigana : defaults.furigana,
      furiganaOpacity: Number.isFinite(linkedOpacity) && params.has('furigana')
        ? Math.min(100, Math.max(0, linkedOpacity))
        : Number.isFinite(storedOpacity) ? Math.min(100, Math.max(0, storedOpacity)) : defaults.furiganaOpacity,
      subtitleFontSize: [18, 22, 26, 30].includes(linkedFontSize)
        ? linkedFontSize
        : [18, 22, 26, 30].includes(Number(parsed.subtitleFontSize))
        ? Number(parsed.subtitleFontSize)
        : [18, 22, 26, 30].includes(legacyFontSize) ? legacyFontSize : defaults.subtitleFontSize,
    }
  } catch {
    return defaults
  }
}

function loadRecentActivity(): RecentActivity {
  try {
    const parsed = JSON.parse(localStorage.getItem(recentActivityKey) ?? '{}') as Partial<RecentActivity>
    return {
      subtitles: Array.isArray(parsed.subtitles) ? parsed.subtitles.slice(0, recentActivityLimit) : [],
      searches: Array.isArray(parsed.searches) ? parsed.searches.slice(0, recentActivityLimit) : [],
    }
  } catch {
    return { subtitles: [], searches: [] }
  }
}

function animeStateId(entry: AnimeCatalogEntry) {
  return new URL(entry.url).pathname.replace(/^\/+/, '')
}

function updateAnimeUrl(entry: AnimeCatalogEntry | null) {
  const nextUrl = new URL(window.location.href)
  if (entry) {
    nextUrl.searchParams.set('anime', animeStateId(entry))
    nextUrl.searchParams.delete('subtitle')
    nextUrl.searchParams.delete('line')
  } else {
    nextUrl.searchParams.delete('anime')
    nextUrl.searchParams.delete('subtitle')
    nextUrl.searchParams.delete('line')
  }
  window.history.replaceState({}, '', nextUrl)
}

function favoriteWordId(lookup: SavedLookup) {
  return `${lookup.surface}|${lookup.reading}`
}

function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
      <path
        d="m12 3.4 2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 16.92l-5.3 2.79 1.01-5.9-4.29-4.18 5.93-.86L12 3.4Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17">
      <path d="M8 12h9m-4-4 4 4-4 4M5 5v14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  )
}

function App() {
  const [sourceName, setSourceName] = useState('')
  const [url, setUrl] = useState('')
  const [lines, setLines] = useState<SubtitleLine[]>([])
  const [error, setError] = useState('')
  const [tracker, setTracker] = useState<Tracker>({ status: 'idle', anchorSubtitleMs: 0, anchorClockMs: performance.now() })
  const [tick, setTick] = useState(performance.now())
  const [selectedLookup, setSelectedLookup] = useState<SelectedLookup | null>(null)
  const [readerSettings, setReaderSettings] = useState(loadReaderSettings)
  const [dictionaryBuckets, setDictionaryBuckets] = useState<DictionaryBuckets>(seedBuckets)
  const [dictionaryStatus, setDictionaryStatus] = useState('Loading full JMdict...')
  const [tokenizer, setTokenizer] = useState<Tokenizer<IpadicFeatures> | null>(null)
  const [tokenizerStatus, setTokenizerStatus] = useState('Loading Kuromoji tokenizer...')
  const [lookupHistory, setLookupHistory] = useState<SavedLookup[]>(() => loadLookups(lookupHistoryKey, legacySavedLookupsKey))
  const [favoriteWords, setFavoriteWords] = useState<SavedLookup[]>(() => loadLookups(favoriteWordsKey))
  const [animeCatalog, setAnimeCatalog] = useState<AnimeCatalogEntry[]>([])
  const [catalogStatus, setCatalogStatus] = useState('Loading anime catalog…')
  const [animeQuery, setAnimeQuery] = useState('')
  const [selectedAnime, setSelectedAnime] = useState<AnimeCatalogEntry | null>(null)
  const [subtitleFiles, setSubtitleFiles] = useState<SubtitleFile[]>([])
  const [filesStatus, setFilesStatus] = useState('')
  const [loadingFileUrl, setLoadingFileUrl] = useState('')
  const [shareStatus, setShareStatus] = useState('')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('tsv')
  const [favoriteExportFormat, setFavoriteExportFormat] = useState<ExportFormat>('tsv')
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [activeSubtitleFile, setActiveSubtitleFile] = useState<SubtitleFile | null>(null)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [recentActivity, setRecentActivity] = useState(loadRecentActivity)
  const [loadingRecentId, setLoadingRecentId] = useState('')
  const [focusMode, setFocusMode] = useState(false)
  const [followCurrent, setFollowCurrent] = useState(true)
  const [importOpen, setImportOpen] = useState(true)
  const liveRef = useRef<HTMLLIElement | null>(null)
  const subtitleListRef = useRef<HTMLOListElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const animeSearchRef = useRef<HTMLInputElement | null>(null)
  const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const deepLinkFileHandledRef = useRef(false)
  const linkedLine = Number(new URLSearchParams(window.location.search).get('line'))
  const pendingLineRef = useRef<number | null>(Number.isFinite(linkedLine) && linkedLine >= 0 ? linkedLine : null)

  const current = currentSubtitle(lines, tracker, tick)
  const tokenizedLines = useMemo(() => lines.map((line) => ({ line, tokens: tokenize(line.plainText, dictionaryBuckets, tokenizer) })), [dictionaryBuckets, lines, tokenizer])
  const animeResults = useMemo(() => searchAnimeCatalog(animeCatalog, animeQuery), [animeCatalog, animeQuery])

  useEffect(() => {
    suggestionRefs.current[activeSuggestionIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeSuggestionIndex])

  useEffect(() => {
    const handleTypeToSearch = (event: KeyboardEvent) => {
      if (focusMode || selectedLookup || clearConfirmOpen || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      setImportOpen(true)
      window.requestAnimationFrame(() => animeSearchRef.current?.focus())
      setAnimeQuery((currentQuery) => selectedAnime || lines.length > 0 ? event.key : `${currentQuery}${event.key}`)
      setSelectedAnime(null)
      setActiveSubtitleFile(null)
      setSubtitleFiles([])
      setFilesStatus('')
      setShareStatus('')
      updateAnimeUrl(null)
      setActiveSuggestionIndex(0)
    }

    window.addEventListener('keydown', handleTypeToSearch)
    return () => window.removeEventListener('keydown', handleTypeToSearch)
  }, [clearConfirmOpen, focusMode, lines.length, selectedAnime, selectedLookup])

  useEffect(() => {
    const id = window.setInterval(() => setTick(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (tracker.status === 'running' && current && followCurrent) {
      scrollCurrentLine(focusMode ? 'start' : 'center')
    }
  }, [current, focusMode, followCurrent, tracker.status])

  useEffect(() => {
    if (!focusMode) return

    document.documentElement.classList.add('reader-focus-active')
    document.body.classList.add('reader-focus-active')
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusMode(false)
    }
    const handleResize = () => {
      if (followCurrent) window.requestAnimationFrame(() => scrollCurrentLine('start', false))
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    window.requestAnimationFrame(() => scrollCurrentLine('start', false))

    return () => {
      document.documentElement.classList.remove('reader-focus-active')
      document.body.classList.remove('reader-focus-active')
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [focusMode, followCurrent])

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
    localStorage.setItem(lookupHistoryKey, JSON.stringify(lookupHistory))
  }, [lookupHistory])

  useEffect(() => {
    localStorage.setItem(favoriteWordsKey, JSON.stringify(favoriteWords))
  }, [favoriteWords])

  useEffect(() => {
    localStorage.setItem(readerSettingsKey, JSON.stringify(readerSettings))
  }, [readerSettings])

  useEffect(() => {
    if (lines.length === 0) return
    const nextUrl = new URL(window.location.href)
    if (selectedAnime) nextUrl.searchParams.set('anime', animeStateId(selectedAnime))
    else nextUrl.searchParams.delete('anime')
    if (activeSubtitleFile) nextUrl.searchParams.set('subtitle', activeSubtitleFile.name)
    else nextUrl.searchParams.delete('subtitle')
    nextUrl.searchParams.set('font', String(readerSettings.subtitleFontSize))
    nextUrl.searchParams.set('furigana', String(readerSettings.furiganaOpacity))
    window.history.replaceState({}, '', nextUrl)
  }, [activeSubtitleFile, lines.length, readerSettings.furiganaOpacity, readerSettings.subtitleFontSize, selectedAnime])

  useEffect(() => {
    localStorage.setItem(recentActivityKey, JSON.stringify(recentActivity))
  }, [recentActivity])

  useEffect(() => {
    let cancelled = false

    void loadAnimeCatalog()
      .then((entries) => {
        if (cancelled) return
        setAnimeCatalog(entries)
        setCatalogStatus(`${entries.length.toLocaleString()} anime titles ready`)
        const requestedAnime = new URLSearchParams(window.location.search).get('anime')
        const sharedEntry = entries.find((entry) => animeStateId(entry) === requestedAnime)
        if (sharedEntry) {
          setSubtitleFiles([])
          setFilesStatus('Loading available subtitle files…')
          setError('')
          setShareStatus('')
          setSelectedAnime(sharedEntry)
          setAnimeQuery(sharedEntry.title)
          recordRecentSearch(sharedEntry)
        }
      })
      .catch(() => {
        if (cancelled) return
        setCatalogStatus('Anime search is unavailable right now; manual import still works')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedAnime) return
    let cancelled = false

    void listAjattSubtitleFiles(selectedAnime)
      .then((files) => {
        if (cancelled) return
        setSubtitleFiles(files)
        setFilesStatus(`${files.length} subtitle ${files.length === 1 ? 'file' : 'files'}`)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setFilesStatus('')
        setError(caught instanceof Error ? caught.message : 'Could not load subtitles for this title.')
      })

    return () => {
      cancelled = true
    }
  }, [selectedAnime])

  useEffect(() => {
    if (deepLinkFileHandledRef.current || !selectedAnime || subtitleFiles.length === 0) return
    const requestedFile = new URLSearchParams(window.location.search).get('subtitle')
    if (!requestedFile) return
    const file = subtitleFiles.find((candidate) => candidate.name === requestedFile)
    deepLinkFileHandledRef.current = true
    const timer = window.setTimeout(() => {
      if (!file) {
        setError('The shared subtitle file is no longer available. Choose another file for this anime.')
        return
      }
      void handleAjattFile(file, true)
    }, 0)
    return () => window.clearTimeout(timer)
    // The deep link must run once after the async subtitle list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnime, subtitleFiles])

  useEffect(() => {
    if (pendingLineRef.current === null || !current) return
    pendingLineRef.current = null
    window.requestAnimationFrame(() => scrollCurrentLine(focusMode ? 'start' : 'center', false))
  }, [current, focusMode])

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

  function recordRecentSearch(entry: AnimeCatalogEntry) {
    const nextSearch: RecentSearch = {
      id: animeStateId(entry),
      title: entry.title,
      japaneseName: entry.japaneseName,
      viewedAt: new Date().toISOString(),
    }

    setRecentActivity((currentActivity) => ({
      ...currentActivity,
      searches: [
        nextSearch,
        ...currentActivity.searches.filter((search) => search.id !== nextSearch.id),
      ].slice(0, recentActivityLimit),
    }))
  }

  function recordRecentSubtitle(subtitle: Omit<RecentSubtitle, 'viewedAt'>) {
    const nextSubtitle: RecentSubtitle = {
      ...subtitle,
      viewedAt: new Date().toISOString(),
    }

    setRecentActivity((currentActivity) => ({
      ...currentActivity,
      subtitles: [
        nextSubtitle,
        ...currentActivity.subtitles.filter((recent) => recent.id !== nextSubtitle.id),
      ].slice(0, recentActivityLimit),
    }))
  }

  function openSubtitle(name: string, text: string, recent?: Omit<RecentSubtitle, 'viewedAt'>) {
    const parsed = parseSubtitle(name, text)
    const requestedLine = pendingLineRef.current
    const anchorSubtitleMs = requestedLine === null
      ? parsed[0]?.startMs ?? 0
      : parsed.length > 0
        ? parsed.reduce((nearest, line) => Math.abs(line.startMs - requestedLine) < Math.abs(nearest.startMs - requestedLine) ? line : nearest, parsed[0]).startMs
        : 0
    setLines(parsed)
    setSourceName(name)
    setError('')
    setSelectedLookup(null)
    setFollowCurrent(true)
    setTracker({ status: 'idle', anchorSubtitleMs, anchorClockMs: performance.now() })
    setImportOpen(false)
    if (recent) recordRecentSubtitle(recent)
  }

  function scrollCurrentLine(block: 'start' | 'center', smooth = true) {
    const list = subtitleListRef.current
    const line = liveRef.current
    if (!list || !line) return

    const lineTop = line.offsetTop - list.offsetTop
    const centeredTop = lineTop - (list.clientHeight - line.offsetHeight) / 2
    list.scrollTo({
      top: block === 'start' ? lineTop : centeredTop,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }

  async function handleFile(file?: File) {
    if (!file) return
    try {
      setActiveSubtitleFile(null)
      const text = await file.text()
      openSubtitle(file.name, text, {
        id: `local:${file.name}`,
        name: file.name,
        kind: 'local',
      })
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
      setActiveSubtitleFile(null)
      openSubtitle(url, text, {
        id: `url:${url}`,
        name: url.split('/').pop() || url,
        kind: 'url',
        url,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unsupported subtitle format. Try .srt, .vtt, or .ass.')
    }
  }

  function handleAnimeSelect(entry: AnimeCatalogEntry) {
    setSubtitleFiles([])
    setFilesStatus('Loading available subtitle files…')
    setError('')
    setShareStatus('')
    setSelectedAnime(entry)
    setActiveSubtitleFile(null)
    deepLinkFileHandledRef.current = true
    setAnimeQuery(entry.title)
    updateAnimeUrl(entry)
    recordRecentSearch(entry)
  }

  function handleRecentSearch(search: RecentSearch) {
    const entry = animeCatalog.find((candidate) => animeStateId(candidate) === search.id)
    if (entry) handleAnimeSelect(entry)
  }

  async function handleRecentSubtitle(recent: RecentSubtitle) {
    if (recent.kind === 'local') {
      fileInputRef.current?.click()
      return
    }

    setLoadingRecentId(recent.id)
    setError('')

    try {
      if (recent.kind === 'catalog' && recent.file) {
        const entry = recent.animeId
          ? animeCatalog.find((candidate) => animeStateId(candidate) === recent.animeId)
          : undefined
        if (entry) handleAnimeSelect(entry)
        const text = await loadAjattSubtitleFile(recent.file)
        setActiveSubtitleFile(recent.file)
        openSubtitle(`${recent.animeTitle ?? 'AJATT'} · ${recent.file.name}`, text, {
          id: recent.id,
          name: recent.name,
          kind: recent.kind,
          animeId: recent.animeId,
          animeTitle: recent.animeTitle,
          file: recent.file,
        })
      } else if (recent.kind === 'url' && recent.url) {
        const response = await fetch(recent.url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        openSubtitle(recent.url, text, {
          id: recent.id,
          name: recent.name,
          kind: recent.kind,
          url: recent.url,
        })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reopen this subtitle.')
    } finally {
      setLoadingRecentId('')
    }
  }

  function jumpToCurrent() {
    setFollowCurrent(true)
    window.requestAnimationFrame(() => scrollCurrentLine(focusMode ? 'start' : 'center'))
  }

  function buildShareUrl(lineMs?: number) {
    const shareUrl = new URL(window.location.href)
    if (selectedAnime) shareUrl.searchParams.set('anime', animeStateId(selectedAnime))
    else shareUrl.searchParams.delete('anime')
    if (activeSubtitleFile) shareUrl.searchParams.set('subtitle', activeSubtitleFile.name)
    else shareUrl.searchParams.delete('subtitle')
    shareUrl.searchParams.set('font', String(readerSettings.subtitleFontSize))
    shareUrl.searchParams.set('furigana', String(readerSettings.furiganaOpacity))
    if (lineMs === undefined) shareUrl.searchParams.delete('line')
    else shareUrl.searchParams.set('line', String(lineMs))
    return shareUrl
  }

  async function copyShareUrl(shareUrl: URL, successMessage: string) {
    try {
      await navigator.clipboard.writeText(shareUrl.href)
      setShareStatus(successMessage)
    } catch {
      setShareStatus('Copy the URL from your browser')
    }
  }

  async function shareSelectedAnime() {
    if (!selectedAnime) return
    const shareUrl = buildShareUrl()
    const shareData = {
      title: `${selectedAnime.title} Japanese subtitles`,
      text: `Open Japanese subtitles for ${selectedAnime.title}`,
      url: shareUrl.href,
    }

    try {
      if (navigator.share) {
        await navigator.share(shareData)
        setShareStatus('Shared')
      } else {
        await copyShareUrl(shareUrl, 'Link copied')
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      try {
        await copyShareUrl(shareUrl, 'Link copied')
      } catch {
        setShareStatus('Copy the URL from your browser')
      }
    }
  }

  async function copyReaderLink() {
    await copyShareUrl(buildShareUrl(), activeSubtitleFile ? 'Exact subtitle link copied' : 'Reader link copied')
  }

  async function shareSubtitleLine(line: SubtitleLine) {
    const shareUrl = buildShareUrl(line.startMs)
    const shareData = {
      title: `${sourceName} at ${formatTime(line.startMs)}`,
      text: line.plainText,
      url: shareUrl.href,
    }

    try {
      if (navigator.share) {
        await navigator.share(shareData)
        setShareStatus('Line shared')
      } else {
        await copyShareUrl(shareUrl, 'Line link copied')
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      await copyShareUrl(shareUrl, 'Line link copied')
    }
  }

  async function handleAjattFile(file: SubtitleFile, preserveSharedLine = false) {
    setLoadingFileUrl(file.url)
    setError('')
    if (!preserveSharedLine) {
      pendingLineRef.current = null
      const nextUrl = new URL(window.location.href)
      nextUrl.searchParams.delete('line')
      window.history.replaceState({}, '', nextUrl)
    }
    try {
      const text = await loadAjattSubtitleFile(file)
      setActiveSubtitleFile(file)
      openSubtitle(`${selectedAnime?.title ?? 'AJATT'} · ${file.name}`, text, {
        id: `catalog:${file.url}`,
        name: file.name,
        kind: 'catalog',
        animeId: selectedAnime ? animeStateId(selectedAnime) : undefined,
        animeTitle: selectedAnime?.title,
        file,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this subtitle file.')
    } finally {
      setLoadingFileUrl('')
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
    setFollowCurrent(true)
    setTracker({ status: 'running', anchorSubtitleMs: line.startMs, anchorClockMs: performance.now() })
    window.requestAnimationFrame(() => scrollCurrentLine(focusMode ? 'start' : 'center'))
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

    setLookupHistory((currentLookups) => {
      const existing = currentLookups.find((lookup) => lookup.id === id)
      if (!existing) return [nextLookup, ...currentLookups]
      return currentLookups.map((lookup) => lookup.id === id ? { ...lookup, lookedUpAt: nextLookup.lookedUpAt, selected: true } : lookup)
    })
  }

  function handleTokenSelect(token: Token, line: SubtitleLine) {
    const lookup: SavedLookup = {
      id: makeLookupId(sourceName, line, token),
      sourceName,
      surface: token.surface,
      reading: token.reading ?? token.entry?.reading ?? '',
      meaning: token.entry?.meaning ?? 'No dictionary match found.',
      sentence: line.plainText,
      startMs: line.startMs,
      endMs: line.endMs,
      lookedUpAt: new Date().toISOString(),
      selected: true,
    }
    setSelectedLookup({ token, lookup })
    saveLookup(token, line)
  }

  function toggleSavedLookup(id: string) {
    setLookupHistory((currentLookups) => currentLookups.map((lookup) => lookup.id === id ? { ...lookup, selected: !lookup.selected } : lookup))
  }

  function setAllLookupsSelected(selected: boolean) {
    setLookupHistory((currentLookups) => currentLookups.map((lookup) => ({ ...lookup, selected })))
  }

  function isFavorite(lookup: SavedLookup) {
    const id = favoriteWordId(lookup)
    return favoriteWords.some((favorite) => favorite.id === id)
  }

  function toggleFavorite(lookup: SavedLookup) {
    const id = favoriteWordId(lookup)
    setFavoriteWords((currentFavorites) => {
      if (currentFavorites.some((favorite) => favorite.id === id)) {
        return currentFavorites.filter((favorite) => favorite.id !== id)
      }
      return [{ ...lookup, id, selected: true, lookedUpAt: new Date().toISOString() }, ...currentFavorites]
    })
  }

  function confirmClearSavedLookups() {
    setLookupHistory([])
    setClearConfirmOpen(false)
  }

  function exportLookups(lookups: SavedLookup[], format: ExportFormat, filenameStem: string) {
    if (lookups.length === 0) return
    const exports: Record<ExportFormat, { content: string; mime: string; filename: string }> = {
      tsv: {
        content: buildAnkiTsv(lookups),
        mime: 'text/tab-separated-values;charset=utf-8',
        filename: `${filenameStem}-anki.tsv`,
      },
      csv: {
        content: buildCsv(lookups),
        mime: 'text/csv;charset=utf-8',
        filename: `${filenameStem}.csv`,
      },
      txt: {
        content: buildPlainText(lookups),
        mime: 'text/plain;charset=utf-8',
        filename: `${filenameStem}.txt`,
      },
    }
    const output = exports[format]
    const blob = new Blob([output.content], { type: output.mime })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = output.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }

  function exportSelectedLookups() {
    exportLookups(lookupHistory.filter((lookup) => lookup.selected), exportFormat, 'subtitle-lookup-history')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Subtitle Companion home">
          <span className="brand-mark" aria-hidden="true">字</span>
          <span>
            <strong>Subtitle Companion</strong>
            <small>Japanese subtitle reader</small>
          </span>
        </a>
        <span className="privacy-note"><i aria-hidden="true" /> Runs locally</span>
      </header>

      <div className={lines.length > 0 ? 'page has-reader' : 'page'}>
        <section className="intro">
          <p className="eyebrow">Read · look up · collect</p>
          <h1>Japanese subtitles.<br /><span>Read along.</span></h1>
          <p>Open a subtitle file, keep time with the show, and tap any word for its reading and meaning.</p>
        </section>

        <div className={lines.length > 0 ? 'workspace workspace-loaded' : 'workspace'}>
          <div className="main-column">
            <details
              className="import-card"
              open={importOpen}
              onToggle={(event) => setImportOpen(event.currentTarget.open)}
            >
              <summary className="section-heading">
                <span className="section-number">01</span>
                <div>
                  <h2>{lines.length > 0 ? 'Change subtitles' : 'Open subtitles'}</h2>
                  <p>{lines.length > 0 ? sourceName : 'SRT, VTT, or ASS · stays on this device'}</p>
                </div>
                <span className="disclosure-label">{lines.length > 0 ? 'Change' : 'Open'}</span>
              </summary>

              <div className="import-body">
                <div className="anime-search">
                  <label htmlFor="anime-search">Search anime</label>
                  <div className="search-field">
                    <span aria-hidden="true">⌕</span>
                    <input
                      ref={animeSearchRef}
                      id="anime-search"
                      type="search"
                      autoComplete="off"
                      placeholder="Try “One Punch Man” or ワンパンマン"
                      value={animeQuery}
                      onChange={(event) => {
                        setAnimeQuery(event.target.value)
                        setActiveSuggestionIndex(0)
                        setSelectedAnime(null)
                        setActiveSubtitleFile(null)
                        setSubtitleFiles([])
                        setFilesStatus('')
                        setShareStatus('')
                        updateAnimeUrl(null)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' && animeResults.length > 0) {
                          event.preventDefault()
                          setActiveSuggestionIndex((currentIndex) => (currentIndex + 1) % animeResults.length)
                        } else if (event.key === 'ArrowUp' && animeResults.length > 0) {
                          event.preventDefault()
                          setActiveSuggestionIndex((currentIndex) => (currentIndex - 1 + animeResults.length) % animeResults.length)
                        } else if (event.key === 'Enter' && animeResults[activeSuggestionIndex]) {
                          event.preventDefault()
                          handleAnimeSelect(animeResults[activeSuggestionIndex])
                        } else if (event.key === 'Escape') {
                          setAnimeQuery('')
                          setActiveSuggestionIndex(0)
                        }
                      }}
                      aria-controls="anime-suggestions"
                      aria-autocomplete="list"
                      aria-activedescendant={animeResults[activeSuggestionIndex] && !selectedAnime ? `anime-option-${activeSuggestionIndex}` : undefined}
                      aria-expanded={Boolean(animeQuery.trim() && !selectedAnime)}
                    />
                  </div>
                  <p className="catalog-status">{catalogStatus}</p>

                  {!animeQuery.trim() && !selectedAnime && (recentActivity.searches.length > 0 || recentActivity.subtitles.length > 0) ? (
                    <section className="recent-activity" aria-label="Recent activity">
                      {recentActivity.searches.length > 0 ? (
                        <div className="recent-group">
                          <h3>Recent searches</h3>
                          <div className="recent-searches">
                            {recentActivity.searches.map((search) => (
                              <button
                                className="recent-search"
                                type="button"
                                key={search.id}
                                onClick={() => handleRecentSearch(search)}
                                disabled={animeCatalog.length === 0}
                              >
                                <span>{search.title}</span>
                                {search.japaneseName ? <small lang="ja">{search.japaneseName}</small> : null}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {recentActivity.subtitles.length > 0 ? (
                        <div className="recent-group">
                          <h3>Recently viewed</h3>
                          <ol className="recent-subtitles">
                            {recentActivity.subtitles.map((recent) => (
                              <li key={recent.id}>
                                <button type="button" onClick={() => void handleRecentSubtitle(recent)} disabled={Boolean(loadingRecentId)}>
                                  <span>
                                    <strong>{recent.name}</strong>
                                    <small>{recent.animeTitle ?? (recent.kind === 'local' ? 'Local file' : 'Direct URL')}</small>
                                  </span>
                                  <em>{loadingRecentId === recent.id ? 'Opening…' : recent.kind === 'local' ? 'Choose again' : 'Open'}</em>
                                </button>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {animeQuery.trim() && !selectedAnime ? (
                    <ul className="anime-suggestions" id="anime-suggestions" role="listbox">
                      {animeResults.map((entry, index) => (
                        <li key={entry.url}>
                          <button
                            ref={(button) => {
                              suggestionRefs.current[index] = button
                            }}
                            id={`anime-option-${index}`}
                            className={index === activeSuggestionIndex ? 'is-active' : undefined}
                            type="button"
                            role="option"
                            aria-selected={index === activeSuggestionIndex}
                            onMouseEnter={() => setActiveSuggestionIndex(index)}
                            onClick={() => handleAnimeSelect(entry)}
                          >
                            <span>
                              <strong>{entry.title}</strong>
                              {entry.englishName && entry.englishName !== entry.title ? <small>{entry.englishName}</small> : null}
                              {entry.japaneseName ? <small lang="ja">{entry.japaneseName}</small> : null}
                            </span>
                            <em>{entry.type}</em>
                          </button>
                        </li>
                      ))}
                      {animeResults.length === 0 && animeCatalog.length > 0 ? <li className="no-results">No matching anime found.</li> : null}
                    </ul>
                  ) : null}

                  {selectedAnime ? (
                    <section className="subtitle-results" aria-label={`Subtitles for ${selectedAnime.title}`}>
                      <header>
                        <div>
                          <strong>{selectedAnime.title}</strong>
                          <small>{filesStatus}</small>
                        </div>
                        <div className="anime-result-actions">
                          <button className="text-button" type="button" onClick={() => void shareSelectedAnime()}>Share</button>
                          <button className="text-button" type="button" onClick={() => {
                            setAnimeQuery('')
                            setSelectedAnime(null)
                            setSubtitleFiles([])
                            setShareStatus('')
                            updateAnimeUrl(null)
                          }}>Change</button>
                        </div>
                      </header>
                      {shareStatus ? <p className="share-status" aria-live="polite">{shareStatus}</p> : null}
                      {subtitleFiles.length > 0 ? (
                        <ol className="subtitle-files">
                          {subtitleFiles.map((file) => (
                            <li key={file.url}>
                              <button type="button" onClick={() => void handleAjattFile(file)} disabled={Boolean(loadingFileUrl)}>
                                <span>{file.name}</span>
                                <small>{loadingFileUrl === file.url ? 'Opening…' : file.size > 0 ? `${Math.ceil(file.size / 1024)} KB` : 'Open'}</small>
                              </button>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </section>
                  ) : null}
                </div>

                <details className="manual-import">
                  <summary>Import a file or direct URL</summary>
                  <div>
                    <label className="file-picker">
                      <input ref={fileInputRef} className="file-input" type="file" accept=".srt,.vtt,.ass" onChange={(event) => void handleFile(event.target.files?.[0])} />
                      <span className="file-copy">
                        <strong>Choose a subtitle file</strong>
                        <small>SRT, VTT, or ASS · stays on this device</small>
                      </span>
                      <span className="browse-button" aria-hidden="true">Browse</span>
                    </label>

                    <div className="url-import">
                      <label htmlFor="subtitle-url">Or load a direct URL</label>
                      <div className="url-row">
                        <input id="subtitle-url" placeholder="https://example.com/episode.srt" value={url} onChange={(event) => setUrl(event.target.value)} />
                        <button type="button" onClick={() => void handleUrlLoad()}>Load</button>
                      </div>
                    </div>
                  </div>
                </details>

                <p className="source-links">
                  Subtitle directories: <a href="https://subtitles.ajatt.top/" target="_blank" rel="noreferrer">AJATT mirror</a>
                  <span aria-hidden="true">·</span>
                  <a href="https://jimaku.cc/" target="_blank" rel="noreferrer">Jimaku</a>
                  <span aria-hidden="true">·</span>
                  <a href="https://kitsunekko.net/dirlist.php?dir=subtitles%2Fjapanese%2F" target="_blank" rel="noreferrer">Kitsunekko</a>
                </p>

                {error ? <p className="error" role="alert">{error}</p> : null}
                <div className="system-status" aria-live="polite">
                  <span><i aria-hidden="true" />{dictionaryStatus}</span>
                  <span><i aria-hidden="true" />{tokenizerStatus}</span>
                </div>
              </div>
            </details>

            {lines.length > 0 ? (
              <section
                className={focusMode ? 'reader is-focused' : 'reader'}
                role={focusMode ? 'dialog' : undefined}
                aria-modal={focusMode ? true : undefined}
                aria-labelledby="reader-title"
              >
                <header className="reader-bar">
                  <div>
                    <p className="eyebrow">Now reading</p>
                    <h2 id="reader-title">{sourceName}</h2>
                    <p>{lines.length} subtitle lines</p>
                  </div>
                  <div className="reader-actions">
                    <button className="secondary copy-link" type="button" onClick={() => void copyReaderLink()}>Copy link</button>
                    <button className="secondary focus-toggle" type="button" onClick={() => {
                      setFocusMode((currentMode) => !currentMode)
                      setFollowCurrent(true)
                    }}>
                      {focusMode ? 'Exit focus' : 'Focus view'}
                    </button>
                  </div>
                </header>
                {shareStatus ? <p className="reader-share-status" aria-live="polite">{shareStatus}</p> : null}

                <details className="reader-preferences">
                  <summary>Display settings</summary>
                  <div className="reader-settings">
                    <label className="reader-setting-control">
                      Text
                      <select value={readerSettings.subtitleFontSize} onChange={(event) => setReaderSettings((currentSettings) => ({
                        ...currentSettings,
                        subtitleFontSize: Number(event.target.value),
                      }))}>
                        <option value="18">Small</option>
                        <option value="22">Medium</option>
                        <option value="26">Large</option>
                        <option value="30">Extra large</option>
                      </select>
                    </label>
                    <label className="reader-setting-control">
                      Furigana opacity
                      <span className="number-setting">
                        <input
                          aria-label="Furigana opacity percentage"
                          type="number"
                          min="0"
                          max="100"
                          inputMode="numeric"
                          value={readerSettings.furiganaOpacity}
                          onChange={(event) => {
                            const nextOpacity = event.target.valueAsNumber
                            if (!Number.isFinite(nextOpacity)) return
                            setReaderSettings((currentSettings) => ({
                              ...currentSettings,
                              furiganaOpacity: Math.min(100, Math.max(0, nextOpacity)),
                            }))
                          }}
                        />
                        <span aria-hidden="true">%</span>
                      </span>
                    </label>
                    <button className="secondary" type="button" onClick={() => setReaderSettings((currentSettings) => ({
                      ...currentSettings,
                      furigana: !currentSettings.furigana,
                    }))}>
                      Furigana {readerSettings.furigana ? 'on' : 'off'}
                    </button>
                  </div>
                </details>

                <div className="controls">
                  <button type="button" onClick={togglePlayback}>{tracker.status === 'running' ? 'Pause' : tracker.status === 'paused' ? 'Resume' : 'Start clock'}</button>
                  <button className="text-button" type="button" onClick={jumpToCurrent}>Jump to current</button>
                  {focusMode ? (
                    <button
                      className="text-button follow-toggle"
                      type="button"
                      aria-pressed={followCurrent}
                      onClick={() => setFollowCurrent((isFollowing) => !isFollowing)}
                    >
                      {followCurrent ? 'Following current' : 'Browse history'}
                    </button>
                  ) : null}
                  <span className="clock"><i className={tracker.status === 'running' ? 'is-live' : ''} aria-hidden="true" />{formatTime(virtualTime(tracker, tick))}</span>
                </div>

                <ol
                  ref={subtitleListRef}
                  className="subtitle-list"
                  style={{
                    '--subtitle-font-size': `${readerSettings.subtitleFontSize}px`,
                    '--furigana-opacity': readerSettings.furiganaOpacity / 100,
                  } as CSSProperties}
                >
                  {tokenizedLines.map(({ line, tokens }) => {
                    const isCurrent = line.id === current?.id
                    return (
                      <li className={isCurrent ? 'subtitle-line current' : 'subtitle-line'} key={line.id} ref={isCurrent ? liveRef : undefined}>
                        <div className="line-meta">
                          <button className="time" type="button" onClick={() => reanchor(line)} aria-label={`Re-anchor playback at ${formatTime(line.startMs)}`}>
                            {formatTime(line.startMs)}
                          </button>
                        </div>
                        <p className="line-text">
                          {tokens.map((token) => (
                            token.surface.trim() === '' ? <span key={token.id}>{token.surface}</span> :
                            <button className="token" key={token.id} type="button" onClick={() => handleTokenSelect(token, line)}>
                              {readerSettings.furigana && token.hasKanji && token.reading ? (
                                <ruby>{token.surface}<rt>{token.reading}</rt></ruby>
                              ) : token.surface}
                            </button>
                          ))}
                        </p>
                        <button className="line-share" type="button" onClick={() => void shareSubtitleLine(line)} aria-label={`Share subtitle line at ${formatTime(line.startMs)}`}>
                          <ShareIcon />
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </section>
            ) : null}
          </div>

          <aside className="word-sidebar">
            <section className="saved-lookups" aria-labelledby="history-title">
              <header className="saved-lookups-header">
                <div>
                  <span className="section-number">02</span>
                  <h2 id="history-title">Lookup history</h2>
                </div>
                <span className="saved-count">{lookupHistory.length}</span>
              </header>
              <p className="saved-summary">{lookupHistory.filter((lookup) => lookup.selected).length} selected for export</p>

              {lookupHistory.length > 0 ? (
                <div className="selection-actions">
                  <button className="text-button" type="button" onClick={() => setAllLookupsSelected(true)}>Select all</button>
                  <button className="text-button" type="button" onClick={() => setAllLookupsSelected(false)}>Deselect all</button>
                </div>
              ) : null}

              {lookupHistory.length === 0 ? (
                <div className="empty-lookups compact-empty">
                  <span aria-hidden="true">あ</span>
                  <p>No lookups yet.</p>
                  <small>Words you tap appear here automatically.</small>
                </div>
              ) : (
                <ol className="saved-list">
                  {lookupHistory.map((lookup) => (
                    <li className="saved-item" key={lookup.id}>
                      <div className="saved-item-top">
                        <label className="saved-check">
                          <input checked={lookup.selected} type="checkbox" onChange={() => toggleSavedLookup(lookup.id)} />
                          <span>
                            <strong>{lookup.surface}</strong>
                            {lookup.reading ? <span className="saved-reading">{lookup.reading}</span> : null}
                          </span>
                        </label>
                        <button
                          className={isFavorite(lookup) ? 'star-button is-saved' : 'star-button'}
                          type="button"
                          aria-label={isFavorite(lookup) ? `Remove ${lookup.surface} from saved words` : `Save ${lookup.surface}`}
                          aria-pressed={isFavorite(lookup)}
                          onClick={() => toggleFavorite(lookup)}
                        >
                          <StarIcon filled={isFavorite(lookup)} />
                        </button>
                      </div>
                      <p>{lookup.meaning}</p>
                      <blockquote>{lookup.sentence}</blockquote>
                      <small>{formatTime(lookup.startMs)}–{formatTime(lookup.endMs)}</small>
                    </li>
                  ))}
                </ol>
              )}

              <div className="saved-actions">
                <div className="export-split">
                  <button type="button" onClick={exportSelectedLookups} disabled={lookupHistory.every((lookup) => !lookup.selected)}>
                    Export {exportFormat.toUpperCase()}
                  </button>
                  <select aria-label="Lookup history export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                    <option value="tsv">TSV · Anki</option>
                    <option value="csv">CSV</option>
                    <option value="txt">TXT</option>
                  </select>
                </div>
                <button className="text-button danger-text" type="button" onClick={() => setClearConfirmOpen(true)} disabled={lookupHistory.length === 0}>Clear history</button>
              </div>
            </section>

            <section className="saved-lookups favorite-words" aria-labelledby="favorites-title">
              <header className="saved-lookups-header">
                <div>
                  <span className="section-number">03</span>
                  <h2 id="favorites-title">Saved words</h2>
                </div>
                <span className="saved-count">{favoriteWords.length}</span>
              </header>
              <p className="saved-summary">Only words you deliberately star.</p>

              {favoriteWords.length === 0 ? (
                <div className="empty-lookups compact-empty">
                  <StarIcon />
                  <p>No saved words yet.</p>
                  <small>Use the star in a lookup or in your history.</small>
                </div>
              ) : (
                <ol className="saved-list favorite-list">
                  {favoriteWords.map((lookup) => (
                    <li className="saved-item" key={lookup.id}>
                      <div className="saved-item-top">
                        <span className="saved-word">
                          <strong>{lookup.surface}</strong>
                          {lookup.reading ? <span className="saved-reading">{lookup.reading}</span> : null}
                        </span>
                        <button className="star-button is-saved" type="button" aria-label={`Remove ${lookup.surface} from saved words`} onClick={() => toggleFavorite(lookup)}>
                          <StarIcon filled />
                        </button>
                      </div>
                      <p>{lookup.meaning}</p>
                      <blockquote>{lookup.sentence}</blockquote>
                    </li>
                  ))}
                </ol>
              )}

              <div className="saved-actions">
                <div className="export-split">
                  <button type="button" onClick={() => exportLookups(favoriteWords, favoriteExportFormat, 'subtitle-saved-words')} disabled={favoriteWords.length === 0}>
                    Export {favoriteExportFormat.toUpperCase()}
                  </button>
                  <select aria-label="Saved words export format" value={favoriteExportFormat} onChange={(event) => setFavoriteExportFormat(event.target.value as ExportFormat)}>
                    <option value="tsv">TSV · Anki</option>
                    <option value="csv">CSV</option>
                    <option value="txt">TXT</option>
                  </select>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>

      {selectedLookup ? (
        <aside className="lookup" role="dialog" aria-label="Dictionary lookup">
          <button className="close" type="button" onClick={() => setSelectedLookup(null)} aria-label="Close dictionary lookup">Close</button>
          <p className="eyebrow">Lookup</p>
          <h2>{selectedLookup.token.surface}</h2>
          {selectedLookup.token.entry ? (
            <>
              <p className="reading">{selectedLookup.token.reading ?? selectedLookup.token.entry.reading}</p>
              <p>{selectedLookup.token.entry.meaning}</p>
            </>
          ) : selectedLookup.token.reading ? (
            <>
              <p className="reading">{selectedLookup.token.reading}</p>
              <p>No dictionary match found.</p>
            </>
          ) : (
            <p>No dictionary match found.</p>
          )}
          <button
            className={isFavorite(selectedLookup.lookup) ? 'lookup-save is-saved' : 'lookup-save'}
            type="button"
            aria-pressed={isFavorite(selectedLookup.lookup)}
            onClick={() => toggleFavorite(selectedLookup.lookup)}
          >
            <StarIcon filled={isFavorite(selectedLookup.lookup)} />
            {isFavorite(selectedLookup.lookup) ? 'Saved word' : 'Save word'}
          </button>
        </aside>
      ) : null}

      {clearConfirmOpen ? (
        <div className="modal-backdrop">
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-description">
            <p className="eyebrow">Confirm action</p>
            <h2 id="clear-title">Clear lookup history?</h2>
            <p id="clear-description">This removes all {lookupHistory.length} history {lookupHistory.length === 1 ? 'entry' : 'entries'} from this device. Your starred words stay saved.</p>
            <div>
              <button className="secondary" type="button" onClick={() => setClearConfirmOpen(false)}>Cancel</button>
              <button className="danger-button" type="button" onClick={confirmClearSavedLookups}>Clear list</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}

export default App
