#!/usr/bin/env python3
"""Tests for the forecast model and its history. Run: python3 -I collector/test_forecast.py"""
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backfill_history  # noqa: E402
import collect  # noqa: E402
import forecast as fc  # noqa: E402

NOW = 1794000000.0 - (1794000000.0 % 3600)
HOUR = 3600.0


def series(rates: dict, hours: int = 240) -> list:
    """Half-hourly samples that burn at constant hourly rates, emptying before each window would fill."""
    used, samples = {key: 0.0 for key in rates}, []
    for step in range(hours * 2):
        stamp = NOW - (hours * 2 - step) * HOUR / 2
        for key, rate in rates.items():
            used[key] += rate / 2
            if used[key] > 90:
                used[key] = 0.0
        samples.append((stamp, dict(used)))
    return samples


def weekly(wid, used, reset_hours=150, **extra):
    return {'id': wid, 'label': wid, 'kind': 'weekly', 'usedPercent': used, 'resetsAt': fc.to_iso(NOW + reset_hours * HOUR), **extra}


class Base(unittest.TestCase):
    def setUp(self):
        self.sigma, fc.BUSY_SIGMA = fc.BUSY_SIGMA, 0.0

    def tearDown(self):
        fc.BUSY_SIGMA = self.sigma


class BurnTests(Base):
    def test_diffs_resets_revisions_caps_and_gaps(self):
        t = NOW
        samples = [(t, {'w': 10.0}), (t + 1800, {'w': 12.0}), (t + 3600, {'w': 11.5}), (t + 5400, {'w': 13.0}),  # +2, revision ignored, +1.5
                   (t + 7200, {'w': 1.0}),                                                                        # a reset: 1 accrued since
                   (t + 90000, {'w': 40.0}),                                                                      # after a gap: unknown, not burn
                   (t + 90600, {'w': 100.0}), (t + 91200, {'w': 100.0})]
        burn, capped = fc.hourly_burn(samples)
        self.assertEqual(sum(values['w'] for values in burn.values()), 2 + 1.5 + 1 + 60)
        self.assertEqual(capped['w'], {int((t + 91200) // 3600)})

    def test_exchange_rate_waits_for_enough_usage(self):
        burn = {h: {'short': 5.0, 'long': 1.5} for h in range(10)}
        self.assertAlmostEqual(fc.exchange_rate(burn, {}, 'short', 'long'), 0.3)
        self.assertIsNone(fc.exchange_rate({h: {'short': 1.0, 'long': 1.0} for h in range(4)}, {}, 'short', 'long'))


class RaceTests(Base):
    def result(self, windows, rates, **kw):
        return fc.forecast_provider({'windows': windows}, series(rates), NOW, sims=60, seed=1, **kw)

    def test_steady_burn_hits_when_arithmetic_says(self):
        r = self.result([weekly('w', 50)], {'w': 10.0})
        row = r['race'][0]
        self.assertEqual((row['p'], row['pFirst'], r['pNone']), (1.0, 1.0, 0.0))
        self.assertLess(abs(fc.to_epoch(row['medianAt']) - (NOW + 5 * HOUR)), 3 * HOUR)
        self.assertEqual(r['first']['id'], 'w')

    def test_a_reset_that_comes_first_means_no_hit(self):
        r = self.result([weekly('w', 50, reset_hours=10)], {'w': 1.0})
        self.assertEqual((r['race'][0]['p'], r['pNone'], r['first']), (0.0, 1.0, None))
        self.assertLess(abs(r['race'][0]['endMedian'] - 60), 3)

    def test_a_fast_5_hour_window_beats_a_slow_week(self):
        five = {'id': 'five', 'label': 'five', 'kind': 'current', 'usedPercent': 0, 'resetsAt': None}
        r = self.result([five, weekly('week', 0)], {'five': 30.0, 'week': 1.0})
        self.assertEqual(r['first']['id'], 'five')
        self.assertEqual({row['id']: row['pFirst'] for row in r['race']}, {'five': 1.0, 'week': 0.0})

    def test_a_slow_5_hour_window_empties_and_the_week_wins(self):
        five = {'id': 'five', 'label': 'five', 'kind': 'current', 'usedPercent': 0, 'resetsAt': None}
        r = self.result([five, weekly('week', 0)], {'five': 15.0, 'week': 5.0})
        self.assertEqual(r['first']['id'], 'week')
        self.assertEqual({row['id']: row['p'] for row in r['race']}, {'five': 0.0, 'week': 1.0})

    def test_used_up_and_blocked_windows_sit_out(self):
        gate = weekly('astra', 100, gate=True, model='Astra')
        r = self.result([weekly('w', 50), weekly('fable', 100, model='Fable'), gate], {'w': 1.0})
        self.assertEqual([row['id'] for row in r['race']], ['w'])
        self.assertEqual({row['id'] for row in r['out']}, {'fable', 'astra'})

    def test_a_window_without_history_follows_the_week_or_stays_unknown(self):
        fable = weekly('fable', 0, model='Fable', allowanceOfWeekly=50.0)
        r = self.result([weekly('w', 10), fable], {'w': 2.0})
        row = {x['id']: x for x in r['race']}['fable']
        self.assertEqual(row['pFirst'], 1.0)  # 4% an hour, against 2% for the week
        self.assertLess(abs(fc.to_epoch(row['medianAt']) - (NOW + 25 * HOUR)), 3 * HOUR)
        r = self.result([weekly('w', 10), weekly('other', 0, model='Other')], {'w': 2.0})
        self.assertEqual(r['unknown'], ['other'])
        self.assertEqual([x['id'] for x in r['race']], ['w'])
        r = self.result([weekly('w', 20), weekly('other', 10, model='Other')], {'w': 2.0})  # this cycle's readings give a rate
        self.assertEqual({x['id'] for x in r['race']}, {'w', 'other'})

    def test_the_week_cost_of_a_5_hour_window_is_reported(self):
        five = {'id': 'five', 'label': 'five', 'kind': 'current', 'usedPercent': 0, 'resetsAt': None}
        r = self.result([five, weekly('week', 0)], {'five': 5.0, 'week': 1.5})
        # Burn in the sampling interval that contains a reset is lost, so this half-hourly series reads slightly high.
        self.assertEqual(r['exchange'][0]['label'], 'five')
        self.assertLess(abs(r['exchange'][0]['weeklyPerWindow'] - 30), 1.5)

    def test_too_little_history_says_so(self):
        r = fc.forecast_provider({'windows': [weekly('w', 5)]}, series({'w': 1.0}, hours=20), NOW)
        self.assertEqual(r['status'], 'thin')
        self.assertIsNone(fc.forecast_provider({'windows': []}, series({'w': 1.0}), NOW))
        self.assertIsNone(fc.forecast_provider({'windows': [weekly('w', 5)]}, [], NOW))

    def test_no_future_data_leaks_into_the_past(self):
        burn, capped = fc.hourly_burn(series({'w': 1.0}))
        sampler = fc.Sampler(burn, capped, 'w', int(NOW // 3600) - 100)
        self.assertTrue(all(start + fc.BLOCK_HOURS - 1 < int(NOW // 3600) - 100 for start, _, _ in sampler.blocks))

    def test_steady_within_the_hour(self):
        a = fc.forecast_provider({'windows': [weekly('w', 40)]}, series({'w': 0.5}), NOW, sims=60)
        b = fc.forecast_provider({'windows': [weekly('w', 40)]}, series({'w': 0.5}), NOW + 60, sims=60)
        self.assertEqual(a['race'][0]['endMedian'], b['race'][0]['endMedian'])

    def test_the_multiplier_keeps_the_mean(self):
        fc.BUSY_SIGMA, rng = 0.7, random.Random(1)
        values = [fc.busy_multiplier(rng) for _ in range(20000)]
        self.assertLess(abs(sum(values) / len(values) - 1), 0.03)


class HistoryTests(Base):
    PROVIDERS = {'claude': {'status': 'ok', 'windows': [weekly('seven_day', 52), weekly('astra', 100, gate=True)]},
                 'chatgpt': {'status': 'error', 'windows': [weekly('primary', 1)]}, 'gemini': {'status': 'not_connected'}}

    def test_only_reported_numbers_are_kept(self):
        row = fc.history_row('2026-11-06T00:00:00Z', self.PROVIDERS)
        self.assertEqual(row['u'], {'claude/seven_day': 52})
        self.assertIn('claude/seven_day', row['r'])

    def test_round_trip_skips_damage_other_providers_and_old_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'history.jsonl'
            fc.append_history(path, {'t': fc.to_iso(NOW - 60), 'u': {'claude/w': 5, 'gemini/x': 9}, 'r': {}})
            fc.append_history(path, {'t': fc.to_iso(NOW - 90 * 86400), 'u': {'claude/w': 1}, 'r': {}})
            with path.open('a') as handle:
                handle.write('not json\n{"t": "soon", "u": {"claude/w": 3}}\n')
            self.assertEqual(fc.load_history(path, 'claude', NOW), [(NOW - 60, {'w': 5.0})])
            self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')

    def test_a_run_records_and_forecasts_and_a_model_bug_costs_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'history.jsonl'
            for sample in series({'seven_day': 0.5}):
                fc.append_history(path, {'t': fc.to_iso(sample[0]), 'u': {f'claude/{k}': v for k, v in sample[1].items()}, 'r': {}})
            providers = json.loads(json.dumps(self.PROVIDERS))
            collect.record_and_forecast(fc.to_iso(NOW), providers, path)
            self.assertEqual(providers['claude']['forecast']['status'], 'ok')
            self.assertNotIn('forecast', providers['chatgpt'])
            original, fc.forecast_provider = fc.forecast_provider, lambda *a, **k: 1 / 0
            try:
                collect.record_and_forecast(fc.to_iso(NOW), providers := json.loads(json.dumps(self.PROVIDERS)), path)
            finally:
                fc.forecast_provider = original
            self.assertNotIn('forecast', providers['claude'])
            before = path.read_text()
            collect.record_and_forecast(fc.to_iso(NOW), {'claude': {'status': 'error'}}, path)
            self.assertEqual(path.read_text(), before)

    def test_journal_lines_become_rows(self):
        row = backfill_history.parse_line('2026-11-06T18:42:00+00:00 ip-1 python3[3086201]: claude: ok (Weekly · all models 51% used, Weekly · Fable 100% used) | chatgpt: not_connected (x) | gemini: ok (Gemini models · 5-hour window 2% used) | pushed')
        self.assertEqual(row['t'], '2026-11-06T18:42:00Z')
        self.assertEqual(row['u'], {'claude/seven_day': 51.0, 'claude/limit:weekly_scoped_fable': 100.0, 'gemini/gemini_models_5_hour_window': 2.0})
        self.assertIsNone(backfill_history.parse_line('2026-11-06T18:42:00+00:00 ip-1 systemd[1263]: Started.'))


if __name__ == '__main__':
    unittest.main(verbosity=1)
