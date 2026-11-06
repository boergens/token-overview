// Browser QA with an isolated Chrome profile and a loopback-only fixture server.
// No credentials, provider traffic, or third-party dependencies. The fixture serves a live feed
// for Claude (5-hour + weekly windows) and ChatGPT (weekly only); Gemini stays manual.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { secure } from '../worker.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp('/tmp/allowance-chrome-');
const browser = spawn(process.env.CHROME_BIN || '/opt/google/chrome/chrome', [
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--disable-background-networking', '--disable-component-update', '--disable-extensions',
  '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
], { stdio:['ignore','ignore','pipe','pipe','pipe'] });
let nextId = 0, buffer = '', stderr = '', session;
const pending = new Map(), errors = [], blocked = [];
browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
browser.stdio[3].on('error', () => {});
browser.stdio[4].on('error', () => {});
browser.on('exit', code => { for (const p of pending.values()) p.reject(new Error(`Chrome exited (${code}). ${stderr}`)); pending.clear(); });
function send(method, params = {}, sessionId = session) {
  const id = ++nextId;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 60000);
    pending.set(id, { resolve:r => {clearTimeout(timer);resolve(r);}, reject:e => {clearTimeout(timer);reject(e);} });
    browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})+'\0');
  });
}
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
    if (message.id) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (p) message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
    } else handle(message).catch(error => { errors.push(error.message); console.error('Browser interception:', error.message); });
  }
});
async function handle(message) {
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
  if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && !message.params.request.url.startsWith(origin + '/')) blocked.push(message.params.request.url);
}
const hours = n => new Date(Date.now() + n * 3600000).toISOString();
let chatgptMode = 'weekly-used-up', claudeExtra = { enabled:true, usedCredits:5519, monthlyLimit:null, currency:'USD', decimalPlaces:2, spendLimitReached:false };
const plannedRow = (extra={}) => ({ id:'api-plan', label:'API credits from your plan', value:'$200 a month', detail:'Balance shows only in the Console.', state:'unknown', source:'checked', checkedAt:'2026-11-06', renewsAt:hours(120), url:'https://platform.claude.com/settings/billing', ...extra });
const chatgptFixture = () => chatgptMode === 'weekly-used-up'
  ? { status:'ok', plan:'promax', source:'Codex sign-in', windows:[ { id:'primary', label:'Weekly window', kind:'weekly', usedPercent:100, windowMinutes:10080, resetsAt:hours(120) } ],
      credits:[ plannedRow({ url:'https://chatgpt.com/settings/billing' }) ], models:[ { id:'gpt-6-astra', name:'GPT-6 Astra', available:true, availableAt:null, creditsWouldEnable:false } ] }
  : { status:'ok', plan:'promax', source:'Codex sign-in', windows:[ { id:'primary', label:'Weekly window', kind:'weekly', usedPercent:77, windowMinutes:10080, resetsAt:hours(120) },
        { id:'model:gpt-6-astra', label:'GPT-6 Astra', kind:'weekly', usedPercent:100, resetsAt:hours(30), model:'GPT-6 Astra', gate:true } ],
      credits:[ { id:'chatgpt-credits', label:'ChatGPT credits', value:'0 credits', detail:'', state:'empty', source:'live' }, plannedRow({ url:'https://chatgpt.com/settings/billing' }) ], models:[ { id:'gpt-6-astra', name:'GPT-6 Astra', available:false, availableAt:hours(30), creditsWouldEnable:true }, { id:'gpt-6-sol', name:'GPT-6 Sol', available:true, availableAt:null, creditsWouldEnable:false } ] };
const liveFixture = () => ({ status:'ok', version:1, collectedAt:new Date(Date.now() - 120000).toISOString(), collector:'fixture', providers:{
  claude:{ status:'ok', plan:'max', source:'Claude Code sign-in', extra:claudeExtra, forecast:{ status:'ok', days:18, out:[], unknown:[], pNone:0.6, first:{ id:'seven_day', label:'Weekly · all models', p:0.4 }, race:[ { id:'seven_day', label:'Weekly · all <b>models</b>', kind:'weekly', p:0.4, pFirst:0.4, endMedian:90, medianAt:hours(60), earlyAt:hours(20), lateAt:hours(70) } ] }, credits:[ { id:'usage-credits', label:'Usage credits', value:'Out of credits', detail:'$47.84 used so far.', state:'empty', source:'live', url:'https://claude.ai/settings/billing' }, plannedRow() ], windows:[
    { id:'five_hour', label:'5-hour window', kind:'current', usedPercent:23, resetsAt:hours(3) },
    { id:'seven_day', label:'Weekly · all models', kind:'weekly', usedPercent:12, resetsAt:hours(72) },
    { id:'seven_day_opus', label:'Weekly · Opus', kind:'weekly', usedPercent:5, resetsAt:hours(72), model:'Opus' },
    { id:'limit:weekly_scoped_fable', label:'Weekly · Fable', kind:'weekly', usedPercent:100, resetsAt:hours(72), model:'Fable' } ],
    breakdown:{ windowStartedAt:hours(-48), rows:[ { name:'Claude Code', percent:84 }, { name:'Cowork', percent:10 }, { name:'Chats', percent:6 }, { name:'Other', percent:0 } ] } },
  chatgpt:{ ...chatgptFixture(), forecast:{ status:'thin', hours:20 } },
  gemini:{ status:'not_connected', message:'Gemini is not connected yet.', credits:[ plannedRow({ label:'Gen AI <b>& Cloud</b> credits', state:'warn', renewsAt:'2020-01-01', url:'javascript:alert(1)' }) ] },
} });
const server = createServer(async (request, reply) => {
  try {
    const url = new URL(request.url, origin);
    let response;
    if (url.pathname === '/api/session') response = secure(Response.json({mode:'local-preview'}));
    else if (url.pathname === '/api/live') response = secure(Response.json(liveFixture()));
    else {
      const path = resolve(root+'public', '.'+(url.pathname === '/' ? '/index.html' : url.pathname));
      assert.ok(path.startsWith(root+'public/'));
      const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
      response = secure(new Response(await readFile(path), {headers:{'Content-Type':types[extname(path)] || 'text/plain'}}));
    }
    reply.writeHead(response.status, Object.fromEntries(response.headers));
    reply.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { errors.push(error.message); reply.writeHead(500); reply.end('Fixture failed'); }
});
await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for (let n=0;n<100;n++) {
    if (await evaluate(expression)) return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error(`Not ready: ${expression}`);
}
const card = id => `document.querySelector('#provider-cards [data-provider=${id}]')`;
const shot = async name => writeFile(root+`artifacts/${name}.png`, Buffer.from((await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})).data,'base64'));
try {
  const target = await send('Target.createTarget', {url:'about:blank'}, null);
  session = (await send('Target.attachToTarget', {targetId:target.targetId,flatten:true}, null)).sessionId;
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:origin+'/'});
  await waitFor("document.querySelector('#provider-cards [data-mode=live]')");
  await mkdir(root+'artifacts',{recursive:true});
  // Claude: live; the used-up weekly Fable cap is the limiting window, and the card says it blocks only Fable.
  assert.equal(await evaluate("document.querySelectorAll('#provider-cards .provider-card').length"),3);
  assert.equal(await evaluate(`${card('claude')}.dataset.mode`),'live');
  assert.equal(await evaluate(`${card('claude')}.querySelector('.gauge-number').textContent`),'0%');
  assert.match(await evaluate(`${card('claude')}.querySelector('.scope').textContent`),/Weekly · Fable · limiting window/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.status-tag').textContent`),/^Fable limit reached/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.card-note').textContent`),/applies only to Fable; everything else still has 77% left \(5-hour window\)\. Extra usage is on, so Fable requests/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.card-breakdown').textContent`),/Claude Code 84% · Cowork 10% · Chats 6%$/);
  // Forecast: plain wording, rounded odds, feed text treated as data, and an honest note when history is thin.
  assert.match(await evaluate(`${card('claude')}.querySelector('[data-forecast] strong').textContent`),/Weekly · all <b>models<\/b> could run out before it resets \(about 40%\)/);
  assert.equal(await evaluate(`${card('claude')}.querySelector('[data-forecast] strong b')`),null);
  assert.match(await evaluate(`${card('claude')}.querySelector('[data-forecast]').textContent`),/If it does, around .*18 days of your usage/);
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('[data-forecast]').textContent`),/Not enough history to forecast yet.*20 hours logged/);
  assert.equal(await evaluate(`${card('gemini')}.querySelector('[data-forecast]')`),null);
  // Under the used-up Fable gauge: what is left for Opus 5.5, ahead of the detail rows.
  assert.equal(await evaluate(`${card('claude')}.querySelector('.fallback-text strong').textContent`),'Opus 5.5');
  assert.equal(await evaluate(`${card('claude')}.querySelector('.fallback-ring span').textContent`),'77%');
  assert.match(await evaluate(`${card('claude')}.querySelector('.fallback-text').textContent`),/77% left · 23% used.*5-hour window · resets in 3h/);
  assert.equal(await evaluate(`${card('claude')}.querySelector('.scope').nextElementSibling.matches('.fallback')`),true);
  assert.equal(await evaluate(`${card('claude')}.querySelector('.fallback').nextElementSibling.matches('.card-detail')`),true);
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.fallback')`),null);
  assert.equal(await evaluate(`${card('gemini')}.querySelector('.fallback')`),null);
  assert.match(await evaluate(`${card('claude')}.querySelector('.card-title p').textContent`),/Max plan/);
  assert.equal(await evaluate(`${card('claude')}.querySelector('[data-edit]')`),null);
  assert.match(await evaluate(`${card('claude')}.querySelector('.extra-windows').textContent`),/Opus.*95% left/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.extra-windows').textContent`),/Extra usage.*55\.19/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.extra-windows .binding').textContent`),/Weekly · Fable · limiting.*0% left/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.extra-windows').textContent`),/5-hour window.*77% left · 23% used · resets/);
  assert.equal(await evaluate(`${card('claude')}.querySelector('.gauge-label').textContent`),'left · 100% used');
  // ChatGPT: its only window is used up, so the card says so instead of showing a fresh number.
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.gauge-number').textContent`),'0%');
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('.status-tag').textContent`),/^Limit reached/);
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('.card-note').textContent`),/used up and resets in 5d.*other windows don’t matter/);
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.card-breakdown')`),null);
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('[data-edit]')`),null);
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('.extra-windows').textContent`),/GPT-6 Astra.*available now/);
  // Gemini: not connected, manual entry offered.
  assert.equal(await evaluate("document.querySelectorAll('#provider-cards .gauge-number.unknown').length"),1);
  assert.match(await evaluate("document.querySelector('#reading-count').textContent"),/2 live · 0 manual/);
  assert.match(await evaluate("document.querySelector('#notice').textContent"),/Live: Claude, ChatGPT.*Manual: Gemini/);
  assert.match(await evaluate(`${card('gemini')}.querySelector('.card-note').textContent`),/not connected/);
  assert.equal(await evaluate("document.querySelectorAll('#reset-list .reset-item').length"),5);
  await shot('desktop');
  // ChatGPT: Astra blocked until a known time while the general weekly window still has room.
  chatgptMode = 'astra-blocked';
  const onExtra = claudeExtra;
  claudeExtra = { ...claudeExtra, enabled:false, disabledReason:'out_of_credits' };
  await evaluate("document.querySelector('#refresh-live').click()");
  await waitFor(`${card('chatgpt')}.querySelector('.status-tag').textContent.startsWith('GPT-6 Astra blocked')`);
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.gauge-number').textContent`),'0%');
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('.card-note').textContent`),/GPT-6 Astra is blocked and reopens in 1d [56]h\. It applies only to GPT-6 Astra; everything else still has 23% left \(Weekly window\)\. Credits would unlock it before then\./);
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('.extra-windows').textContent`),/Weekly window.*23% left · 77% used.*GPT-6 Astra · limiting.*blocked · reopens.*GPT-6 Sol.*available now/);
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.gauge-label').textContent`),'blocked');
  assert.equal(await evaluate(`${card('chatgpt')}.innerText.includes('100% used')`),false);
  assert.equal(await evaluate("document.querySelector('#reset-list').innerText.includes('100% used · ')"),false);
  assert.equal(await evaluate("document.querySelectorAll('#reset-list .reset-item').length"),6);
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.fallback-text strong').textContent`),'Other models');
  assert.equal(await evaluate(`${card('chatgpt')}.querySelector('.fallback-ring span').textContent`),'23%');
  // Claude: extra usage that ran out stays visible, and the note no longer claims requests go through.
  assert.match(await evaluate(`${card('claude')}.querySelector('.extra-windows').textContent`),/Extra usage.*out of credits · \$55\.19 used/);
  assert.match(await evaluate(`${card('claude')}.querySelector('.card-note').textContent`),/Extra usage is out of credits, so Fable requests stop until the limit resets or you buy more\./);
  assert.equal(await evaluate(`${card('claude')}.querySelector('.card-note').textContent.includes('Extra usage is on')`),false);
  await shot('astra');
  // Manual readings still work for anything without a live figure, and persist across reloads.
  await evaluate("document.querySelector('[data-edit=gemini]').click(); document.querySelector('#remaining').value='72'; document.querySelector('#scope').value='Gemini app'; document.querySelector('#reading-form').requestSubmit();");
  assert.equal(await evaluate("document.querySelector('#reading-dialog').open"),false);
  assert.match(await evaluate(`${card('gemini')}.innerText`),/72/);
  assert.match(await evaluate("document.querySelector('#reading-count').textContent"),/2 live · 1 manual/);
  await send('Page.reload');
  await waitFor(`${card('gemini')}?.querySelector('.gauge-number')?.textContent.includes('72')`);
  await waitFor("document.querySelector('#provider-cards [data-mode=live]')");
  assert.equal(await evaluate(`${card('claude')}.querySelector('.gauge-number').textContent`),'0%');
  // A second manual window: the lower one becomes the gauge, both are listed.
  await evaluate("document.querySelector('[data-edit=gemini]').click(); document.querySelector('#window').value='weekly'; document.querySelector('#window').dispatchEvent(new Event('change')); document.querySelector('#unit').value='tokens'; document.querySelector('#unit').dispatchEvent(new Event('change')); document.querySelector('#remaining').value='12345'; document.querySelector('#total').value='20000'; document.querySelector('#reading-form').requestSubmit();");
  assert.match(await evaluate(`${card('gemini')}.querySelector('.gauge-number').textContent`),/12,345/);
  assert.match(await evaluate(`${card('gemini')}.querySelector('.extra-windows').textContent`),/Gemini app.*72% left/);
  await evaluate("document.querySelector('[data-edit=gemini]').click(); document.querySelector('#window').value='current'; document.querySelector('#window').dispatchEvent(new Event('change')); document.querySelector('#remaining').value='0'; document.querySelector('#reading-form').requestSubmit();");
  assert.equal(await evaluate(`${card('gemini')}.querySelector('.gauge-number').textContent`),'0%');
  assert.match(await evaluate(`${card('gemini')}.querySelector('.status-tag').textContent`),/Limit reached/);
  assert.equal(await evaluate("document.querySelectorAll('#provider-cards .gauge-number.unknown').length"),0);
  // Nothing in a window line may be clipped by the card, at the narrowest three-column width or on a phone.
  const clipped = "[...document.querySelectorAll('#provider-cards .extra-windows>span,#provider-cards .fallback,#provider-cards .forecast')].filter(s=>s.scrollWidth>s.clientWidth+1||s.getBoundingClientRect().right>s.closest('.provider-card').getBoundingClientRect().right).length";
  await send('Emulation.setDeviceMetricsOverride',{width:950,height:1080,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate(clipped),0);
  await shot('narrow');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  assert.equal(await evaluate(clipped),0);
  await shot('mobile');
  await evaluate("document.querySelector('[data-edit=gemini]').click(); document.querySelector('#remove-reading').click()");
  assert.match(await evaluate(`${card('gemini')}.querySelector('.gauge-number').textContent`),/12,345/);
  await evaluate("document.querySelector('[data-edit=gemini]').click(); document.querySelector('#window').value='weekly'; document.querySelector('#window').dispatchEvent(new Event('change')); document.querySelector('#remove-reading').click()");
  assert.equal(await evaluate("document.querySelectorAll('#provider-cards .gauge-number.unknown').length"),1);
  // Developer APIs view: manual balances and budgets, independent of chat readings.
  await evaluate("document.querySelector('[data-view=api]').click()");
  assert.equal(await evaluate("document.querySelector('#chat-section').hidden"),true);
  // Credits overview: one group per provider, live and hand-checked rows told apart, feed content treated as data.
  const group = id => `document.querySelector('[data-credits=${id}]')`;
  assert.equal(await evaluate("document.querySelectorAll('#credit-overview .credit-group').length"),3);
  assert.equal(await evaluate(`${group('claude')}.querySelectorAll('.credit-row').length`),2);
  assert.match(await evaluate(`${group('claude')}.querySelector('.credit-row.empty').innerText`),/Usage credits[\s\S]*Out of credits[\s\S]*Live · /);
  assert.match(await evaluate(`${group('claude')}.querySelector('.credit-row.unknown').innerText`),/\$200 a month[\s\S]*Checked Nov 6[\s\S]*Next credit/);
  assert.equal(await evaluate(`${group('gemini')}.querySelector('.credit-line b')`),null);
  assert.match(await evaluate(`${group('gemini')}.querySelector('.credit-line').textContent`),/Gen AI <b>& Cloud<\/b> credits/);
  assert.equal(await evaluate(`${group('gemini')}.querySelector('a')`),null);
  assert.match(await evaluate(`${group('gemini')}.innerText`),/has passed, re-check/);
  await evaluate(`${group('gemini')}.querySelector('[data-api-edit=gemini]').click()`);
  assert.equal(await evaluate("document.querySelector('#reading-dialog').open"),true);
  assert.deepEqual(await evaluate("[document.querySelector('#provider').value, document.querySelector('#account-type').value]"),['gemini','api']);
  await evaluate("document.querySelector('#reading-dialog').close()");
  assert.equal(await evaluate("document.querySelectorAll('#api-cards .gauge-number.unknown').length"),3);
  await evaluate("document.querySelector('[data-api-edit=chatgpt]').click(); document.querySelector('#unit').value='usd'; document.querySelector('#unit').dispatchEvent(new Event('change')); document.querySelector('#remaining').value='12.5'; document.querySelector('#reading-form').requestSubmit();");
  assert.equal(await evaluate("document.querySelector('#reading-dialog').open"),false);
  assert.match(await evaluate("document.querySelectorAll('#api-cards .gauge-number')[1].textContent"),/12.5/);
  assert.match(await evaluate(`${group('chatgpt')}.querySelector('.credit-balance').textContent`),/You recorded \$12\.5, just now/);
  await shot('credits-mobile');
  assert.match(await evaluate(`${card('chatgpt')}.querySelector('.status-tag').textContent`),/^GPT-6 Astra blocked/);
  await evaluate("document.querySelector('[data-budget=claude]').click(); document.querySelector('#budget-tokens').value='100000'; document.querySelector('#budget-form').requestSubmit();");
  assert.equal(await evaluate("document.querySelector('#budget-dialog').open"),false);
  assert.equal(await evaluate("document.querySelector('#api-cards .gauge-number').textContent"),'—');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await shot('api-mobile');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await shot('api-desktop');
  assert.deepEqual(errors,[]);
  assert.deepEqual(blocked,[]);
  console.log('Browser checks passed: forecast, credits overview, out-of-credits state, live cards (most limiting window, model-scoped Fable cap, blocked GPT-6 Astra, per-surface shares, listed windows, exhausted limit, plan label, extra usage), manual fallback, reload persistence, units, zero balance, remove, separate API balances, disconnected budgets, mobile layout, and strict CSP. Screenshots in artifacts/.');
} finally {
  server.closeAllConnections(); server.close();
  browser.kill('SIGTERM');
  await new Promise(r=>setTimeout(r,250));
  await rm(profile,{recursive:true,force:true});
}
