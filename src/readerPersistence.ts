import { useEffect, useRef, useState } from 'react'
import type { SubtitleFile } from './subtitleSources'

type SubtitleDensity = 'compact' | 'comfortable'
export type SavedLookup = {
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

export type RecentSubtitle = {
  id: string
  name: string
  kind: 'catalog' | 'url' | 'local'
  viewedAt: string
  positionMs?: number
  animeId?: string
  animeTitle?: string
  file?: SubtitleFile
  url?: string
}

export type RecentSearch = {
  id: string
  title: string
  japaneseName?: string
  viewedAt: string
}

export type RecentActivity = {
  subtitles: RecentSubtitle[]
  searches: RecentSearch[]
}

export type ReaderSettings = {
  furigana: boolean
  furiganaOpacity: number
  subtitleFontSize: number
  dimInactive: boolean
  density: SubtitleDensity
  autoResumeFollow: boolean
  autoResumeDelayMs: number
  tapLineToSeek: boolean
}

type HydrationStatus = 'missing' | 'valid' | 'read-error' | 'parse-error' | 'invalid-records'
type Decoded<T> = { value: T; valid: boolean }
type Hydrated<T> = { value: T; status: HydrationStatus }
const prefix = 'subtitle-companion:'
const keys = { history: `${prefix}lookup-history:v1`, favorites: `${prefix}favorite-words:v1`, settings: `${prefix}reader-settings:v1`, recent: `${prefix}recent-activity:v1` }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const settingNumber = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
const optionalText = (value: unknown) => value === undefined || text(value)

function validLookup(value: unknown): value is SavedLookup {
  return record(value) && ['id', 'sourceName', 'surface', 'reading', 'meaning', 'sentence', 'lookedUpAt'].every(key => text(value[key]))
    && number(value.startMs) && number(value.endMs) && value.endMs >= value.startMs && typeof value.selected === 'boolean'
}
function validFile(value: unknown): value is SubtitleFile {
  return record(value) && text(value.name) && text(value.url) && number(value.size)
}
function validSubtitle(value: unknown): value is RecentSubtitle {
  return record(value) && text(value.id) && text(value.name) && text(value.viewedAt)
    && (value.positionMs === undefined || number(value.positionMs))
    && ['animeId', 'animeTitle', 'url'].every(key => optionalText(value[key]))
    && (value.file === undefined || validFile(value.file))
    && (value.kind === 'local' || (value.kind === 'url' && text(value.url)) || (value.kind === 'catalog' && validFile(value.file)))
}
function validSearch(value: unknown): value is RecentSearch {
  return record(value) && text(value.id) && text(value.title) && text(value.viewedAt) && optionalText(value.japaneseName)
}
function rows<T>(value: unknown, valid: (row: unknown) => row is T): Decoded<T[]> {
  if (!Array.isArray(value)) return { value: [], valid: false }
  const accepted = value.filter(valid)
  return { value: accepted, valid: accepted.length === value.length }
}
function recent(value: unknown): Decoded<RecentActivity> {
  if (!record(value)) return { value: { subtitles: [], searches: [] }, valid: false }
  const subtitles = rows(value.subtitles, validSubtitle), searches = rows(value.searches, validSearch)
  return { value: { subtitles: subtitles.value.slice(0, 6), searches: searches.value.slice(0, 6) }, valid: subtitles.valid && searches.valid }
}
function hydrate<T>(key: string, fallback: T, decode: (value: unknown) => Decoded<T>, legacyKey?: string): Hydrated<T> {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
    if (raw === null && legacyKey) raw = localStorage.getItem(legacyKey)
  } catch { return { value: fallback, status: 'read-error' } }
  if (raw === null) return { value: fallback, status: 'missing' }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { value: fallback, status: 'parse-error' } }
  const decoded = decode(parsed)
  return { value: decoded.value, status: decoded.valid ? 'valid' : 'invalid-records' }
}

const defaults: ReaderSettings = { furigana: true, furiganaOpacity: 100, subtitleFontSize: 22, dimInactive: true, density: 'compact', autoResumeFollow: true, autoResumeDelayMs: 3000, tapLineToSeek: true }
function settings(): Hydrated<ReaderSettings> {
  let hasStoredFont = false
  const loaded = hydrate<ReaderSettings>(keys.settings, defaults, value => {
    if (!record(value)) return { value: defaults, valid: false }
    hasStoredFont = [18, 22, 26, 30].includes(settingNumber(value.subtitleFontSize))
    const bool = (key: string) => value[key] === undefined || typeof value[key] === 'boolean'
    const numeric = (key: string) => value[key] === undefined || ((typeof value[key] === 'number' || typeof value[key] === 'string') && Number.isFinite(Number(value[key])))
    const valid = ['furigana', 'dimInactive', 'autoResumeFollow', 'tapLineToSeek'].every(bool)
      && ['furiganaOpacity', 'subtitleFontSize', 'autoResumeDelayMs'].every(numeric)
      && (value.density === undefined || value.density === 'compact' || value.density === 'comfortable')
    return { valid, value: {
      furigana: typeof value.furigana === 'boolean' ? value.furigana : defaults.furigana,
      furiganaOpacity: numeric('furiganaOpacity') && value.furiganaOpacity !== undefined ? Math.min(100, Math.max(0, Number(value.furiganaOpacity))) : defaults.furiganaOpacity,
      subtitleFontSize: [18, 22, 26, 30].includes(settingNumber(value.subtitleFontSize)) ? settingNumber(value.subtitleFontSize) : defaults.subtitleFontSize,
      dimInactive: typeof value.dimInactive === 'boolean' ? value.dimInactive : defaults.dimInactive,
      density: value.density === 'comfortable' ? 'comfortable' : 'compact',
      autoResumeFollow: typeof value.autoResumeFollow === 'boolean' ? value.autoResumeFollow : defaults.autoResumeFollow,
      autoResumeDelayMs: numeric('autoResumeDelayMs') && value.autoResumeDelayMs !== undefined ? Math.min(30000, Math.max(500, Number(value.autoResumeDelayMs))) : defaults.autoResumeDelayMs,
      tapLineToSeek: typeof value.tapLineToSeek === 'boolean' ? value.tapLineToSeek : defaults.tapLineToSeek,
    } }
  })
  // Preserve legacy font and URL preferences without treating unreadable storage as empty.
  let legacyFont: number | undefined
  try { legacyFont = Number(localStorage.getItem(`${prefix}subtitle-font-size:v1`)) }
  catch { if (!hasStoredFont && (loaded.status === 'missing' || loaded.status === 'valid')) loaded.status = 'read-error' }
  const params = new URLSearchParams(window.location.search)
  const linkedFont = Number(params.get('font')), linkedOpacity = Number(params.get('furigana'))
  if (!hasStoredFont && [18, 22, 26, 30].includes(legacyFont ?? 0)) loaded.value = { ...loaded.value, subtitleFontSize: legacyFont! }
  if ([18, 22, 26, 30].includes(linkedFont)) loaded.value = { ...loaded.value, subtitleFontSize: linkedFont }
  if (params.has('furigana') && Number.isFinite(linkedOpacity)) loaded.value = { ...loaded.value, furiganaOpacity: Math.min(100, Math.max(0, linkedOpacity)) }
  return loaded
}

function usePersisted<T>(key: string, label: string, load: () => Hydrated<T>) {
  const [hydrated] = useState(load)
  const [value, setValue] = useState(hydrated.value)
  const [writeFailed, setWriteFailed] = useState(false)
  const lastWritten = useRef<string | undefined>(undefined)
  const blocked = hydrated.status !== 'missing' && hydrated.status !== 'valid'
  useEffect(() => {
    if (blocked) return
    let failed = false
    try {
      const serialized = JSON.stringify(value)
      if (serialized !== lastWritten.current) {
        localStorage.setItem(key, serialized)
        lastWritten.current = serialized
      }
    } catch { failed = true }
    // This state reports the result of synchronizing with fallible browser storage.
    setWriteFailed(failed)
  }, [blocked, key, value])
  const reason = hydrated.status === 'invalid-records' ? 'has some saved entries that could not be loaded' : 'could not be loaded'
  const notice = blocked ? `${label} ${reason}. Stored data was left unchanged. You can keep reading, but changes to this collection will not be saved.`
    : writeFailed ? `${label} could not be saved in this browser. You can keep reading; saving will be tried again when this collection changes.` : null
  return { value, setValue, notice }
}
export function useReaderPersistence() {
  const history = usePersisted(keys.history, 'Lookup history', () => hydrate(keys.history, [], value => rows(value, validLookup), `${prefix}saved-lookups:v1`))
  const favorites = usePersisted(keys.favorites, 'Saved words', () => hydrate(keys.favorites, [], value => rows(value, validLookup)))
  const preferences = usePersisted(keys.settings, 'Reader settings', settings)
  const activity = usePersisted(keys.recent, 'Recent activity', () => hydrate(keys.recent, { subtitles: [], searches: [] }, recent))
  return { lookupHistory: history.value, setLookupHistory: history.setValue, favoriteWords: favorites.value, setFavoriteWords: favorites.setValue, readerSettings: preferences.value, setReaderSettings: preferences.setValue, recentActivity: activity.value, setRecentActivity: activity.setValue, notices: [history.notice, favorites.notice, preferences.notice, activity.notice].filter((notice): notice is string => notice !== null) }
}
