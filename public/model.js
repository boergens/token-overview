export const PROVIDERS = [
  { id: 'claude', name: 'Claude', company: 'Anthropic', fallbackModel: 'Opus 5.5', apiName: 'Anthropic API', apiUrl: 'https://platform.claude.com/usage', url: 'https://claude.ai/settings/usage', help: 'Settings → Usage', icon: '✳', color: 'terracotta' },
  { id: 'chatgpt', name: 'ChatGPT', company: 'OpenAI', apiName: 'OpenAI API', apiUrl: 'https://platform.openai.com/usage', url: 'https://chatgpt.com/', help: 'Check the usage indicator for the product and model you use.', icon: '◎', color: 'green' },
  { id: 'gemini', name: 'Gemini', company: 'Google', apiName: 'Gemini API', apiUrl: 'https://aistudio.google.com/', url: 'https://gemini.google.com/', help: 'Settings → Usage Limits', icon: '✦', color: 'blue' },
];
export const STORAGE_KEY = 'allowance.readings.v1';
export const emptyState = () => ({ version: 2, providers: Object.fromEntries(PROVIDERS.map(p => [p.id, { plan: '', windows: {} }])), api: Object.fromEntries(PROVIDERS.map(p => [p.id, { budgetTokens: null, label: '', reading: null }])) });

export function validateState(value) {
  if (!value || ![1, 2].includes(value.version) || typeof value.providers !== 'object' || !value.providers) throw new Error('This is not an Allowance backup.');
  const clean = emptyState();
  for (const p of PROVIDERS) {
    const data = value.providers[p.id];
    if (!data || typeof data.plan !== 'string' || data.plan.length > 80 || !data.windows || typeof data.windows !== 'object') throw new Error(`Invalid ${p.name} settings.`);
    clean.providers[p.id].plan = data.plan.trim();
    for (const window of ['current', 'weekly']) {
      const reading = data.windows[window];
      if (reading === undefined) continue;
      if (!reading || !['percent', 'messages', 'tokens', 'credits'].includes(reading.unit)) throw new Error('Invalid allowance unit.');
      if (typeof reading.scope !== 'string' || reading.scope.length > 100) throw new Error('Keep the model or limit name under 100 characters.');
      if (!Number.isFinite(reading.remaining) || reading.remaining < 0 || reading.remaining > Number.MAX_SAFE_INTEGER) throw new Error('Remaining allowance must be a non-negative number.');
      if (reading.unit === 'percent' && (reading.remaining > 100 || reading.total !== 100)) throw new Error('Percentage must be between 0 and 100.');
      if (reading.total !== null && (!Number.isFinite(reading.total) || reading.total <= 0 || reading.total > Number.MAX_SAFE_INTEGER || reading.remaining > reading.total)) throw new Error('Total allowance must be at least the remaining allowance and greater than zero.');
      if (['tokens', 'messages'].includes(reading.unit) && (!Number.isInteger(reading.remaining) || (reading.total !== null && !Number.isInteger(reading.total)))) throw new Error('Tokens and messages must be whole numbers.');
      if (typeof reading.observedAt !== 'string' || !Number.isFinite(Date.parse(reading.observedAt)) || Date.parse(reading.observedAt) > Date.now() + 60000) throw new Error('Invalid observation time.');
      if (reading.resetsAt !== null && (typeof reading.resetsAt !== 'string' || !Number.isFinite(Date.parse(reading.resetsAt)) || Date.parse(reading.resetsAt) <= Date.parse(reading.observedAt))) throw new Error('Reset time must be after the reading was taken.');
      clean.providers[p.id].windows[window] = { unit: reading.unit, scope: reading.scope.trim(), remaining: reading.remaining, total: reading.total, observedAt: reading.observedAt, resetsAt: reading.resetsAt, source: 'manual' };
    }
  }
  if (value.version === 2) {
    for (const p of PROVIDERS) {
      const api = value.api?.[p.id];
      if (!api || typeof api.label !== 'string' || api.label.length > 80 || (api.budgetTokens !== null && (!Number.isSafeInteger(api.budgetTokens) || api.budgetTokens <= 0))) throw new Error(`Invalid ${p.name} API settings.`);
      clean.api[p.id].label = api.label.trim();
      clean.api[p.id].budgetTokens = api.budgetTokens;
      if (api.reading !== null) {
        const r = api.reading;
        if (!r || !['percent','tokens','messages','credits','usd'].includes(r.unit)) throw new Error('Invalid API balance unit.');
        // Reuse the strict reading checks without mixing API and chat state.
        const temporary = { version: 1, providers: structuredClone(clean.providers) };
        temporary.providers[p.id].windows = { current: { ...r, unit: r.unit === 'usd' ? 'credits' : r.unit } };
        const validated = validateState(temporary).providers[p.id].windows.current;
        clean.api[p.id].reading = { ...validated, unit: r.unit };
      }
    }
  }
  return clean;
}

export function trackingBudgetLeft(api, report, now = Date.now()) {
  if (!api?.budgetTokens || report?.status !== 'connected' || !Number.isSafeInteger(report.tokens?.total) || report.tokens.total < 0) return null;
  const start = new Date(report.period?.start);
  const current = new Date(now);
  if (start.getUTCFullYear() !== current.getUTCFullYear() || start.getUTCMonth() !== current.getUTCMonth()) return null;
  return Math.max(0, api.budgetTokens - report.tokens.total);
}

export function readingStatus(reading, now = Date.now()) {
  if (!reading) return 'unknown';
  if (reading.resetsAt && Date.parse(reading.resetsAt) <= now) return 'expired';
  if (now - Date.parse(reading.observedAt) > 3600000) return 'stale';
  return 'recorded';
}

export function percentage(reading) {
  return reading?.total ? Math.max(0, Math.min(100, reading.remaining / reading.total * 100)) : null;
}

export function countdown(value, now = Date.now()) {
  if (!value) return 'Not recorded';
  const minutes = Math.ceil((Date.parse(value) - now) / 60000);
  if (minutes <= 0) return 'Reset time passed';
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `In ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `In ${hours}h ${minutes % 60}m`;
}

// Live feed: percentages the providers report for their own usage windows, collected every few minutes.
export const LIVE_STALE_MS = 15 * 60000;

export function liveProvider(live, providerId) {
  const provider = live && live.status === 'ok' && live.providers && typeof live.providers === 'object' ? live.providers[providerId] : null;
  return provider && typeof provider === 'object' ? provider : null;
}

export function liveStatus(live, now = Date.now()) {
  if (!live || live.status !== 'ok' || typeof live.collectedAt !== 'string') return 'unknown';
  const age = now - Date.parse(live.collectedAt);
  if (!Number.isFinite(age)) return 'unknown';
  return age > LIVE_STALE_MS ? 'stale' : 'live';
}

export function liveWindows(live, providerId, window, now = Date.now()) {
  const provider = liveProvider(live, providerId);
  if (!provider || provider.status !== 'ok' || !Array.isArray(provider.windows) || liveStatus(live, now) === 'unknown') return [];
  const readings = [];
  for (const w of provider.windows) {
    if (!w || typeof w !== 'object' || w.kind !== window || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
    const remaining = Math.round(Math.max(0, Math.min(100, 100 - w.usedPercent)) * 10) / 10;
    const resetsAt = typeof w.resetsAt === 'string' && Number.isFinite(Date.parse(w.resetsAt)) ? w.resetsAt : null;
    const scoped = {};
    for (const key of ['model', 'surface']) if (typeof w[key] === 'string' && w[key].trim()) scoped[key] = w[key].trim().slice(0, 40);
    if (w.gate === true) scoped.gate = true;
    readings.push({ id: String(w.id ?? ''), kind: window, unit: 'percent', remaining, total: 100, scope: String(w.label || w.id || '').slice(0, 100), observedAt: live.collectedAt, resetsAt, source: 'live', ...scoped });
  }
  return readings;
}

export function planLabel(plan) {
  if (typeof plan !== 'string' || !plan.trim()) return '';
  const names = { max: 'Max', pro: 'Pro', plus: 'Plus', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  const key = plan.trim().toLowerCase();
  return `${names[key] || plan.trim()} plan`;
}

// The reading that limits the provider right now: the smallest remaining percentage. Readings without a
// percentage (an unknown total) cannot be compared and are used only when nothing comparable exists.
export function bindingReading(readings) {
  let best = null, bestPct = Infinity;
  for (const reading of readings) {
    const pct = percentage(reading);
    if (pct !== null && pct < bestPct) { best = reading; bestPct = pct; }
  }
  return best || readings[0] || null;
}

// The used side of a percentage reading: provider screens count up, this page counts down.
export function usedPercent(reading) {
  if (!reading || reading.unit !== 'percent' || typeof reading.remaining !== 'number') return null;
  return Math.round((100 - reading.remaining) * 10) / 10;
}

// Credit pots for the overview. Rows come from the feed, so every field is checked before it reaches the page.
export function creditRows(live, providerId) {
  const provider = liveProvider(live, providerId);
  if (!provider || !Array.isArray(provider.credits)) return [];
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  return provider.credits.flatMap(row => {
    if (!row || typeof row !== 'object' || !text(row.label, 80) || !text(row.value, 80)) return [];
    let url = null;
    try { const parsed = new URL(row.url); if (parsed.protocol === 'https:') url = parsed.href; } catch { /* no link */ }
    return [{ id: text(row.id, 40), label: text(row.label, 80), value: text(row.value, 80), detail: text(row.detail, 300), state: ['ok', 'empty', 'warn'].includes(row.state) ? row.state : 'unknown', source: row.source === 'live' ? 'live' : 'checked', checkedAt: date(row.checkedAt), renewsAt: date(row.renewsAt), url }];
  });
}

// What is left for the model you would switch to when a model-only limit (e.g. Fable's) is the limiting one.
// That model is bound by the general windows plus any limit of its own: "Opus" also applies to "Opus 5.5".
export function fallbackReading(readings, binding, fallbackModel = '') {
  if (!binding?.model) return null;
  const name = fallbackModel.toLowerCase();
  if (name && name.startsWith(binding.model.toLowerCase())) return null;
  return bindingReading(readings.filter(r => r !== binding && !r.surface && (!r.model || (name && name.startsWith(r.model.toLowerCase())))));
}

// Plain-language forecast for a card. The odds are rough (see collector/forecast.py), so they are rounded and worded loosely.
export function forecastView(forecast, now = Date.now(), timeZone = undefined) {
  if (!forecast || typeof forecast !== 'object') return null;
  if (forecast.status === 'thin') return { headline: 'Not enough history to forecast yet', detail: '', basis: Number.isFinite(forecast.hours) ? `${forecast.hours} hours logged so far; it starts at 48.` : '', tone: 'muted' };
  if (forecast.status !== 'ok' || !Array.isArray(forecast.race)) return null;
  const race = forecast.race.filter(r => r && typeof r.label === 'string' && Number.isFinite(r.p) && Number.isFinite(r.pFirst));
  const odds = p => p < 0.05 ? 'under 5%' : p > 0.95 ? 'over 95%' : `about ${Math.round(p * 10) * 10}%`;
  const valid = iso => typeof iso === 'string' && Number.isFinite(Date.parse(iso));
  const day = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone });
  const when = iso => Date.parse(iso) - now < 48 * 3600000 ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', timeZone }) : day(iso);
  const days = Number.isFinite(forecast.days) ? Math.round(forecast.days) : null;
  const basis = `Rough estimate${days ? ` from ${days} days of your usage` : ''}. It can’t foresee a sudden burst.`;
  const notes = [];
  for (const e of Array.isArray(forecast.exchange) ? forecast.exchange : []) if (e && Number.isFinite(e.weeklyPerWindow) && e.weeklyPerWindow > 0) notes.push(`A full 5-hour window costs about ${Math.round(e.weeklyPerWindow)}% of the week, so the week holds about ${(100 / e.weeklyPerWindow).toFixed(1)} of them.`);
  const unknown = (Array.isArray(forecast.unknown) ? forecast.unknown : []).filter(x => typeof x === 'string');
  if (unknown.length) notes.push(`No basis yet for ${unknown.join(', ')}.`);
  if (!race.length) return { headline: 'Nothing left to forecast', detail: notes.join(' '), basis, tone: 'muted' };
  const top = race.reduce((a, b) => b.pFirst > a.pFirst ? b : a);
  const none = Number.isFinite(forecast.pNone) ? forecast.pNone : 1;
  if (none >= 0.9 || top.pFirst <= 0) {
    const fullest = race.filter(r => r.kind !== 'current' && Number.isFinite(r.endMedian)).reduce((a, b) => !a || b.endMedian > a.endMedian ? b : a, null);
    if (fullest) notes.unshift(`${fullest.label} likely ends near ${Math.round(fullest.endMedian)}%.`);
    return { headline: 'Nothing is likely to run out before it resets', detail: notes.join(' '), basis, tone: 'calm' };
  }
  const word = top.p >= 0.7 ? 'will probably run out' : top.p >= 0.3 ? 'could run out' : 'probably won’t run out, but could,';
  const parts = [];
  if (valid(top.medianAt)) {
    const range = valid(top.earlyAt) && valid(top.lateAt) && day(top.earlyAt) !== day(top.lateAt) ? ` (${day(top.earlyAt)} to ${day(top.lateAt)})` : '';
    parts.push(`If it does, around ${when(top.medianAt)}${range}.`);
  }
  const rivals = race.filter(r => r.pFirst >= 0.05);
  if (rivals.length > 1) parts.push(`Which goes first: ${rivals.map(r => `${r.label} ${odds(r.pFirst)}`).join(', ')}, neither ${odds(none)}.`);
  return { headline: `${top.label} ${word} before it resets (${odds(top.p)})`, detail: [...parts, ...notes].join(' '), basis, tone: top.p >= 0.7 ? 'warn' : 'watch' };
}
