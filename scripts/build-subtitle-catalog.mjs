import { mkdir, writeFile } from 'node:fs/promises'

const catalogUrl = 'https://subtitles.ajatt.top/'
const outputPath = new URL('../public/subtitle-catalog.json', import.meta.url)

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function textFromCell(row, className) {
  const match = row.match(new RegExp(`<td[^>]*class="${className}"[^>]*>([\\s\\S]*?)<\\/td>`))
  const value = decodeHtml((match?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
  return value === 'None' ? '' : value
}

const response = await fetch(catalogUrl)
if (!response.ok) throw new Error(`AJATT catalog request failed with HTTP ${response.status}`)
const html = await response.text()
const rows = [...html.matchAll(/<tr data-timestamp="[^"]+" data-entry-type="([^"]+)">([\s\S]*?)<\/tr>/g)]

const entries = rows
  .filter(([, entryType]) => entryType === 'anime_tv' || entryType === 'anime_movie')
  .map(([, entryType, row]) => {
  const link = row.match(/class="entry_name"[^>]*>\s*<a href="([^"]+)">([\s\S]*?)<\/a>/)
  if (!link) throw new Error('AJATT catalog row is missing its entry link')

  return {
    title: decodeHtml(link[2].replace(/<[^>]+>/g, '').trim()),
    englishName: textFromCell(row, 'english_name'),
    japaneseName: textFromCell(row, 'japanese_name'),
    type: entryType === 'anime_movie' ? 'Movie' : 'TV',
    url: new URL(decodeHtml(link[1]), catalogUrl).href,
  }
  })

if (entries.length < 100) {
  throw new Error(`AJATT catalog parser found only ${entries.length} entries`)
}

await mkdir(new URL('../public/', import.meta.url), { recursive: true })
await writeFile(outputPath, `${JSON.stringify({
  updatedAt: new Date().toISOString(),
  source: catalogUrl,
  entries,
})}\n`)

console.log(`Wrote ${entries.length.toLocaleString()} AJATT anime entries to public/subtitle-catalog.json`)
