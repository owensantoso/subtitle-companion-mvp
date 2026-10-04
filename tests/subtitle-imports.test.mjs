import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Exercise mounted React handlers, not a copy of their ownership logic.
const recentKey = 'subtitle-companion:recent-activity:v1'
const subtitle = (name) => `1\n00:00:00,000 --> 00:00:05,000\n${name}_START\n\n2\n00:00:10,000 --> 00:00:15,000\n${name}_LATER\n`
const catalog = [{ title: 'Fixture anime', englishName: '', japaneseName: '', type: 'TV', url: 'https://fixture.invalid/anime-a' }]
const file = { name: 'catalog-a.srt', url: 'https://fixture.invalid/catalog-a.srt', size: 100 }
let browser, server, origin
before(async () => {
  const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(windowsChrome) ? windowsChrome : undefined)
  browser = await chromium.launch({ executablePath, headless: true })
  server = await createServer({ root: process.env.SUBTITLE_TEST_ROOT || process.cwd(), server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  await server.listen()
  origin = server.resolvedUrls.local[0]
})
after(async () => { await server?.close(); await browser?.close() })

function deferred() {
  let resolve, seen
  const response = new Promise(r => { resolve = r })
  const requested = new Promise(r => { seen = r })
  return { requested, release: resolve, route: async route => {
    seen()
    await route.fulfill({ status: 200, contentType: 'text/plain', body: subtitle('OLD'), headers: { 'access-control-allow-origin': '*' }, ...await response })
  } }
}

async function fixture(t, { routes = {}, recent = [], query = '', delayedFile = false, holdDeepLink = false } = {}) {
  const context = await browser.newContext()
  t.after(async () => { for (const gate of Object.values(routes)) gate.release({}); await context.close() })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, [], 'unexpected rendered-app errors'))
  await context.addInitScript(({ recentKey, recent, delayedFile, holdDeepLink }) => {
    localStorage.setItem(recentKey, JSON.stringify({ subtitles: recent, searches: [] }))
    if (holdDeepLink) {
      const original = window.setTimeout.bind(window)
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 0 && String(callback).includes('handleAjattFile')) {
          window.releaseDeepLink = () => callback(...args)
          return original(() => {}, 60000)
        }
        return original(callback, delay, ...args)
      }
    }
    if (delayedFile) {
      const original = File.prototype.text
      File.prototype.text = function () {
        if (this.name !== 'delayed.srt') return original.call(this)
        window.fileReadStarted = true
        return new Promise(resolve => { window.releaseFile = () => original.call(this).then(resolve) })
      }
    }
  }, { recentKey, recent, delayedFile, holdDeepLink })
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (routes[url]) return routes[url].route(route)
    if (url.includes('/kuromoji/')) return route.fulfill({ status: 404, body: '' })
    if (url.endsWith('/subtitle-catalog.json')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: catalog }) })
    if (url === catalog[0].url) return route.fulfill({ contentType: 'text/html', body: `<table><tr data-file-size="100"><td><input class="file-checkbox" data-filename="${file.name}" data-download-url="${file.url}"></td></tr></table>` })
    if (url === file.url) return route.fulfill({ contentType: 'text/plain', body: subtitle('CATALOG') })
    if (url.startsWith('https://fixture.invalid/')) return route.fulfill({ contentType: 'text/plain', body: subtitle('NEW') })
    if (url.includes('/dictionaries/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entryCount: 0, buckets: {} }) })
    if (url.startsWith(origin) || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
  await page.goto(origin + query, { waitUntil: 'domcontentloaded' })
  return page
}
async function manual(page) { const detail = page.locator('.manual-import'); if (!await detail.evaluate(x => x.open)) await detail.locator('summary').click() }
async function urlImport(page, url) { await manual(page); await page.locator('#subtitle-url').fill(url); await page.locator('.url-row button').click() }
async function localImport(page, name = 'new.srt', text = subtitle('NEW')) { await page.locator('input.file-input').setInputFiles({ name, mimeType: 'application/x-subrip', buffer: Buffer.from(text) }) }
async function loaded(page, text) { await page.getByText(text, { exact: true }).first().waitFor({ state: 'attached' }) }
async function drain(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function release(page, gate, url, response = {}) {
  const completed = page.waitForResponse(url)
  gate.release(response)
  await (await completed).finished()
  await drain(page)
}
async function assertNewReader(page) {
  assert.ok((await page.locator('body').textContent()).includes('NEW_START'))
  assert.equal((await page.locator('body').textContent()).includes('OLD_START'), false)
}
async function recentButton(page, name) { return page.locator('.recent-subtitle-open').filter({ has: page.locator('strong', { hasText: name }) }) }
function recent(name, kind = 'url') { return { id: `${kind}:${name}`, name, kind, url: `https://fixture.invalid/${name}`, viewedAt: '2026-01-01T00:00:00.000Z', positionMs: 10000, ...(kind === 'catalog' ? { file, animeId: 'anime-a', animeTitle: catalog[0].title } : {}) } }
async function position(page, name) { return page.evaluate(({ key, name }) => JSON.parse(localStorage.getItem(key)).subtitles.find(x => x.name === name)?.positionMs, { key: recentKey, name }) }

for (const [name, response] of [['success', {}], ['HTTP failure', { status: 500 }], ['parse failure', { body: 'not a subtitle' }]]) {
  test(`obsolete direct URL ${name} preserves newer reader and video`, { timeout: 20000 }, async t => {
    const gate = deferred(), oldUrl = 'https://fixture.invalid/old.srt'
    const page = await fixture(t, { routes: { [oldUrl]: gate } })
    await urlImport(page, oldUrl); await gate.requested
    await localImport(page); await loaded(page, 'NEW_START')
    await page.locator('input[type="file"][accept*="video"]').setInputFiles({ name: 'synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from('nonplayable synthetic blob') })
    await page.locator('video').waitFor({ state: 'attached' })
    const blob = await page.locator('video').getAttribute('src')
    await release(page, gate, oldUrl, response)
    await assertNewReader(page)
    assert.equal(await page.locator('video').getAttribute('src'), blob)
    assert.equal(await page.locator('.error').count(), 0)
  })
}
test('obsolete File.text cannot replace newer URL', { timeout: 20000 }, async t => {
  const page = await fixture(t, { delayedFile: true })
  await localImport(page, 'delayed.srt', subtitle('OLD'))
  await page.waitForFunction(() => window.fileReadStarted)
  await urlImport(page, 'https://fixture.invalid/new.srt'); await loaded(page, 'NEW_START')
  await page.evaluate(() => window.releaseFile()); await drain(page)
  await assertNewReader(page)
})
test('newer URL wins when the older URL resolves last', { timeout: 20000 }, async t => {
  const gate = deferred(), oldUrl = 'https://fixture.invalid/old.srt'
  const page = await fixture(t, { routes: { [oldUrl]: gate } })
  await urlImport(page, oldUrl); await gate.requested
  await urlImport(page, 'https://fixture.invalid/new.srt'); await loaded(page, 'NEW_START')
  await release(page, gate, oldUrl); await assertNewReader(page)
})
for (const kind of ['url', 'catalog']) {
  test(`obsolete recent ${kind} import cannot reuse its resume position`, { timeout: 20000 }, async t => {
    const item = recent('old.srt', kind), oldUrl = kind === 'catalog' ? file.url : item.url, gate = deferred()
    const page = await fixture(t, { routes: { [oldUrl]: gate }, recent: [item] })
    await (await recentButton(page, item.name)).click(); await gate.requested
    await localImport(page); await loaded(page, 'NEW_START')
    await release(page, gate, oldUrl); await assertNewReader(page)
    assert.equal(await position(page, 'new.srt'), 0)
  })
}
test('obsolete catalog deep-link import cannot replace manual file', { timeout: 20000 }, async t => {
  const gate = deferred()
  const page = await fixture(t, { routes: { [file.url]: gate }, query: '?anime=anime-a&subtitle=catalog-a.srt&line=10000' })
  await gate.requested
  await localImport(page); await loaded(page, 'NEW_START')
  await release(page, gate, file.url); await assertNewReader(page)
  assert.equal(await position(page, 'new.srt'), 0)
})
test('current recent URL resumes its own position', { timeout: 20000 }, async t => {
  const item = recent('current.srt'), page = await fixture(t, { recent: [item] })
  await (await recentButton(page, item.name)).click(); await loaded(page, 'NEW_START')
  assert.equal(await position(page, item.name), 10000)
})
test('current catalog deep link retains its shared position', { timeout: 20000 }, async t => {
  const page = await fixture(t, { query: '?anime=anime-a&subtitle=catalog-a.srt&line=10000' })
  await loaded(page, 'CATALOG_START')
  assert.equal(await position(page, file.name), 10000)
})
test('cancelled local chooser does not donate resume position to later import', { timeout: 20000 }, async t => {
  const item = recent('new.srt', 'local'), page = await fixture(t, { recent: [item] })
  const chooser = page.waitForEvent('filechooser')
  await (await recentButton(page, item.name)).click()
  await chooser
  await page.locator('input.file-input').dispatchEvent('cancel')
  await localImport(page); await loaded(page, 'NEW_START')
  assert.equal(await position(page, 'new.srt'), 0)
})
test('local recent resume only belongs to matching file selection', { timeout: 20000 }, async t => {
  const item = recent('different.srt', 'local'), page = await fixture(t, { recent: [item] })
  const chooser = page.waitForEvent('filechooser')
  await (await recentButton(page, item.name)).click()
  await (await chooser).setFiles({ name: 'new.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(subtitle('NEW')) }); await loaded(page, 'NEW_START')
  assert.equal(await position(page, 'new.srt'), 0)
})
test('matching local recent file retains its own resume position', { timeout: 20000 }, async t => {
  const item = recent('new.srt', 'local'), page = await fixture(t, { recent: [item] })
  const chooser = page.waitForEvent('filechooser')
  await (await recentButton(page, item.name)).click()
  await (await chooser).setFiles({ name: 'new.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(subtitle('NEW')) }); await loaded(page, 'NEW_START')
  assert.equal(await position(page, 'new.srt'), 10000)
})
test('older recent completion cannot clear newer recent loading state', { timeout: 20000 }, async t => {
  const a = recent('first.srt'), b = recent('second.srt'), first = deferred(), second = deferred()
  const page = await fixture(t, { recent: [a, b], routes: { [a.url]: first, [b.url]: second } })
  await (await recentButton(page, a.name)).click(); await first.requested
  await localImport(page); await loaded(page, 'NEW_START')
  await page.getByRole('button', { name: 'Change subtitles', exact: true }).click()
  await (await recentButton(page, b.name)).click(); await second.requested
  await release(page, first, a.url, { status: 500 })
  assert.equal(await (await recentButton(page, b.name)).locator('em').textContent(), 'Opening…')
  assert.equal(await page.locator('.error').count(), 0)
  await release(page, second, b.url, { body: subtitle('NEW') })
  await assertNewReader(page)
  assert.equal(await position(page, b.name), 10000)
})
test('changing anime search invalidates pending catalog content', { timeout: 20000 }, async t => {
  const gate = deferred(), page = await fixture(t, { routes: { [file.url]: gate } })
  await localImport(page); await loaded(page, 'NEW_START')
  await page.getByRole('button', { name: 'Change subtitles', exact: true }).click()
  await page.locator('#anime-search').fill('Fixture')
  await page.getByRole('option').first().click()
  await page.locator('.subtitle-files button').first().click(); await gate.requested
  await page.locator('#anime-search').fill('Different title')
  await release(page, gate, file.url); await assertNewReader(page)
  assert.equal(await page.locator('.subtitle-files small').filter({ hasText: 'Opening…' }).count(), 0)
})
test('queued deep-link callback cannot start after a newer manual import', { timeout: 20000 }, async t => {
  const page = await fixture(t, { query: '?anime=anime-a&subtitle=catalog-a.srt&line=10000', holdDeepLink: true })
  await page.waitForFunction(() => typeof window.releaseDeepLink === 'function')
  await localImport(page); await loaded(page, 'NEW_START')
  const requests = []
  page.on('request', request => { if (request.url() === file.url) requests.push(request.url()) })
  await page.evaluate(() => window.releaseDeepLink()); await drain(page)
  assert.deepEqual(requests, [], 'obsolete callback must not start a new acquisition')
  await assertNewReader(page)
  assert.equal((await page.locator('body').textContent()).includes('CATALOG_START'), false)
})
