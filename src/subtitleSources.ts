export type AnimeCatalogEntry = {
  title: string
  englishName: string
  japaneseName: string
  type: 'TV' | 'Movie'
  url: string
}

export type SubtitleFile = {
  name: string
  url: string
  size: number
}

type AnimeCatalog = {
  updatedAt: string
  source: string
  entries: AnimeCatalogEntry[]
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim()
}

function scoreEntry(entry: AnimeCatalogEntry, query: string) {
  const names = [entry.title, entry.englishName, entry.japaneseName]
    .filter(Boolean)
    .map(normalizeSearch)
  const tokens = query.split(/\s+/)
  if (!tokens.every((token) => names.some((name) => name.includes(token)))) return -1
  if (names.some((name) => name === query)) return 0
  if (names.some((name) => name.startsWith(query))) return 1
  if (names.some((name) => name.split(' ').some((word) => word.startsWith(query)))) return 2
  return 3
}

export async function loadAnimeCatalog() {
  const response = await fetch('./subtitle-catalog.json')
  if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`)
  const catalog = await response.json() as AnimeCatalog
  return catalog.entries
}

export function searchAnimeCatalog(entries: AnimeCatalogEntry[], rawQuery: string, limit = 8) {
  const query = normalizeSearch(rawQuery)
  if (!query) return []

  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
    .filter((result) => result.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((result) => result.entry)
}

export async function listAjattSubtitleFiles(entry: AnimeCatalogEntry) {
  const response = await fetch(entry.url)
  if (!response.ok) throw new Error(`Subtitle list request failed with HTTP ${response.status}`)
  const html = await response.text()
  const document = new DOMParser().parseFromString(html, 'text/html')

  const files = [...document.querySelectorAll<HTMLInputElement>('.file-checkbox[data-download-url]')]
    .map((input) => ({
      name: input.dataset.filename ?? '',
      url: input.dataset.downloadUrl ?? '',
      size: Number(input.closest('tr')?.dataset.fileSize ?? 0),
    }))
    .filter((file) => file.name && file.url && /\.(srt|ass|vtt)$/i.test(file.name))
  const uniqueFiles = [...new Map(files.map((file) => [file.url, file])).values()]

  if (uniqueFiles.length === 0) throw new Error('No supported subtitle files were found for this title.')
  return uniqueFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export async function loadAjattSubtitleFile(file: SubtitleFile) {
  const response = await fetch(file.url)
  if (!response.ok) throw new Error(`Subtitle request failed with HTTP ${response.status}`)
  return response.text()
}
