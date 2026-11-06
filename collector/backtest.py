#!/usr/bin/env python3
"""Replay history: at each past hour, forecast the next 24 hours using only what was known then, and score it against
what happened and against simple rules. Usage: python3 -I collector/backtest.py [half-life days ...]"""
from __future__ import annotations

import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE))
import forecast as fc  # noqa: E402

HORIZON = 24
SERIES = (('claude', 'seven_day', 'Claude weekly, all models'), ('chatgpt', 'primary', 'ChatGPT weekly'))


def sample_burn(rng, sampler, window, start_hour, busy, hours, sims=200):
    totals = []
    for _ in range(sims):
        total, hour, state, left = 0.0, start_hour, busy, hours
        multiplier = fc.busy_multiplier(rng)
        while left > 0:
            block = sampler.draw(rng, hour % 24, state)
            for values in block[:left]:
                total += multiplier * values.get(window, 0.0)
            left -= fc.BLOCK_HOURS
            hour += fc.BLOCK_HOURS
            state = any(values.get(window, 0.0) > 0 for values in block[-2:])
        totals.append(total)
    totals.sort()
    return totals[len(totals) // 10], totals[len(totals) // 2], totals[len(totals) * 9 // 10]


def score(provider, window, half_life, samples):
    burn, capped = fc.hourly_burn(samples)
    hours = sorted(hour for hour in burn if window in burn[hour])
    first, last = hours[0] + 72, hours[-1] - HORIZON
    rng, rows = random.Random(1), []
    for hour in range(first, last + 1):
        future = [burn.get(h, {}).get(window) for h in range(hour, hour + HORIZON)]
        past = [burn.get(h, {}).get(window) for h in range(hour - 24, hour)]
        if None in future or None in past or any(h in capped.get(window, ()) for h in range(hour - 24, hour + HORIZON)):
            continue
        known = {h: values for h, values in burn.items() if h < hour}
        sampler = fc.Sampler(known, capped, window, hour, half_life)
        if len(sampler.blocks) < 12:
            continue
        low, mid, high = sample_burn(rng, sampler, window, hour, sampler.is_busy(hour), HORIZON)
        since_drop, total, span = hour - 1, 0.0, 0
        while since_drop in known and span < 168:  # week-so-far pace, the obvious rule of thumb
            total += known[since_drop].get(window, 0.0)
            span += 1
            since_drop -= 1
        rows.append(dict(actual=sum(future), low=low, mid=mid, high=high, last24=sum(past), pace=total / max(span, 1) * HORIZON))
    return rows


def report(label, rows):
    if not rows:
        print(f'{label}: no scorable hours')
        return
    n, busy = len(rows), [r for r in rows if r['actual'] >= 1]
    mae = lambda data, key: sum(abs(r[key] - r['actual']) for r in data) / max(len(data), 1)
    cover = lambda data: sum(r['low'] <= r['actual'] <= r['high'] for r in data) / max(len(data), 1)
    print(f"{label}: {n} hourly forecasts, {len(busy)} where the next day burned 1% or more")
    print(f"  mean error, next 24h burn   model {mae(rows, 'mid'):5.2f}   same as last 24h {mae(rows, 'last24'):5.2f}   7-day pace {mae(rows, 'pace'):5.2f}   (points)")
    print(f"  same, busy days only        model {mae(busy, 'mid'):5.2f}   same as last 24h {mae(busy, 'last24'):5.2f}   7-day pace {mae(busy, 'pace'):5.2f}")
    print(f"  80% range held the truth    all {cover(rows):.0%}   busy days only {cover(busy):.0%}")


def replay_race(samples, provider, window, label):
    """P(runs out before its reset) as each past week went on, against what happened."""
    burn, _ = fc.hourly_burn(samples)
    series = [(t, values[window]) for t, values in samples if window in values]
    resets = [b[0] for a, b in zip(series, series[1:]) if b[1] < a[1] - 1 and b[1] <= a[1] * 0.5]
    print(f'{label}: resets seen at', [fc.to_iso(t)[:16] for t in resets])
    for start, end in zip(resets, resets[1:] + [series[-1][0] + 1]):
        row, peak = [], max(u for t, u in series if start <= t < end)
        complete = end <= series[-1][0]
        boundary = start + 7 * 86400 if not complete else end
        for offset in (1, 2, 3, 4, 5, 6):
            now = start + offset * 86400
            if now >= min(end, series[-1][0]):
                break
            used = [u for t, u in series if t <= now][-1]
            known = [(t, v) for t, v in samples if t <= now]
            result = fc.forecast_provider({'windows': [{'id': window, 'label': label, 'kind': 'weekly', 'usedPercent': used, 'resetsAt': fc.to_iso(boundary)}]}, known, now, sims=300, seed=offset)
            row.append(f"d{offset}:{used:g}%/{result['race'][0]['p']:.0%}" if result and result.get('status') == 'ok' and result['race'] else f'd{offset}:{used:g}%/thin')
        print(f"  week from {fc.to_iso(start)[:10]}: peak {peak:g}%{'' if complete else ' so far'}.  day:used/P(runs out)  " + '  '.join(row))


def main():
    path = HERE / 'history.jsonl'
    now = time.time()
    lives = [float(x) for x in sys.argv[1:]] or [fc.HALF_LIFE_DAYS]
    for provider, window, label in SERIES:
        samples = fc.load_history(path, provider, now)
        for half_life in lives:
            report(f'{label}, half-life {half_life:g} days', score(provider, window, half_life, samples))
    claude = fc.load_history(path, 'claude', now)
    burn, capped = fc.hourly_burn(claude)
    rate = fc.exchange_rate(burn, capped, 'five_hour', 'seven_day')
    print(f'\nClaude: a full 5-hour window cost {rate * 100:.1f}% of the week' if rate else '\nClaude: no 5-hour exchange rate yet')
    hours = sorted(burn)
    worst = max((sum(burn.get(h + i, {}).get('seven_day', 0.0) for i in range(5)), h) for h in hours)
    print(f'Claude: busiest 5 hours on record burned {worst[0]:g}% of the week, starting {fc.to_iso(worst[1] * 3600)[:16]}')
    five = [v['five_hour'] for _, v in claude if 'five_hour' in v]
    print(f'Claude: 5-hour window peaked at {max(five):g}% across {len(five)} samples' if five else 'Claude: no 5-hour samples')
    print()
    replay_race(claude, 'claude', 'seven_day', 'Claude weekly')


if __name__ == '__main__':
    main()
