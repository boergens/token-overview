#!/usr/bin/env python3
"""Forecast which usage window runs out first, and when.

History is every collector run (5 minutes apart), turned into burn per hour for each window. The future is simulated
by resampling 6-hour blocks of your own past usage: blocks from recent days, from a similar time of day, and following
a similar state (busy or idle) are the likeliest to be drawn. Blocks keep all of a provider's windows together, so
windows that move together stay together. Each simulation plays the windows forward with their real rules until one
reaches 100%:
  * a weekly window just fills until its known reset,
  * a 5-hour window starts at first use, and empties 5 hours later.
Counting how often each window gets there first gives the probabilities.

A window without enough recent history of its own (Fable after it was capped, a 5-hour window that reappears) follows
the main window through an exchange rate: measured if possible, else from this cycle's readings, else from the share
of the week the provider says it is allowed. With no basis for a rate, it is reported as unknown, never guessed.

No dependencies, and every function except the history helpers is pure, so `backtest.py` can replay the past.
"""
from __future__ import annotations

import json
import math
import os
import random
import statistics
from datetime import datetime, timezone
from pathlib import Path

BLOCK_HOURS = 6
HALF_LIFE_DAYS = 3.0
SIMULATIONS = 600
# Spread of the "how busy will you be" multiplier on each simulated future. Without it the 80% ranges held the truth 71%
# of the time in the backtest; 0.7 gives 74%, and it moved Claude's chance of running out from 60% to 39% on 2026-11-06.
# So treat the probabilities as rough: the page rounds them and words them loosely.
BUSY_SIGMA = 0.7
MIN_HISTORY_HOURS = 48
HISTORY_DAYS = 45
SESSION_HOURS = 5
MAX_GAP_SECONDS = 3600
MIN_RATIO_SHORT, MIN_RATIO_LONG = 20.0, 5.0
RECENT_HOURS = 7 * 24
MIN_RECENT_HOURS = 24


def to_epoch(value) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()


def to_iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


# --- History file -----------------------------------------------------------------------------------------------------

def history_row(stamp: str, providers: dict) -> dict:
    """One line of history. Windows with an inferred 100% (`gate`) are left out: that number was never reported."""
    used, resets = {}, {}
    for name, provider in providers.items():
        if not isinstance(provider, dict) or provider.get('status') != 'ok':
            continue
        for window in provider.get('windows') or []:
            if window.get('gate') or not isinstance(window.get('usedPercent'), (int, float)):
                continue
            key = f"{name}/{window['id']}"
            used[key] = window['usedPercent']
            if window.get('resetsAt'):
                resets[key] = window['resetsAt']
    return {'t': stamp, 'u': used, 'r': resets}


def append_history(path: Path, row: dict) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as handle:
        handle.write(json.dumps(row, separators=(',', ':'), ensure_ascii=False) + '\n')


def load_history(path: Path, provider: str, now: float, days: float = HISTORY_DAYS) -> list:
    """[(epoch, {window id: used})] for one provider, oldest first. Damaged lines are skipped."""
    prefix, oldest, samples = f'{provider}/', now - days * 86400, []
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            row = json.loads(line)
            stamp = to_epoch(row['t'])
            values = {key[len(prefix):]: float(value) for key, value in row['u'].items() if key.startswith(prefix)}
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
        if stamp is not None and oldest <= stamp <= now and values:
            samples.append((stamp, values))
    samples.sort(key=lambda sample: sample[0])
    return samples


# --- From samples to burn per hour ------------------------------------------------------------------------------------

def hourly_burn(samples: list) -> tuple:
    """({hour: {window: percent burned}}, {window: hours spent at 100%}). Hours without any sample are absent."""
    burn, capped, last = {}, {}, {}
    for stamp, values in samples:
        hour = int(stamp // 3600)
        bucket = burn.setdefault(hour, {})
        for window, used in values.items():
            bucket.setdefault(window, 0.0)
            previous = last.get(window)
            if previous and stamp - previous[0] <= MAX_GAP_SECONDS:
                if previous[1] >= 100:
                    capped.setdefault(window, set()).add(hour)
                elif used >= previous[1]:
                    bucket[window] += used - previous[1]
                elif used <= previous[1] * 0.5:
                    bucket[window] += used  # a reset: what shows now accrued since then
                # a small drop is a provider revision or rounding, not a reset
            last[window] = (stamp, used)
    return burn, capped


def exchange_rate(burn: dict, capped: dict, short: str, long: str) -> float | None:
    """Percent of `long` burned per percent of `short`, or None until enough usage has been seen to say."""
    total_short = total_long = 0.0
    for hour, values in burn.items():
        if short in values and long in values and hour not in capped.get(long, ()) and hour not in capped.get(short, ()):
            total_short += values[short]
            total_long += values[long]
    return total_long / total_short if total_short >= MIN_RATIO_SHORT and total_long >= MIN_RATIO_LONG else None


# --- The sampler: which past block could come next? ------------------------------------------------------------------

class Sampler:
    def __init__(self, burn: dict, capped: dict, driver: str, now_hour: int, half_life: float = HALF_LIFE_DAYS):
        self.burn, self.driver, self.now_hour, self.half_life = burn, driver, now_hour, half_life
        blocked = capped.get(driver, set())
        self.blocks = []
        for hour in sorted(burn):
            span = range(hour, hour + BLOCK_HOURS)
            if span[-1] < now_hour and all(h in burn for h in span) and not any(h in blocked for h in span):
                self.blocks.append((hour, [burn[h] for h in span], self.is_busy(hour)))
        self._weights = {}

    def is_busy(self, hour: int) -> bool:
        return any(self.burn.get(hour - back, {}).get(self.driver, 0) > 0 for back in (1, 2))

    def _cumulative(self, hour_of_day: int, busy: bool) -> list:
        key = (hour_of_day, busy)
        if key not in self._weights:
            total, cumulative = 0.0, []
            for start, _, block_busy in self.blocks:
                recency = 0.5 ** (((self.now_hour - start) / 24) / self.half_life)
                distance = abs(start % 24 - hour_of_day)
                distance = min(distance, 24 - distance)
                total += recency * math.exp(-(distance / 4) ** 2) * (1.0 if block_busy == busy else 0.15) + 1e-12
                cumulative.append(total)
            self._weights[key] = cumulative
        return self._weights[key]

    def draw(self, rng: random.Random, hour_of_day: int, busy: bool) -> list:
        return rng.choices(self.blocks, cum_weights=self._cumulative(hour_of_day, busy))[0][1]


def busy_multiplier(rng: random.Random) -> float:
    """You may be busier or quieter than your recent past. Mean 1, so it widens the range without moving the pace."""
    return rng.lognormvariate(-BUSY_SIGMA ** 2 / 2, BUSY_SIGMA) if BUSY_SIGMA else 1.0


def play(rng: random.Random, sampler: Sampler, race: list, start: float, busy: bool, horizon: float) -> dict:
    """One simulated future. Returns {window: (time it hit 100% or None, used at the end)}."""
    state = {w['id']: {'used': w['used'], 'reset': w['reset'], 'hit': None} for w in race}
    multiplier = busy_multiplier(rng)
    now = start
    while now < horizon:
        block = sampler.draw(rng, int(now // 3600) % 24, busy)
        for values in block:
            if now >= horizon:
                break
            now += 3600
            for w in race:
                s = state[w['id']]
                if s['hit'] is not None:
                    continue
                amount = multiplier * (values.get(sampler.driver, 0.0) * w['ratio'] if w['ratio'] is not None else values.get(w['id'], 0.0))
                if w['session']:
                    if s['reset'] is not None and now > s['reset']:
                        s['used'], s['reset'] = 0.0, None
                    if amount > 0 and s['reset'] is None:
                        s['reset'] = now + SESSION_HOURS * 3600
                elif s['reset'] is not None and now > s['reset']:
                    continue  # survived to its reset
                s['used'] += amount
                if s['used'] >= 100:
                    s['hit'] = now - 3600 * (s['used'] - 100) / amount
                    s['used'] = 100.0
        busy = any(values.get(sampler.driver, 0.0) > 0 for values in block[-2:])
    return {key: (s['hit'], s['used']) for key, s in state.items()}


def choose_driver(windows: list, burn: dict) -> str | None:
    """The window everything else is measured against: the busiest general weekly window, else the busiest of any."""
    totals = {}
    for values in burn.values():
        for window, amount in values.items():
            totals[window] = totals.get(window, 0.0) + amount
    general = [w['id'] for w in windows if w.get('kind') == 'weekly' and not w.get('model') and not w.get('surface') and not w.get('gate') and w['id'] in totals]
    pool = general or list(totals)
    return max(pool, key=lambda window: totals[window]) if pool else None


def partner_of(window: dict, windows: list, driver: str) -> str:
    """The weekly window a 5-hour window draws on: same group label if there is one (Antigravity), else the driver."""
    group = window.get('label', '').split(' · ')[0]
    for other in windows:
        if other is not window and other.get('kind') == 'weekly' and other.get('label', '').split(' · ')[0] == group and not other.get('gate'):
            return other['id']
    return driver


def forecast_provider(provider: dict, samples: list, now: float, sims: int = SIMULATIONS, half_life: float = HALF_LIFE_DAYS, seed=None) -> dict | None:
    windows = provider.get('windows') if isinstance(provider, dict) else None
    if not windows or not samples:
        return None
    burn, capped = hourly_burn(samples)
    if len(burn) < MIN_HISTORY_HOURS:
        return {'status': 'thin', 'hours': len(burn)}
    driver = choose_driver(windows, burn)
    if driver is None:
        return {'status': 'thin', 'hours': len(burn)}
    now_hour = int(now // 3600)
    sampler = Sampler(burn, capped, driver, now_hour, half_life)
    if len(sampler.blocks) < 12:
        return {'status': 'thin', 'hours': len(burn)}
    used_by_id = {w['id']: w.get('usedPercent') for w in windows}
    race, out, unknown = [], [], []
    for w in windows:
        if w.get('gate') or (isinstance(w.get('usedPercent'), (int, float)) and w['usedPercent'] >= 100):
            out.append({'id': w['id'], 'label': w.get('label'), 'resetsAt': w.get('resetsAt')})
            continue
        if not isinstance(w.get('usedPercent'), (int, float)):
            continue
        ratio = None
        if w['id'] != driver:
            recent = sum(1 for hour in range(now_hour - RECENT_HOURS, now_hour) if w['id'] in burn.get(hour, {}) and hour not in capped.get(w['id'], ()))
            if recent < MIN_RECENT_HOURS:
                measured = exchange_rate(burn, capped, driver, w['id'])
                current = used_by_id.get(driver)
                if measured is not None:
                    ratio = measured
                elif isinstance(current, (int, float)) and current >= 5 and w['usedPercent'] > 0:
                    ratio = w['usedPercent'] / current
                elif isinstance(w.get('allowanceOfWeekly'), (int, float)) and w['allowanceOfWeekly'] > 0:
                    ratio = 100 / w['allowanceOfWeekly']
                else:
                    unknown.append(w.get('label'))
                    continue
        reset = to_epoch(w.get('resetsAt'))
        race.append({'id': w['id'], 'label': w.get('label'), 'kind': w.get('kind'), 'used': float(w['usedPercent']), 'session': w.get('kind') == 'current',
                     'reset': reset if reset is not None and reset > now else None, 'ratio': ratio})
    result = {'status': 'ok', 'days': round((samples[-1][0] - samples[0][0]) / 86400, 1), 'out': out, 'unknown': unknown, 'race': [], 'first': None, 'pNone': 1.0}
    weekly_resets = [w['reset'] for w in race if not w['session'] and w['reset'] is not None]
    horizon = max(weekly_resets) if weekly_resets else now + 7 * 86400
    if race and horizon > now:
        rng = random.Random(seed if seed is not None else f'{driver}:{now_hour}')  # steady within the hour, so the page doesn't jitter
        busy = sampler.is_busy(now_hour + 1)
        hits, ends, firsts, nobody = {w['id']: [] for w in race}, {w['id']: [] for w in race}, {w['id']: 0 for w in race}, 0
        for _ in range(sims):
            outcome = play(rng, sampler, race, now, busy, horizon)
            best = None
            for key, (hit, end) in outcome.items():
                ends[key].append(end)
                if hit is not None:
                    hits[key].append(hit)
                    if best is None or hit < outcome[best][0]:
                        best = key
            if best is None:
                nobody += 1
            else:
                firsts[best] += 1
        for w in race:
            times = sorted(hits[w['id']])
            row = {'id': w['id'], 'label': w['label'], 'kind': w['kind'], 'p': round(len(times) / sims, 3), 'pFirst': round(firsts[w['id']] / sims, 3),
                   'endMedian': round(statistics.median(ends[w['id']]), 1), 'resetsAt': to_iso(w['reset']) if w['reset'] else None}
            if times:
                row.update(medianAt=to_iso(times[len(times) // 2]), earlyAt=to_iso(times[len(times) // 10]), lateAt=to_iso(times[len(times) * 9 // 10]))
            result['race'].append(row)
        top = max(result['race'], key=lambda row: row['pFirst'])
        result['first'] = {'id': top['id'], 'label': top['label'], 'p': top['pFirst']} if top['pFirst'] > 0 else None
        result['pNone'] = round(nobody / sims, 3)
    for w in windows:  # how much of the week a full 5-hour window costs, once there is enough usage to say
        if w.get('kind') == 'current' and not w.get('gate'):
            partner = partner_of(w, windows, driver)
            rate = exchange_rate(burn, capped, w['id'], partner)
            if rate is not None:
                result.setdefault('exchange', []).append({'label': w.get('label'), 'weeklyPerWindow': round(rate * 100, 1)})
    return result
