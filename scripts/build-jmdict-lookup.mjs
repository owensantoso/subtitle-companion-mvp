import fs from 'node:fs'

const sourcePath = 'tmp/jmdict/jmdict-eng-3.6.2.json'
const outPath = 'public/dictionaries/jmdict-eng-lookup.json'

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const bySurface = new Map()

function glossesFor(word) {
  return word.sense
    .flatMap((sense) => sense.gloss.filter((gloss) => gloss.lang === 'eng').map((gloss) => gloss.text))
    .filter(Boolean)
}

for (const word of source.words) {
  const meanings = glossesFor(word).slice(0, 4)
  if (meanings.length === 0) continue

  const kana = word.kana.map((item) => item.text)
  const primaryReading = kana[0]
  if (!primaryReading) continue

  const surfaces = new Set([...word.kanji.map((item) => item.text), ...kana])
  const meaning = meanings.join('; ')

  for (const surface of surfaces) {
    const existing = bySurface.get(surface)
    const candidate = {
      surface,
      reading: kana.includes(surface) ? surface : primaryReading,
      meaning,
      common: word.kanji.some((item) => item.text === surface && item.common) || word.kana.some((item) => item.text === surface && item.common),
    }

    if (!existing || (!existing.common && candidate.common)) {
      bySurface.set(surface, candidate)
    }
  }
}

const buckets = {}
for (const entry of bySurface.values()) {
  const first = [...entry.surface][0]
  buckets[first] ??= []
  buckets[first].push([entry.surface, entry.reading, entry.meaning])
}

for (const entries of Object.values(buckets)) {
  entries.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], 'ja'))
}

const output = {
  source: 'JMdict simplified English 3.6.2+20260413165336',
  entryCount: bySurface.size,
  buckets,
}

fs.writeFileSync(outPath, JSON.stringify(output))
console.log(`Wrote ${bySurface.size} lookup entries to ${outPath}`)
