import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { existsSync } from 'node:fs'
const prefix='subtitle-companion:', keys={history:prefix+'lookup-history:v1',favorites:prefix+'favorite-words:v1',settings:prefix+'reader-settings:v1',recent:prefix+'recent-activity:v1'};
const lookup={id:'synthetic',sourceName:'fixture.srt',surface:'猫',reading:'ねこ',meaning:'cat',sentence:'猫です',startMs:0,endMs:5000,lookedUpAt:'2026-01-01T00:00:00Z',selected:false};
const recent={id:'local:fixture',name:'fixture.srt',kind:'local',viewedAt:'2026-01-01T00:00:00Z',positionMs:0};
const cases=[{name:'absent storage control'},{name:'valid history favorites recent',seed:{history:[lookup],favorites:[lookup],recent:{subtitles:[recent],searches:[{id:'x',title:'Synthetic anime',viewedAt:'2026-01-01'}]}}},
...['history','favorites'].flatMap(k=>[{name:k+' mixed null',seed:{[k]:[lookup,null]}},{name:k+' object surface',seed:{[k]:[lookup,{...lookup,id:'bad',surface:{bad:true}}]}}]),
{name:'recent subtitle mixed null',seed:{recent:{subtitles:[recent,null],searches:[]}}},
{name:'recent search mixed null',seed:{recent:{subtitles:[],searches:[{id:'x',title:'valid',viewedAt:'2026-01-01T00:00:00Z'},null]}}},
{name:'recent subtitle object name',seed:{recent:{subtitles:[{...recent,name:{bad:true}}],searches:[]}}},
{name:'settings null',seed:{settings:null}},{name:'settings malformed fields',seed:{settings:{furigana:'x',subtitleFontSize:{x:1},density:null,autoResumeDelayMs:[]}}},
{name:'invalid JSON history',raw:{history:'{bad-json'}},
{name:'getItem denied but writes available',seed:{history:[lookup],favorites:[lookup]},getFail:true},
...Object.keys(keys).map(k=>({name:'initial quota '+k,setFail:k,errorName:'QuotaExceededError'})),
{name:'security storage denied',getFail:true,setFail:'all',errorName:'SecurityError'},
{name:'quota only after successful mount',lateFail:true,errorName:'QuotaExceededError'}];

cases.push(
 {name:'legacy history fallback', raw:{legacy:JSON.stringify([lookup])}},
 {name:'invalid legacy blocks new history key',raw:{legacy:JSON.stringify([lookup,null])},blocked:'history'},
 {name:'primary history takes precedence over invalid legacy',seed:{history:[lookup]},raw:{legacy:'bad'}},
 {name:'history read failure leaves healthy favorites working',seed:{history:[lookup],favorites:[lookup]},getFailKey:'history',blocked:'history'},
 {name:'storage property denied',storageDenied:true},
 {name:'serialize failure',seed:{history:[lookup]},serializeFail:true},
 {name:'partial settings numeric strings',seed:{settings:{subtitleFontSize:'26',furiganaOpacity:'150',autoResumeDelayMs:'100'} }},
 {name:'legacy font with partial settings',seed:{settings:{furigana:false}},raw:{font:'30'}},
 {name:'URL settings override',seed:{settings:{subtitleFontSize:18}},query:'?font=26&furigana=25'},
 {name:'invalid optional recent descriptor',seed:{recent:{subtitles:[recent,{...recent,id:'bad',animeTitle:{bad:1}}],searches:[]}},blocked:'recent'},
 {name:'negative lookup time',seed:{history:[lookup,{...lookup,id:'bad',startMs:-1}]},blocked:'history'},
 {name:'settings object coercion trap',seed:{settings:{subtitleFontSize:{valueOf:null,toString:null}}}},
 {name:'all generated recent kinds',seed:{recent:{subtitles:[recent,{...recent,id:'url:x',kind:'url',url:'https://fixture.invalid/a.srt'},{...recent,id:'catalog:x',kind:'catalog',animeId:'x',animeTitle:'Fixture',file:{name:'a.srt',url:'https://fixture.invalid/a.srt',size:10}}],searches:[]}}}
)
keys.legacy=prefix+'saved-lookups:v1';keys.font=prefix+'subtitle-font-size:v1'
let server,browser,origin
before(async()=>{
 server=await createServer({root:process.env.SUBTITLE_TEST_ROOT||process.cwd(),server:{host:'127.0.0.1',port:0},logLevel:'silent'});await server.listen();origin=server.resolvedUrls.local[0]
 const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe'
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync(chrome)?chrome:undefined),headless:true})
})
after(async()=>{await browser?.close();await server?.close()})
async function fixture(t,c){
 const context=await browser.newContext();t.after(()=>context.close())
 await context.addInitScript(({c,keys})=>{
  const get=Storage.prototype.getItem,set=Storage.prototype.setItem,stringify=JSON.stringify
  if(!sessionStorage.fixtureSeeded){for(const[k,v]of Object.entries(c.seed||{}))set.call(localStorage,keys[k],stringify(v));for(const[k,v]of Object.entries(c.raw||{}))set.call(localStorage,keys[k],v);sessionStorage.fixtureSeeded='yes'}
  window.fixtureWrites=[];window.fixtureBefore=Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,get.call(localStorage,v)]));window.fixtureRaw=()=>Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,get.call(localStorage,v)]));window.fixtureFail=false;window.fixtureRecovered=false
  Storage.prototype.getItem=function(k){if(c.getFail||keys[c.getFailKey]===k)throw new DOMException('synthetic read denied','SecurityError');return get.call(this,k)}
  Storage.prototype.setItem=function(k,v){window.fixtureWrites.push({key:k,value:v});if(!window.fixtureRecovered&&(c.setFail==='all'||keys[c.setFail]===k||window.fixtureFail))throw new DOMException('synthetic write denied',c.errorName);return set.call(this,k,v)}
  if(c.storageDenied)Object.defineProperty(window,'localStorage',{get(){throw new DOMException('synthetic property denied','SecurityError')}})
  if(c.serializeFail)JSON.stringify=function(v,...args){if(Array.isArray(v)&&v[0]?.id==='synthetic')throw Error('synthetic serialization failure');return stringify(v,...args)}
 },{c,keys})
 await context.route('**/*',route=>{const u=route.request().url();if(u.includes('/kuromoji/'))return route.fulfill({status:404,body:''});if(u.endsWith('/subtitle-catalog.json'))return route.fulfill({contentType:'application/json',body:'{"entries":[]}'});if(u.includes('/dictionaries/'))return route.fulfill({contentType:'application/json',body:'{"entryCount":0,"buckets":{}}'});if(u.startsWith(origin))return route.continue();return route.abort()})
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[],'reader errors'))
 await page.goto(origin+(c.query||''),{waitUntil:'networkidle'});return page
}
async function imported(page,name='synthetic.srt'){
 if(await page.getByRole('button',{name:'Change subtitles',exact:true}).count())await page.getByRole('button',{name:'Change subtitles',exact:true}).click()
 await page.locator('input.file-input:not(.video-input)').setInputFiles({name,mimeType:'application/x-subrip',buffer:Buffer.from('1\n00:00:00,000 --> 00:00:05,000\nSYNTHETIC_READER\n')})
 await page.waitForFunction(name=>document.querySelector('#reader-title')?.textContent===name,name,{timeout:2500})
 await page.getByText('SYNTHETIC_READER',{exact:true}).first().waitFor({state:'attached',timeout:2500})
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
}
for(const c of cases)test(c.name,{timeout:12000},async t=>{
 const page=await fixture(t,c)
 assert.ok(await page.locator('input.file-input:not(.video-input)').count(),'reader mounted')
 if(c.name==='recent search mixed null')assert.equal(await page.locator('.recent-search').innerText(),'valid')
 if(c.name==='recent subtitle mixed null')assert.equal(await page.locator('.recent-subtitle-open strong').innerText(),'fixture.srt')
 if(c.name==='history mixed null')assert.ok((await page.locator('.saved-list').first().innerText()).includes('猫'))
 if(c.name==='favorites mixed null')assert.ok((await page.locator('.favorite-list').innerText()).includes('猫'))
 if(c.lateFail)await page.evaluate(()=>window.fixtureFail=true)
 await imported(page)
 assert.ok((await page.locator('#root').innerText()).includes('SYNTHETIC_READER'))
 const noticeElement=page.locator('[aria-label="Saving status"]');const notices=await noticeElement.count()?await noticeElement.innerText():''
 const blocked=c.blocked||(c.name.startsWith('history ')&&c.name!=='history read failure leaves healthy favorites working'?'history':c.name.startsWith('favorites ')?'favorites':c.name.startsWith('recent ')?'recent':c.name.startsWith('settings ')?'settings':c.name==='invalid JSON history'?'history':null)
 if(blocked||c.getFail||c.getFailKey||c.storageDenied)assert.ok(notices.includes('Stored data was left unchanged'))
 if(c.setFail&&!c.getFail||c.lateFail||c.serializeFail)assert.ok(notices.includes('could not be saved'))
 if(!c.storageDenied){
  // Exercise actual state changes in protected collections before checking preservation.
  if(blocked==='history' && await page.getByRole('button',{name:'Export…',exact:true}).isEnabled()) {
   await page.getByRole('button',{name:'Export…',exact:true}).click();await page.locator('.saved-list input[type=checkbox]').first().check()
  }
  if(blocked==='favorites' && await page.locator('.favorite-list button[aria-label^="Remove"]').count())await page.locator('.favorite-list button[aria-label^="Remove"]').first().click()
  if(blocked==='settings'){await page.locator('.reader-preferences summary').click();await page.locator('.reader-preferences select').first().selectOption('30')}
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const state=await page.evaluate(()=>({before:window.fixtureBefore,after:window.fixtureRaw(),writes:window.fixtureWrites}))
  const protectedKeys=c.getFail?['history','favorites','settings','recent']:blocked?[blocked]:[]
  for(const k of protectedKeys){assert.equal(state.after[k],state.before[k],k+' raw data preserved');assert.equal(state.writes.some(w=>w.key===keys[k]),false,k+' received no write')}
  if(blocked==='history')assert.ok(state.writes.some(w=>w.key===keys.recent),'healthy recent key saved')
  if(c.name==='legacy history fallback')assert.deepEqual(JSON.parse(state.after.history),[lookup])
  if(c.name==='primary history takes precedence over invalid legacy')assert.deepEqual(JSON.parse(state.after.history),[lookup])
  if(c.name==='partial settings numeric strings')assert.deepEqual([JSON.parse(state.after.settings).subtitleFontSize,JSON.parse(state.after.settings).furiganaOpacity,JSON.parse(state.after.settings).autoResumeDelayMs],[26,100,500])
  if(c.name==='legacy font with partial settings')assert.equal(JSON.parse(state.after.settings).subtitleFontSize,30)
  if(c.name==='URL settings override')assert.equal(JSON.parse(state.after.settings).subtitleFontSize,26)
  if(c.name==='absent storage control')for(const k of ['history','favorites','settings'])assert.equal(state.writes.filter(w=>w.key===keys[k]).length,1,'no duplicate mount save '+k)
 }
 if(c.name==='valid history favorites recent'){
  await page.reload({waitUntil:'networkidle'}) // preserve stored records across a fresh mount
  const stored=await page.evaluate(()=>window.fixtureRaw());assert.deepEqual(JSON.parse(stored.history),[lookup]);assert.deepEqual(JSON.parse(stored.favorites),[lookup]);await imported(page,'second.srt')
 }
 if(c.lateFail){await page.evaluate(()=>{window.fixtureRecovered=true;window.fixtureFail=false});await imported(page,'retry.srt');assert.equal(await page.locator('[aria-label="Saving status"]').count(),0);const stored=await page.evaluate(()=>window.fixtureRaw());assert.equal(JSON.parse(stored.recent).subtitles[0].name,'retry.srt')}
})
