import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState, validateState, readingStatus, percentage, countdown} from '../public/model.js';
const now = Date.now();
function snapshot(overrides = {}) {
  const data = emptyState();
  data.providers.claude.windows.current = {unit:'percent',remaining:72,total:100,scope:'All models',source:'manual',observedAt:new Date(now-1000).toISOString(),resetsAt:new Date(now+3600000).toISOString(),...overrides};
  return data;
}

test('unconnected providers start unknown, not at zero or a fabricated quota', () => {
  const state = validateState(emptyState());
  for (const provider of Object.values(state.providers)) {
    assert.deepEqual(provider.windows, {});
    assert.equal(readingStatus(provider.windows.current), 'unknown');
    assert.equal(percentage(provider.windows.current), null);
  }
});

test('zero balance is a real value, and unknown totals never produce a percentage', () => {
  const zero = validateState(snapshot({remaining:0})).providers.claude.windows.current;
  assert.equal(percentage(zero), 0);
  assert.equal(readingStatus(zero, now), 'recorded');
  const noTotal = validateState(snapshot({unit:'tokens',remaining:7200,total:null})).providers.claude.windows.current;
  assert.equal(percentage(noTotal), null);
});

test('time does not invent a renewed balance', () => {
  const reading = snapshot().providers.claude.windows.current;
  assert.equal(readingStatus(reading, now+3600001), 'expired');
  assert.equal(reading.remaining, 72);
  assert.equal(countdown(reading.resetsAt, now+3600001), 'Reset time passed');
  assert.equal(readingStatus({...reading,resetsAt:null}, now+3600001), 'stale');
});

test('invalid and misleading readings are rejected on both save and import', () => {
  for (const bad of [
    {remaining:-1}, {remaining:101}, {remaining:NaN}, {remaining:Infinity}, {remaining:'72'},
    {unit:'tokens',remaining:1.5}, {total:0}, {total:50,remaining:72}, {unit:'dollars'},
    {observedAt:'yesterday'}, {observedAt:new Date(now+3600000).toISOString()},
    {resetsAt:new Date(now-3600000).toISOString()}, {scope:'x'.repeat(101)},
  ]) assert.throws(() => validateState(snapshot(bad)));
  assert.throws(() => validateState({version:99,providers:{}}));
});

test('import strips unknown fields and cannot label manual data as a live connection', () => {
  const data = snapshot({source:'live',apiKey:'never-retain',extra:{a:1}});
  data.secret = 'never-retain';
  const clean = validateState(data);
  assert.equal(clean.providers.claude.windows.current.source, 'manual');
  assert.equal(JSON.stringify(clean).includes('never-retain'), false);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(clean))), clean);
});

test('the current and weekly windows remain independent', () => {
  const data = snapshot();
  data.providers.claude.windows.weekly = {...data.providers.claude.windows.current, remaining:35};
  const clean = validateState(data);
  assert.equal(clean.providers.claude.windows.current.remaining,72);
  assert.equal(clean.providers.claude.windows.weekly.remaining,35);
  assert.deepEqual(clean.providers.chatgpt.windows,{});
});
