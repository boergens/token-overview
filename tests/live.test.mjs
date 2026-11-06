import test from 'node:test';
import assert from 'node:assert/strict';
import { liveWindows, liveStatus, liveProvider, planLabel, bindingReading, usedPercent, creditRows, fallbackReading, forecastView, PROVIDERS, LIVE_STALE_MS } from '../public/model.js';
const now = Date.parse('2026-10-19T18:00:00Z');
const feed = (ageMs = 60000) => ({ status: 'ok', version: 1, collectedAt: new Date(now - ageMs).toISOString(), collector: 'box', providers: {
  claude: { status: 'ok', plan: 'max', source: 'Claude Code sign-in', windows: [
    { id: 'five_hour', label: '5-hour window', kind: 'current', usedPercent: 23.4, resetsAt: '2026-10-19T20:00:00Z' },
    { id: 'seven_day', label: 'Weekly · all models', kind: 'weekly', usedPercent: 12, resetsAt: '2026-10-22T10:00:00Z' },
    { id: 'seven_day_opus', label: 'Weekly · Opus', kind: 'weekly', usedPercent: 105, resetsAt: 'never' },
    { id: 'broken', label: 'Broken', kind: 'weekly', usedPercent: 'lots' },
  ] },
  chatgpt: { status: 'ok', plan: 'promax', windows: [{ id: 'primary', label: 'Weekly window', kind: 'weekly', usedPercent: 4, resetsAt: '2026-10-25T00:00:00Z' }] },
  gemini: { status: 'not_connected', message: 'Not yet.' },
} });

test('live windows become percent-remaining readings, sorted as sent, clamped, with reset times validated', () => {
  const current = liveWindows(feed(), 'claude', 'current', now);
  assert.equal(current.length, 1);
  assert.deepEqual(current[0], { id: 'five_hour', kind: 'current', unit: 'percent', remaining: 76.6, total: 100, scope: '5-hour window', observedAt: feed().collectedAt, resetsAt: '2026-10-19T20:00:00Z', source: 'live' });
  const weekly = liveWindows(feed(), 'claude', 'weekly', now);
  assert.deepEqual(weekly.map(w => [w.id, w.remaining, w.resetsAt]), [['seven_day', 88, '2026-10-22T10:00:00Z'], ['seven_day_opus', 0, null]]);
  assert.deepEqual(liveWindows(feed(), 'chatgpt', 'current', now), []);
  assert.equal(liveWindows(feed(), 'chatgpt', 'weekly', now)[0].remaining, 96);
  assert.deepEqual(liveWindows(feed(), 'gemini', 'current', now), []);
});

test('feed freshness: live, stale after 15 minutes, unknown when missing or malformed', () => {
  assert.equal(liveStatus(feed(), now), 'live');
  assert.equal(liveStatus(feed(LIVE_STALE_MS + 1), now), 'stale');
  assert.equal(liveStatus(null, now), 'unknown');
  assert.equal(liveStatus({ status: 'not_connected' }, now), 'unknown');
  assert.equal(liveStatus({ status: 'ok', collectedAt: 'yesterday', providers: {} }, now), 'unknown');
  assert.deepEqual(liveWindows({ status: 'ok', collectedAt: 'yesterday', providers: feed().providers }, 'claude', 'current', now), []);
  assert.equal(liveProvider({ status: 'error', providers: feed().providers }, 'claude'), null);
  assert.equal(liveProvider(feed(), 'gemini').status, 'not_connected');
});

test('plan labels are readable and never invented', () => {
  assert.equal(planLabel('max'), 'Max plan');
  assert.equal(planLabel('promax'), 'promax plan');
  assert.equal(planLabel(''), '');
  assert.equal(planLabel(null), '');
});

test('the most limiting window wins: a used-up weekly limit beats a fresh 5-hour window', () => {
  const all = [...liveWindows(feed(), 'claude', 'current', now), ...liveWindows(feed(), 'claude', 'weekly', now)];
  assert.equal(bindingReading(all).id, 'seven_day_opus');
  const exhausted = { ...feed(), providers: { claude: { status: 'ok', windows: [
    { id: 'five_hour', label: '5-hour window', kind: 'current', usedPercent: 0, resetsAt: null },
    { id: 'seven_day', label: 'Weekly · all models', kind: 'weekly', usedPercent: 100, resetsAt: '2026-10-21T03:00:00Z' } ] } } };
  const pick = bindingReading([...liveWindows(exhausted, 'claude', 'current', now), ...liveWindows(exhausted, 'claude', 'weekly', now)]);
  assert.equal(pick.id, 'seven_day');
  assert.equal(pick.remaining, 0);
  assert.equal(bindingReading([]), null);
  const noPercent = { unit: 'tokens', remaining: 500, total: null };
  assert.equal(bindingReading([noPercent]), noPercent);
  assert.equal(bindingReading([noPercent, { unit: 'percent', remaining: 40, total: 100 }]).remaining, 40);
});

test('model-scoped limits keep their scope, and a used-up Fable cap becomes the limiting window', () => {
  const f = { status: 'ok', version: 1, collectedAt: new Date(now - 60000).toISOString(), providers: { claude: { status: 'ok', windows: [
    { id: 'seven_day', label: 'Weekly · all models', kind: 'weekly', usedPercent: 51, resetsAt: '2026-10-22T10:00:00Z' },
    { id: 'limit:weekly_scoped_fable', label: 'Weekly · Fable', kind: 'weekly', usedPercent: 100, resetsAt: '2026-10-22T10:00:00Z', model: 'Fable' },
    { id: 'limit:weekly_scoped_cowork', label: 'Weekly · Cowork', kind: 'weekly', usedPercent: 10, resetsAt: null, surface: '  Cowork ', model: 42 } ] } } };
  const weekly = liveWindows(f, 'claude', 'weekly', now);
  assert.equal('model' in weekly[0], false);
  assert.equal(weekly[1].model, 'Fable');
  assert.deepEqual([weekly[2].surface, 'model' in weekly[2]], ['Cowork', false]);
  assert.equal(bindingReading(weekly), weekly[1]);
  assert.equal(bindingReading(weekly.filter(r => !r.model && !r.surface)).remaining, 49);
});

test('the used side mirrors the provider figure, and a model gate stays marked as inferred', () => {
  const f = { status: 'ok', version: 1, collectedAt: new Date(now - 60000).toISOString(), providers: { chatgpt: { status: 'ok', windows: [
    { id: 'primary', label: 'Weekly window', kind: 'weekly', usedPercent: 77, resetsAt: null },
    { id: 'seven', label: 'Fractional', kind: 'weekly', usedPercent: 23.4, resetsAt: null },
    { id: 'model:gpt-6-astra', label: 'GPT-6 Astra', kind: 'weekly', usedPercent: 100, resetsAt: null, model: 'GPT-6 Astra', gate: true } ] } } };
  const [weekly, fractional, astra] = liveWindows(f, 'chatgpt', 'weekly', now);
  assert.deepEqual([weekly.remaining, usedPercent(weekly)], [23, 77]);
  assert.deepEqual([fractional.remaining, usedPercent(fractional)], [76.6, 23.4]);
  assert.equal(astra.gate, true);
  assert.equal('gate' in weekly, false);
  assert.equal(usedPercent({ unit: 'tokens', remaining: 5, total: null }), null);
  assert.equal(usedPercent(null), null);
});

test('credit rows are validated: only https links, known states, bounded text, and they survive a provider failure', () => {
  const f = { status: 'ok', collectedAt: new Date(now).toISOString(), providers: {
    claude: { status: 'error', credits: [
      { id: 'api-plan', label: 'API credits', value: '$200 a month', detail: 'x'.repeat(500), state: 'unknown', source: 'checked', checkedAt: '2026-11-06', renewsAt: 'soon', url: 'https://platform.claude.com/settings/billing' },
      { id: 'a', label: 'Live', value: '1', state: 'odd', source: 'live', url: 'javascript:alert(1)' },
      { id: 'b', label: 'No value' }, 'junk', null ] },
    chatgpt: { status: 'ok', credits: 'nope' } } };
  const rows = creditRows(f, 'claude');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://platform.claude.com/settings/billing');
  assert.equal(rows[0].detail.length, 300);
  assert.deepEqual([rows[0].checkedAt, rows[0].renewsAt, rows[0].source], ['2026-11-06', null, 'checked']);
  assert.deepEqual([rows[1].url, rows[1].state, rows[1].source], [null, 'unknown', 'live']);
  assert.deepEqual(creditRows(f, 'chatgpt'), []);
  assert.deepEqual(creditRows(f, 'gemini'), []);
  assert.deepEqual(creditRows(null, 'claude'), []);
});

test('once a model-only limit binds, the fallback model shows its own tightest window', () => {
  const w = (id, remaining, extra = {}) => ({ id, unit: 'percent', remaining, total: 100, ...extra });
  const all = w('seven_day', 48), fable = w('fable', 0, { model: 'Fable' }), five = w('five_hour', 30), opus = w('opus', 12, { model: 'Opus' }), sonnet = w('sonnet', 1, { model: 'Sonnet' }), cowork = w('cowork', 2, { surface: 'Cowork' });
  const opus55 = PROVIDERS.find(p => p.id === 'claude').fallbackModel;
  assert.equal(opus55, 'Opus 5.5');
  // A real account on 2026-11-06: no Opus limit of its own, so the all-models window is the answer.
  assert.equal(fallbackReading([all, fable], fable, opus55), all);
  assert.equal(fallbackReading([all, five, fable], fable, opus55), five);
  // A limit of Opus's own counts when tighter; another model's limit or a surface's never does.
  assert.equal(fallbackReading([all, opus, fable], fable, opus55), opus);
  assert.equal(fallbackReading([all, sonnet, cowork, fable], fable, opus55), all);
  // Nothing to fall back to, or the limit is already general or Opus's own.
  assert.equal(fallbackReading([fable], fable, opus55), null);
  assert.equal(fallbackReading([all, fable], all, opus55), null);
  assert.equal(fallbackReading([all, opus], opus, opus55), null);
  assert.equal(fallbackReading([all, cowork], cowork, opus55), null);
  // Providers without a named fallback still get the general window.
  assert.equal(fallbackReading([all, fable], fable), all);
  assert.equal(fallbackReading([all, opus, fable], fable), all);
});

test('forecasts read plainly, with rounded odds, and never claim more than the data', () => {
  const at = Date.parse('2026-11-06T19:00:00Z');
  const row = (label, p, pFirst, extra = {}) => ({ id: label, label, kind: 'weekly', p, pFirst, endMedian: 40, ...extra });
  const dates = { medianAt: '2026-11-09T06:00:00Z', earlyAt: '2026-11-07T13:00:00Z', lateAt: '2026-11-10T16:00:00Z' };
  const view = f => forecastView({ status: 'ok', days: 18, out: [], unknown: [], ...f }, at, 'UTC');
  let v = view({ race: [row('Weekly · all models', 0.387, 0.387, dates)], pNone: 0.613 });
  assert.equal(v.headline, 'Weekly · all models could run out before it resets (about 40%)');
  assert.equal(v.detail, 'If it does, around Nov 9 (Nov 7 to Nov 10).');
  assert.equal(v.tone, 'watch');
  assert.match(v.basis, /18 days.*can’t foresee a sudden burst/);
  v = view({ race: [row('Week', 0.82, 0.82, { ...dates, medianAt: '2026-11-07T02:00:00Z' })], pNone: 0.18 });
  assert.match(v.headline, /^Week will probably run out .*about 80%/);
  assert.match(v.detail, /around Nov 7, 2 AM/);
  assert.equal(v.tone, 'warn');
  assert.match(view({ race: [row('Week', 0.15, 0.15, dates)], pNone: 0.85 }).headline, /probably won’t run out, but could/);
  v = view({ race: [{ ...row('5-hour', 0.3, 0.2, dates), kind: 'current' }, row('Weekly', 0.5, 0.3)], pNone: 0.5 });
  assert.match(v.detail, /Which goes first: 5-hour about 20%, Weekly about 30%, neither about 50%\./);
  v = view({ race: [{ ...row('5-hour', 0, 0), kind: 'current' }, row('Weekly', 0.01, 0.01, { endMedian: 4.5 })], pNone: 0.99 });
  assert.equal(v.headline, 'Nothing is likely to run out before it resets');
  assert.match(v.detail, /Weekly likely ends near 5%\./);
  assert.equal(v.tone, 'calm');
  v = view({ race: [], unknown: ['Weekly · Other'], exchange: [{ label: '5-hour', weeklyPerWindow: 28.4 }] });
  assert.equal(v.headline, 'Nothing left to forecast');
  assert.match(v.detail, /costs about 28% of the week, so the week holds about 3\.5 of them\. No basis yet for Weekly · Other\./);
  assert.match(forecastView({ status: 'thin', hours: 20 }).basis, /20 hours logged/);
  for (const bad of [null, 'x', {}, { status: 'ok' }, { status: 'weird', race: [] }]) assert.equal(forecastView(bad), null);
  assert.equal(view({ race: [row('Week', 0.5, 0.5, { medianAt: 'soon' })], pNone: 0.5 }).detail, '');
});
