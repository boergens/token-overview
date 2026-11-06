import { PROVIDERS, STORAGE_KEY, emptyState, validateState, readingStatus, percentage, countdown, trackingBudgetLeft, liveProvider, liveStatus, liveWindows, planLabel, bindingReading, usedPercent, creditRows, fallbackReading, forecastView } from './model.js';
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const amountLeft = r => r.gate ? 'blocked' : r.unit === 'percent' ? `${number(r.remaining)}% left · ${number(usedPercent(r))}% used` : `${number(r.remaining)} ${r.unit} left`;
let state = emptyState(), storageKey, storageAvailable = true, dataCorrupt = false, ready = false;
let pendingImport, toastTimer;
let activeView = 'chat', localPreview = false, apiLoading = false, apiLoaded = false;
let apiReports = {};
let live = null, liveLoading = false, liveError = '';

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function elapsed(iso) {
  if (!iso) return 'Never';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (minutes === 0) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function setNotice(title, message, error = false) {
  $('#notice').classList.toggle('error', error);
  $('#notice').innerHTML = `<span class="notice-icon" aria-hidden="true">ⓘ</span><div><strong>${escape(title)}</strong><span>${escape(message)}</span></div>`;
}

function feedNotice() {
  const feed = liveStatus(live);
  if (feed === 'unknown') {
    setNotice('Live feed not connected.', liveError || live?.message || 'No readings have arrived from the collector yet. Readings you add by hand are shown as snapshots.', Boolean(liveError));
    return;
  }
  const connected = PROVIDERS.filter(p => liveProvider(live, p.id)?.status === 'ok').map(p => p.name);
  const rest = PROVIDERS.filter(p => liveProvider(live, p.id)?.status !== 'ok').map(p => p.name);
  const when = `Feed updated ${elapsed(live.collectedAt).toLowerCase()}${live.collector ? ' by ' + live.collector : ''}.`;
  setNotice(feed === 'stale' ? 'Live feed is stale.' : 'Live where connected.', `${connected.length ? 'Live: ' + connected.join(', ') + '. ' : ''}${rest.length ? 'Manual: ' + rest.join(', ') + '. ' : ''}${when}`, feed === 'stale');
}

function windowName(window) { return window === 'weekly' ? 'Weekly allowance' : 'Current allowance'; }

function extraUsageLine(extra) {
  if (!extra || typeof extra !== 'object' || (!extra.enabled && !extra.disabledReason)) return null;
  const places = Number.isInteger(extra.decimalPlaces) ? extra.decimalPlaces : 2;
  const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: typeof extra.currency === 'string' && /^[A-Z]{3}$/.test(extra.currency) ? extra.currency : 'USD' }).format(value / 10 ** places) : null;
  const used = money(extra.usedCredits), limit = money(extra.monthlyLimit);
  if (!extra.enabled) return { label: 'Extra usage', value: `${extra.disabledReason === 'out_of_credits' ? 'out of credits' : 'off'}${used ? ' · ' + used + ' used' : ''}` };
  const value = used ? `${used} used${limit ? ' of ' + limit : ''}` : limit ? `limit ${limit}` : 'on';
  return { label: extra.spendLimitReached ? 'Extra usage (limit reached)' : 'Extra usage', value };
}

function afterLimit(extra, what) {
  if (!extra) return '';
  if (extra.enabled) return ` Extra usage is on, so ${what} still go through at pay-as-you-go rates.`;
  return extra.disabledReason === 'out_of_credits' ? ` Extra usage is out of credits, so ${what} stop until the limit resets or you buy more.` : '';
}

function render() {
  let liveCount = 0, manualCount = 0;
  const feed = liveStatus(live), feedAge = live?.collectedAt ? elapsed(live.collectedAt).toLowerCase() : '';
  $('#provider-cards').innerHTML = PROVIDERS.map(p => {
    const data = state.providers[p.id], provider = liveProvider(live, p.id);
    const liveList = [...liveWindows(live, p.id, 'current'), ...liveWindows(live, p.id, 'weekly')];
    const isLive = liveList.length > 0;
    const manualAll = ['current', 'weekly'].filter(w => data.windows[w]).map(w => ({ ...data.windows[w], kind: w }));
    const readings = isLive ? liveList : manualAll.filter(r => readingStatus(r) !== 'expired');
    const reading = bindingReading(readings);
    const status = isLive ? feed : reading ? readingStatus(reading) : manualAll.length ? 'expired' : 'unknown';
    const known = Boolean(reading);
    if (known) { if (isLive) liveCount++; else manualCount++; }
    const pct = known ? percentage(reading) : null;
    const exhausted = pct !== null && pct <= 0;
    // A model- or surface-scoped limit (e.g. Max's weekly Fable limit) blocks only that model or surface.
    const scopeOf = r => r ? r.model || r.surface || null : null;
    const bindingScope = scopeOf(reading), general = bindingScope ? bindingReading(readings.filter(r => !scopeOf(r))) : null;
    const labels = { unknown: 'No reading yet', recorded: 'Manual snapshot', stale: 'Older than 1 hour', expired: 'New reading needed' };
    let tagClass = isLive ? (status === 'stale' ? 'stale' : 'live') : status;
    let tagText = isLive ? (status === 'stale' ? `Live · feed stale (${feedAge})` : `Live · ${feedAge}`) : labels[status];
    if (exhausted) { tagClass = 'limit'; tagText = `${reading.gate ? escape(bindingScope) + ' blocked' : (bindingScope ? escape(bindingScope) + ' limit' : 'Limit') + ' reached'}${isLive ? ' · ' + feedAge : ''}`; }
    const display = known ? number(reading.remaining) : '—';
    const unitLabel = !known ? (status === 'expired' ? 'reset time passed' : 'allowance unknown') : reading.gate ? 'blocked' : reading.unit === 'percent' ? `% of allowance left, ${number(usedPercent(reading))}% used` : `${reading.unit} left`;
    const ring = pct === null ? '' : `<circle class="gauge-progress ${pct <= 20 ? 'low' : ''}" cx="100" cy="100" r="83" pathLength="100" stroke-dasharray="${pct} 100"/>`;
    const plan = data.plan || planLabel(provider?.plan) || p.company;
    const windowName = r => r.scope || (r.kind === 'weekly' ? 'Weekly' : 'Current window');
    const fallback = isLive ? fallbackReading(readings, reading, p.fallbackModel) : null;
    const fallbackPct = fallback ? percentage(fallback) : null;
    const fallbackBlock = fallback ? `<div class="fallback" data-fallback><div class="fallback-ring ${p.color}" aria-hidden="true"><svg viewBox="0 0 200 200"><circle class="gauge-track" cx="100" cy="100" r="83" pathLength="100"/><circle class="gauge-progress ${fallbackPct <= 20 ? 'low' : ''}" cx="100" cy="100" r="83" pathLength="100" stroke-dasharray="${fallbackPct} 100"/></svg><span>${number(fallback.remaining)}<small>%</small></span></div><div class="fallback-text"><strong>${escape(p.fallbackModel || 'Other models')}</strong><span>${escape(amountLeft(fallback))}</span><span>${escape(windowName(fallback))} · resets ${countdown(fallback.resetsAt).toLowerCase()}</span></div></div>` : '';
    const outlook = provider ? forecastView(provider.forecast) : null;
    const outlookBlock = outlook ? `<div class="forecast ${outlook.tone}" data-forecast><span class="forecast-label">Forecast</span><strong>${escape(outlook.headline)}</strong>${outlook.detail ? `<p>${escape(outlook.detail)}</p>` : ''}${outlook.basis ? `<small>${escape(outlook.basis)}</small>` : ''}</div>` : '';
    const lines = readings.length > 1 ? readings.map(r => [windowName(r), `${amountLeft(r)} · ${r.gate ? 'reopens' : 'resets'} ${countdown(r.resetsAt).toLowerCase()}`, r === reading]) : [];
    const extraUsage = isLive ? extraUsageLine(provider.extra) : null;
    if (extraUsage) lines.push([extraUsage.label, extraUsage.value, false]);
    // Per-model availability (ChatGPT's model_usage); blocked models with a reopen time are already windows above.
    const models = isLive && Array.isArray(provider.models) ? provider.models.filter(m => m && typeof m.name === 'string' && m.name.trim() && typeof m.available === 'boolean') : [];
    for (const m of models) if (!readings.some(r => r.model === m.name.trim().slice(0, 40))) lines.push([m.name, m.available ? 'available now' : `not available${m.creditsWouldEnable ? ' · credits would unlock it' : ''}`, false]);
    const gate = models.find(m => m.name.trim().slice(0, 40) === bindingScope);
    const shares = isLive && Array.isArray(provider.breakdown?.rows) ? provider.breakdown.rows.filter(r => r && typeof r.name === 'string' && typeof r.percent === 'number' && Number.isFinite(r.percent) && r.percent > 0) : [];
    const breakdown = shares.length ? `<p class="card-breakdown"><span>This week’s use by surface:</span> ${shares.map(r => `${escape(r.name)} ${number(r.percent)}%`).join(' · ')}</p>` : '';
    const elsewhere = general ? `; everything else still has ${number(general.remaining)}% left (${escape(windowName(general))})` : '';
    let note;
    if (isLive && exhausted && bindingScope) note = `${escape(windowName(reading))} ${reading.gate ? 'is blocked and reopens' : 'is used up and resets'} ${countdown(reading.resetsAt).toLowerCase()}. It applies only to ${escape(bindingScope)}${elsewhere}.${gate?.creditsWouldEnable ? ' Credits would unlock it before then.' : ''}${afterLimit(provider.extra, `${escape(bindingScope)} requests`)}`;
    else if (isLive && exhausted) note = `${escape(windowName(reading))} is used up and resets ${countdown(reading.resetsAt).toLowerCase()}; the other windows don’t matter until then.${afterLimit(provider.extra, 'requests')}`;
    else if (isLive) note = `Live from the ${escape(provider.source || 'collector')}. ${readings.length > 1 ? 'The gauge shows the most limiting of the windows listed above.' : 'The provider’s own figure for its only reported window.'}${bindingScope ? ` That limit applies only to ${escape(bindingScope)}${elsewhere}.` : ''}`;
    else if (provider && provider.status === 'ok') note = 'The live source reports no windows for this plan. You can record one by hand.';
    else if (provider && provider.message) note = escape(provider.message);
    else note = 'No live source connected. Readings here are entered by hand.';
    return `<article class="provider-card" aria-labelledby="${p.id}-title" data-provider="${p.id}" data-mode="${isLive ? 'live' : 'manual'}">
      <div class="card-body"><div class="card-top"><div class="provider-mark ${p.color}" aria-hidden="true">${p.icon}</div><div class="card-title"><h3 id="${p.id}-title">${p.name}</h3><p title="${escape(plan)}">${escape(plan)}</p></div><a class="card-menu" href="${p.url}" target="_blank" rel="noopener noreferrer" aria-label="Open ${p.name} usage page">↗</a></div>
      <div class="status-line"><span class="status-tag ${tagClass}">${tagText}</span></div>
      <div class="gauge-wrap ${p.color}" aria-label="${p.name}: ${known && !reading.gate ? `${display} ${unitLabel}` : unitLabel}"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="gauge-track ${pct === null ? 'empty' : ''}" cx="100" cy="100" r="83" pathLength="100"/>${ring}</svg><div class="gauge-value"><div class="gauge-number ${!known ? 'unknown' : display.length > 6 ? 'long' : ''}">${display}${known && reading.unit === 'percent' ? '<small>%</small>' : ''}</div><div class="gauge-label">${known && reading.unit === 'percent' && !reading.gate ? `left · ${number(usedPercent(reading))}% used` : unitLabel}</div></div></div>
      <p class="scope" title="${known ? escape(windowName(reading)) : ''}">${known ? escape(windowName(reading)) + (readings.length > 1 ? ' · limiting window' : '') : ''}</p>
      ${fallbackBlock}
      <div class="card-detail"><span>↻ &nbsp;Resets</span><strong title="${reading?.resetsAt ? escape(formatTime(reading.resetsAt)) : ''}">${countdown(reading?.resetsAt)}</strong></div>
      <div class="card-detail"><span>◷ &nbsp;${isLive ? 'Updated' : 'Last recorded'}</span><strong title="${reading ? escape(formatTime(reading.observedAt)) : ''}">${elapsed(reading?.observedAt)}</strong></div>
      ${outlookBlock}
      ${lines.length ? `<div class="extra-windows">${lines.map(([label, value, binding]) => `<span class="${binding ? 'binding' : ''}"><span>${escape(label)}${binding ? ' · limiting' : ''}</span><strong>${escape(value)}</strong></span>`).join('')}</div>` : ''}
      ${breakdown}
      <p class="card-note">${note}</p>
      ${isLive ? '' : `<button class="card-action" data-edit="${p.id}">${manualAll.length ? 'Update reading' : '+ Add reading'}</button>`}</div>
      <div class="card-bottom"><span>${isLive ? 'Live · ' + escape(windowName(reading)) : reading ? 'Manual snapshot' : 'Nothing recorded'}</span><a href="${p.url}" target="_blank" rel="noopener noreferrer">Open ${p.name} <span aria-hidden="true">↗</span></a></div>
    </article>`;
  }).join('');
  $('#reading-count').textContent = `${liveCount} live · ${manualCount} manual`;
  $('#provider-cards').querySelectorAll('[data-edit]').forEach(button => { button.disabled = !ready || !storageAvailable || dataCorrupt; });

  const resets = [];
  for (const p of PROVIDERS) for (const window of ['current', 'weekly']) {
    const liveList = liveWindows(live, p.id, window);
    const manual = state.providers[p.id].windows[window];
    for (const r of liveList.length ? liveList : manual ? [manual] : []) if (r.resetsAt && Date.parse(r.resetsAt) > Date.now()) resets.push({ p, window, ...r });
  }
  resets.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
  $('#reset-count').textContent = `${resets.length} upcoming`;
  $('#reset-list').innerHTML = resets.length ? resets.map(r => `<div class="reset-item"><span class="tiny-mark ${r.p.color}" aria-hidden="true">${r.p.icon}</span><div><strong>${r.p.name} <span>· ${escape(r.scope || (r.window === 'weekly' ? 'Weekly' : 'Current window'))}${r.source === 'live' ? '' : ' · manual'}</span></strong><span>${escape(formatTime(r.resetsAt))} · ${amountLeft(r)}</span></div><time datetime="${escape(r.resetsAt)}">${countdown(r.resetsAt)}</time></div>`).join('') : '<div class="empty-resets"><span class="empty-icon" aria-hidden="true">◷</span><div><strong>Nothing scheduled yet.</strong><p>Reset times appear here as soon as the live feed or a manual reading provides one.</p></div></div>';
  renderApi();
  renderCredits();
}

function renderCredits() {
  const feed = liveStatus(live), age = live?.collectedAt ? elapsed(live.collectedAt).toLowerCase() : '';
  const day = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  $('#credit-overview').innerHTML = PROVIDERS.map(p => {
    const reading = state.api[p.id].reading;
    const rows = creditRows(live, p.id).map(r => {
      const when = r.source === 'live' ? (feed === 'stale' ? `Live · feed stale (${age})` : `Live · ${age}`) : r.checkedAt ? `Checked ${day(r.checkedAt)}` : 'Checked by hand';
      const renew = !r.renewsAt ? '' : Date.parse(r.renewsAt) + 86400000 < Date.now() ? `Credit date ${day(r.renewsAt)} has passed, re-check` : `Next credit ${day(r.renewsAt)}`;
      const planRow = r.id === 'api-plan';
      const recorded = planRow && reading ? `<p class="credit-balance">You recorded ${escape(reading.unit === 'usd' ? '$' + number(reading.remaining) : amountLeft(reading))}, ${escape(elapsed(reading.observedAt).toLowerCase())}</p>` : '';
      return `<div class="credit-row ${r.state}"><div class="credit-line"><span>${escape(r.label)}</span><strong>${escape(r.value)}</strong></div>${r.detail ? `<p class="credit-detail">${escape(r.detail)}</p>` : ''}${recorded}<div class="credit-meta"><span>${escape(when)}</span>${renew ? `<span>${escape(renew)}</span>` : ''}${r.url ? `<a href="${escape(r.url)}" target="_blank" rel="noopener noreferrer">Open <span aria-hidden="true">↗</span></a>` : ''}${planRow ? `<button class="text-button" data-api-edit="${p.id}">${reading ? 'Update balance' : 'Record balance'}</button>` : ''}</div></div>`;
    }).join('');
    return `<section class="credit-group" data-credits="${p.id}"><h3><span class="tiny-mark ${p.color}" aria-hidden="true">${p.icon}</span> ${p.name}</h3>${rows || `<p class="credit-detail">${feed === 'unknown' ? 'Waiting for the live feed.' : 'Nothing reported yet.'}</p>`}</section>`;
  }).join('');
  $('#credit-overview').querySelectorAll('button').forEach(b => { b.disabled = !ready || !storageAvailable || dataCorrupt; });
}

function renderApi() {
  $('#api-cards').innerHTML = PROVIDERS.map(p => {
    const data = state.api[p.id];
    let report = apiReports[p.id] || {};
    if (report.status === 'connected' && trackingBudgetLeft({budgetTokens:1}, report) === null) report = {status:'error',message:'This report belongs to an earlier month. Refresh usage for the current month.'};
    const reading = data.reading, status = readingStatus(reading), manual = reading && status !== 'expired';
    const budgetLeft = trackingBudgetLeft(data, report);
    const known = manual || budgetLeft !== null;
    const remaining = manual ? reading.remaining : budgetLeft;
    const display = known ? number(remaining) : '—';
    const pct = manual ? percentage(reading) : budgetLeft !== null ? budgetLeft / data.budgetTokens * 100 : null;
    const labels = { connected: 'API report connected', error: 'Report unavailable', not_configured: 'Not connected', manual: 'Manual reporting' };
    const badge = manual ? status === 'stale' ? 'Old manual balance' : 'Manual balance' : budgetLeft !== null ? 'Personal tracking budget' : labels[report.status] || 'Not connected';
    const label = manual ? reading.unit === 'usd' ? 'USD balance recorded' : reading.unit === 'percent' ? `left · ${number(usedPercent(reading))}% used` : `${reading.unit} remaining` : budgetLeft !== null ? 'tokens left in your budget' : 'balance unknown';
    const amount = manual && reading.unit === 'usd' ? '$' + display : display;
    const observedAt = manual ? reading.observedAt : report.observedAt;
    return `<article class="provider-card api-card"><div class="card-body">
      <div class="card-top"><div class="provider-mark ${p.color}" aria-hidden="true">${p.icon}</div><div class="card-title"><h3>${p.apiName}</h3><p>${escape(data.label || 'Developer account')}</p></div></div>
      <div class="status-line"><span class="status-tag ${manual && status === 'stale' ? 'stale' : report.status === 'connected' ? 'recorded' : ''}">${badge}</span></div>
      <div class="gauge-wrap ${p.color}"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="gauge-track ${pct === null ? 'empty' : ''}" cx="100" cy="100" r="83" pathLength="100"/>${pct === null ? '' : `<circle class="gauge-progress" cx="100" cy="100" r="83" pathLength="100" stroke-dasharray="${pct} 100"/>`}</svg><div class="gauge-value"><div class="gauge-number ${!known ? 'unknown' : amount.length > 6 ? 'long' : ''}">${amount}${manual && reading.unit === 'percent' ? '<small>%</small>' : ''}</div><div class="gauge-label">${label}</div></div></div>
      <p class="scope">${escape(report.scope || 'Usage scope not connected')}</p>
      <div class="card-detail"><span>Tokens used this month</span><strong>${report.status === 'connected' ? number(report.tokens.total) : 'Unknown'}</strong></div>
      <div class="card-detail"><span>Your budget left</span><strong>${budgetLeft === null ? 'Unknown' : number(budgetLeft)}</strong></div>
      <div class="card-detail"><span>Last report fetched</span><strong>${elapsed(report.observedAt)}</strong></div>
      <div class="card-detail"><span>Balance recorded</span><strong>${reading ? elapsed(reading.observedAt) : 'Never'}</strong></div>
      <p class="api-note">${escape(report.message || 'Connect reporting, or record a balance from your API account. No usage has been assumed.')}${status === 'expired' ? ' Your recorded balance has expired.' : ''}${report.observedAt ? ' Fetched ' + escape(formatTime(report.observedAt)) + '.' : ''}</p>
      <button class="card-action" data-api-edit="${p.id}">${reading ? 'Update API balance' : '+ Record API balance'}</button><button class="card-action" data-budget="${p.id}">${data.budgetTokens ? 'Edit' : 'Set'} personal token budget</button>
      </div><div class="card-bottom"><span>${observedAt ? 'Snapshot · not a rate limit' : 'Balance not recorded'}</span><a href="${p.apiUrl}" target="_blank" rel="noopener noreferrer">Open API console ↗</a></div></article>`;
  }).join('');
  $('#api-cards').querySelectorAll('button').forEach(b => { b.disabled = !ready || !storageAvailable || dataCorrupt; });
}

function setView(view) {
  activeView = view;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === view); b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
  $('#chat-section').hidden = view !== 'chat';
  $('#chat-details').hidden = view !== 'chat';
  $('#api-section').hidden = view !== 'api';
  if (view === 'api' && ready && !apiLoaded) refreshApi();
}

async function refreshLive(manual = false) {
  if (liveLoading) return;
  liveLoading = true;
  $('#refresh-live').disabled = true;
  $('#refresh-live').textContent = 'Refreshing…';
  try {
    const response = await fetch('/api/live', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error(`The live feed could not be loaded (HTTP ${response.status}). Sign in again if your session expired.`);
    const data = await response.json();
    if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new Error('The live feed response was not understood.');
    live = data;
    liveError = '';
    if (manual) toast(data.status === 'ok' ? 'Live readings refreshed.' : 'No live readings are available yet.');
  } catch (error) {
    liveError = error.message;
    if (manual) toast('Live readings could not be fetched.');
  } finally {
    liveLoading = false;
    $('#refresh-live').disabled = !ready;
    $('#refresh-live').textContent = '↻ Refresh';
    if (ready) { feedNotice(); render(); }
  }
}

async function refreshApi() {
  if (!ready || apiLoading) return;
  apiLoading = true;
  $('#refresh-api').disabled = true;
  $('#refresh-api').textContent = 'Reading usage…';
  try {
    if (localPreview) {
      apiReports = Object.fromEntries(PROVIDERS.map(p => [p.id, {status:'not_configured',message:'Local preview: reporting credentials are not connected.'}]));
    } else {
      const response = await fetch('/api/usage', {cache:'no-store',redirect:'error'});
      if (!response.ok) throw new Error('Usage could not be loaded. Sign in again if your session expired.');
      const data = await response.json();
      if (!data.providers || PROVIDERS.some(p => !data.providers[p.id])) throw new Error('Incomplete usage response.');
      apiReports = data.providers;
    }
    apiLoaded = true;
  } catch {
    apiReports = Object.fromEntries(PROVIDERS.map(p => [p.id, {status:'error',message:'Could not fetch usage. Check your sign-in and reporting connection; no new balance has been assumed.'}]));
    toast('API usage could not be fetched.');
  } finally {
    apiLoading = false;
    $('#refresh-api').disabled = false;
    $('#refresh-api').textContent = '↻ Refresh usage';
    renderApi();
  }
}

function persist(nextState) {
  const clean = validateState(nextState);
  if (!storageAvailable) throw new Error('Browser storage is unavailable. Enable site storage before saving readings.');
  try { localStorage.setItem(storageKey, JSON.stringify(clean)); }
  catch { throw new Error('Could not save. Browser storage may be disabled or full. Your previous readings are unchanged.'); }
  state = clean;
  dataCorrupt = false;
  $('#add-reading').disabled = false;
  $('#export-data').disabled = false;
  feedNotice();
  render();
}

function localDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}

function updateUnit() {
  const percent = $('#unit').value === 'percent';
  $('#total').disabled = percent;
  if (percent) $('#remaining').max = '100'; else $('#remaining').removeAttribute('max');
  const whole = ['tokens', 'messages'].includes($('#unit').value);
  $('#remaining').step = whole ? '1' : 'any';
  $('#total').step = whole ? '1' : 'any';
  $('#total').min = whole ? '1' : '0.000001';
  $('#unit-hint').textContent = percent ? 'If your provider says “28% used”, enter 72% remaining.' : 'Enter an exact remaining value only if your provider reports it. Leave the total blank if it is unknown.';
}

function populateForm() {
  const p = PROVIDERS.find(p => p.id === $('#provider').value);
  const api = $('#account-type').value === 'api';
  const data = api ? state.api[p.id] : state.providers[p.id], reading = api ? data.reading : data.windows[$('#window').value];
  $('#window').closest('label').hidden = api;
  $('#usd-option').hidden = !api;
  $('#usd-option').disabled = !api;
  $('#dialog-title').textContent = `${reading ? 'Update' : 'Add'} ${api ? p.apiName + ' balance' : p.name + ' reading'}`;
  $('#plan').parentElement.childNodes[0].textContent = api ? 'Account label ' : 'Plan ';
  $('#plan').value = api ? data.label : data.plan;
  $('#scope').value = reading?.scope || '';
  $('#unit').value = reading?.unit || 'percent';
  $('#remaining').value = reading?.remaining ?? '';
  $('#total').value = reading?.total && reading.unit !== 'percent' ? reading.total : '';
  $('#resets-at').value = reading?.resetsAt && Date.parse(reading.resetsAt) > Date.now() ? localDate(reading.resetsAt) : '';
  const liveHere = !api && liveWindows(live, p.id, $('#window').value).length > 0;
  $('#provider-help').textContent = api ? 'Record an actual balance or quota shown in your developer account.' : liveHere ? `${p.name} already has a live reading for this window; a manual reading is only shown when the live feed has none.` : p.help;
  $('#provider-open').href = api ? p.apiUrl : p.url;
  $('#remove-reading').hidden = !reading;
  $('#form-error').hidden = true;
  updateUnit();
}

function openReading(provider = 'claude', view = activeView) {
  if (!ready || !storageAvailable || dataCorrupt) return;
  $('#provider').value = provider;
  $('#account-type').value = view;
  $('#window').value = view === 'chat' && state.providers[provider].windows.current && !state.providers[provider].windows.weekly ? 'weekly' : 'current';
  populateForm();
  $('#reading-dialog').showModal();
}

$('#add-reading').addEventListener('click', () => openReading(PROVIDERS.find(p => !liveWindows(live, p.id, 'current').length && !liveWindows(live, p.id, 'weekly').length)?.id || 'claude'));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#refresh-api').addEventListener('click', refreshApi);
$('#refresh-live').addEventListener('click', () => refreshLive(true));
$('#api-setup').addEventListener('click', () => $('#api-setup-dialog').showModal());
$('#credit-overview').addEventListener('click', event => {
  const edit = event.target.closest('[data-api-edit]');
  if (edit) openReading(edit.dataset.apiEdit, 'api');
});
$('#account-type').addEventListener('change', populateForm);
$('#api-cards').addEventListener('click', event => {
  const edit = event.target.closest('[data-api-edit]'), budget = event.target.closest('[data-budget]');
  if (edit) openReading(edit.dataset.apiEdit, 'api');
  if (budget && ready && storageAvailable && !dataCorrupt) {
    $('#budget-provider').value = budget.dataset.budget;
    $('#budget-tokens').value = state.api[budget.dataset.budget].budgetTokens ?? '';
    $('#budget-error').hidden = true;
    $('#budget-dialog').showModal();
  }
});
$('#budget-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const next = structuredClone(state);
    next.api[$('#budget-provider').value].budgetTokens = $('#budget-tokens').value === '' ? null : Number($('#budget-tokens').value);
    persist(next);
    $('#budget-dialog').close();
    toast('Personal tracking budget saved.');
  } catch(error) { $('#budget-error').textContent = error.message; $('#budget-error').hidden = false; }
});
$('#provider-cards').addEventListener('click', event => {
  const button = event.target.closest('[data-edit]');
  if (button) openReading(button.dataset.edit);
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const id of ['open-guide', 'learn-more']) $(`#${id}`).addEventListener('click', () => $('#guide-dialog').showModal());
$('#provider').addEventListener('change', populateForm);
$('#window').addEventListener('change', populateForm);
$('#unit').addEventListener('change', updateUnit);

$('#reading-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if ($('#remaining').value.trim() === '') throw new Error('Enter the remaining allowance.');
    const data = structuredClone(state), id = $('#provider').value, window = $('#window').value, api = $('#account-type').value === 'api';
    const reading = {
      unit: $('#unit').value, scope: $('#scope').value.trim(), remaining: Number($('#remaining').value),
      total: $('#unit').value === 'percent' ? 100 : $('#total').value === '' ? null : Number($('#total').value),
      resetsAt: $('#resets-at').value ? new Date($('#resets-at').value).toISOString() : null,
      observedAt: new Date().toISOString(), source: 'manual',
    };
    if (api) { data.api[id].label = $('#plan').value.trim(); data.api[id].reading = reading; }
    else { data.providers[id].plan = $('#plan').value.trim(); data.providers[id].windows[window] = reading; }
    persist(data);
    setView(api ? 'api' : 'chat');
    $('#reading-dialog').close();
    toast('Reading saved in this browser.');
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
});

$('#remove-reading').addEventListener('click', () => {
  try {
    const data = structuredClone(state);
    if ($('#account-type').value === 'api') data.api[$('#provider').value].reading = null;
    else delete data.providers[$('#provider').value].windows[$('#window').value];
    persist(data);
    $('#reading-dialog').close();
    toast('Reading removed.');
  } catch(error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
});

$('#export-data').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `allowance-${new Date().toISOString().slice(0,10)}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup downloaded. It contains your manual readings.');
});

$('#import-data').addEventListener('click', () => {
  pendingImport = null;
  $('#import-file').value = '';
  $('#import-error').hidden = true;
  $('#confirm-import').disabled = true;
  $('#import-dialog').showModal();
});
$('#import-file').addEventListener('change', async () => {
  pendingImport = null;
  $('#confirm-import').disabled = true;
  $('#import-error').hidden = true;
  try {
    const file = $('#import-file').files[0];
    if (!file) return;
    if (file.size > 100000) throw new Error('This backup is too large. Choose an Allowance JSON export under 100 KB.');
    pendingImport = validateState(JSON.parse(await file.text()));
    $('#confirm-import').disabled = false;
  } catch(error) { $('#import-error').textContent = error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message; $('#import-error').hidden = false; }
});
$('#confirm-import').addEventListener('click', () => {
  if (!pendingImport) return;
  try { persist(pendingImport); $('#import-dialog').close(); toast('Backup imported into this browser.'); }
  catch(error) { $('#import-error').textContent = error.message; $('#import-error').hidden = false; }
});
$('#sign-out').addEventListener('click', () => {
  document.body.replaceChildren();
  location.assign('/cdn-cgi/access/logout');
});

render();
async function initialize() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('Access could not be verified. Open the main dashboard address and sign in again.');
    const session = await response.json();
    const local = session.mode === 'local-preview';
    localPreview = local;
    if (!local && (session.access !== 'owner' || typeof session.email !== 'string')) throw new Error('Owner access has not been verified.');
    storageKey = `${STORAGE_KEY}:${local ? 'local-preview' : session.email.toLowerCase()}`;
    $('#privacy-pill').innerHTML = local ? '<span aria-hidden="true">◈</span> Local preview' : '<span aria-hidden="true">◈</span> Only you';
    $('#privacy-pill').classList.toggle('preview', local);
    $('#owner-caption').textContent = local ? 'Preview on this computer' : session.email;
    $('#owner-caption').title = local ? 'Local preview' : session.email;
    $('#access-caption').textContent = local ? 'Local preview. Cloudflare privacy is not deployed yet.' : 'Protected by Cloudflare Access. Available only to your verified email.';
    $('#sign-out').hidden = local;
    let raw;
    try {
      const probe = `${storageKey}:probe`;
      localStorage.setItem(probe, '1'); localStorage.removeItem(probe);
      raw = localStorage.getItem(storageKey);
    } catch { storageAvailable = false; }
    let corrupt = false;
    if (raw) {
      try { state = validateState(JSON.parse(raw)); }
      catch { corrupt = true; dataCorrupt = true; }
    }
    if (corrupt) setNotice('Saved readings could not be loaded.', 'The existing data has been left untouched. Import a valid backup to restore your readings.', true);
    else if (!storageAvailable) setNotice('Browser storage is unavailable.', 'Enable site storage in your browser to save manual readings.', true);
    else setNotice('Loading the live feed.', 'Fetching the latest readings from the collector.');
    ready = true;
    $('#storage-caption').textContent = storageAvailable ? 'Manual readings stored in this browser' : 'Storage unavailable';
    $('#export-data').disabled = corrupt;
    $('#import-data').disabled = !storageAvailable;
    $('#add-reading').disabled = !storageAvailable || corrupt;
    $('#refresh-api').disabled = false;
    render();
    await refreshLive();
    if (corrupt) setNotice('Saved readings could not be loaded.', 'The existing data has been left untouched. Import a valid backup to restore your readings.', true);
    if (activeView === 'api') refreshApi();
  } catch(error) {
    setNotice('Dashboard locked.', error.message, true);
    $('#privacy-pill').textContent = 'Access unverified';
    $('#access-caption').textContent = 'Private access could not be verified.';
  }
}
await initialize();
setInterval(() => { if (ready && !document.querySelector('dialog[open]')) render(); }, 30000);
setInterval(() => { if (ready && !document.hidden) refreshLive(); }, 300000);
setInterval(() => { if (ready && activeView === 'api' && !document.hidden) refreshApi(); }, 300000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && ready && (!live?.collectedAt || Date.now() - Date.parse(live.collectedAt) > 120000)) refreshLive(); });
window.addEventListener('storage', event => {
  if ((event.key !== storageKey && event.key !== null) || !ready) return;
  try {
    state = event.newValue ? validateState(JSON.parse(event.newValue)) : emptyState();
    dataCorrupt = false;
    $('#add-reading').disabled = !storageAvailable;
    $('#export-data').disabled = false;
    render();
    if ($('#reading-dialog').open) { $('#reading-dialog').close(); toast('Readings changed in another tab. Reopen the reading to edit.'); }
  } catch { dataCorrupt = true; $('#add-reading').disabled = true; render(); setNotice('A reading changed in another tab.', 'Reload to check your saved data.', true); }
});
