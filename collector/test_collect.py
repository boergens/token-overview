#!/usr/bin/env python3
"""Unit tests for the collector's normalization. Run: python3 -I collector/test_collect.py"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect  # noqa: E402


class ClaudeTests(unittest.TestCase):
    def test_windows_are_ordered_labeled_and_clamped(self):
        data = {'seven_day_opus': {'utilization': 5, 'resets_at': '2026-10-22T10:00:00.000000+00:00'},
                'five_hour': {'utilization': 123.4, 'resets_at': '2026-10-19T20:00:00Z'},
                'seven_day': {'utilization': 12.345, 'resets_at': None},
                'seven_day_sonnet': None,
                'extra_usage': {'is_enabled': False}}
        result = collect.normalize_claude(data, 'max')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['plan'], 'max')
        self.assertEqual([w['id'] for w in result['windows']], ['five_hour', 'seven_day', 'seven_day_opus'])
        self.assertEqual(result['windows'][0], {'id': 'five_hour', 'label': '5-hour window', 'kind': 'current', 'usedPercent': 100.0, 'resetsAt': '2026-10-19T20:00:00Z'})
        self.assertEqual(result['windows'][1]['usedPercent'], 12.3)
        self.assertIsNone(result['windows'][1]['resetsAt'])
        self.assertEqual(result['windows'][2]['resetsAt'], '2026-10-22T10:00:00Z')
        self.assertNotIn('extra', result)

    def test_extra_usage_is_reported_when_enabled(self):
        result = collect.normalize_claude({'five_hour': {'utilization': 1, 'resets_at': None}, 'extra_usage': {'is_enabled': True, 'utilization': 40, 'monthly_limit': 50, 'used_credits': 20}})
        self.assertEqual(result['extra'], {'enabled': True, 'usedPercent': 40.0, 'disabledReason': None, 'monthlyLimit': 50.0, 'usedCredits': 20.0, 'currency': 'USD', 'decimalPlaces': 2, 'spendLimitReached': False})

    def test_no_windows_is_an_error_not_a_zero(self):
        with self.assertRaises(collect.ProviderError):
            collect.normalize_claude({'five_hour': {'utilization': 'lots'}})

    def test_limits_list_adds_the_fable_cap_and_the_surface_breakdown(self):
        # Shape of a real answer on 2026-11-06.
        data = {'five_hour': None, 'seven_day_opus': None,
                'seven_day': {'utilization': 51.0, 'resets_at': '2026-11-11T03:00:00.260369+00:00'},
                'limits': [{'kind': 'weekly_all', 'group': 'weekly', 'percent': 51, 'severity': 'normal', 'resets_at': '2026-11-11T03:00:00.260369+00:00', 'scope': None, 'is_active': False},
                           {'kind': 'weekly_scoped', 'group': 'weekly', 'percent': 100, 'severity': 'critical', 'resets_at': '2026-11-11T03:00:00.260558+00:00',
                            'scope': {'model': {'id': None, 'display_name': 'Fable'}, 'surface': None}, 'is_active': True}],
                'seven_day_breakdown': {'as_of': '2026-11-06T18:27:24.621251+00:00', 'window_started_at': '2026-11-04T03:00:00.260369+00:00',
                                        'rows': [{'key': 'claude_code', 'display_name': 'Claude Code', 'percent': 84}, {'key': 'chat', 'display_name': 'Chats', 'percent': 6},
                                                 {'key': 'cowork', 'display_name': 'Cowork', 'percent': 10}, {'key': 'other', 'display_name': 'Other', 'percent': 0}]}}
        result = collect.normalize_claude(data, 'max')
        with_share = collect.normalize_claude({**data, 'weekly_scoped_shares': [{'limit_index': 1, 'used_percent_of_weekly': 50, 'allowance_percent_of_weekly': 50}]}, 'max')
        self.assertEqual(with_share['windows'][1]['allowanceOfWeekly'], 50.0)
        self.assertEqual(result['windows'], [
            {'id': 'seven_day', 'label': 'Weekly · all models', 'kind': 'weekly', 'usedPercent': 51.0, 'resetsAt': '2026-11-11T03:00:00Z'},
            {'id': 'limit:weekly_scoped_fable', 'label': 'Weekly · Fable', 'kind': 'weekly', 'usedPercent': 100.0, 'resetsAt': '2026-11-11T03:00:00Z', 'model': 'Fable'}])
        self.assertEqual(result['breakdown'], {'windowStartedAt': '2026-11-04T03:00:00Z', 'rows': [
            {'name': 'Claude Code', 'percent': 84.0}, {'name': 'Cowork', 'percent': 10.0}, {'name': 'Chats', 'percent': 6.0}, {'name': 'Other', 'percent': 0.0}]})

    def test_limits_list_alone_is_enough_and_never_duplicates_a_classic_window(self):
        data = {'seven_day_opus': {'utilization': 5, 'resets_at': None},
                'limits': [{'kind': 'session', 'group': 'session', 'percent': 30, 'resets_at': '2026-11-06T20:00:00Z', 'scope': None},
                           {'kind': 'weekly_scoped', 'group': 'weekly', 'percent': 5, 'resets_at': None, 'scope': {'model': {'display_name': 'Opus'}}},
                           {'kind': 'weekly_scoped', 'group': 'weekly', 'percent': 40, 'resets_at': None, 'scope': {'model': None, 'surface': 'Cowork'}},
                           {'kind': 'weekly_all', 'percent': 'n/a'}, {'percent': 3}, 'junk']}
        result = collect.normalize_claude(data)
        self.assertEqual([(w['id'], w['label'], w['kind'], w['usedPercent']) for w in result['windows']], [
            ('seven_day_opus', 'Weekly · Opus', 'weekly', 5.0),
            ('five_hour', '5-hour window', 'current', 30.0),
            ('limit:weekly_scoped_cowork', 'Weekly · Cowork', 'weekly', 40.0)])
        self.assertEqual(result['windows'][0]['model'], 'Opus')
        self.assertEqual(result['windows'][2]['surface'], 'Cowork')
        self.assertNotIn('model', result['windows'][1])
        only_limits = collect.normalize_claude({'limits': [{'kind': 'weekly_scoped', 'percent': 100, 'scope': {'model': {'display_name': 'Fable'}}}]})
        self.assertEqual(only_limits['windows'][0]['label'], 'Weekly · Fable')
        self.assertNotIn('breakdown', only_limits)


class ChatGPTTests(unittest.TestCase):
    def test_primary_and_secondary_windows(self):
        data = {'plan_type': 'pro', 'rate_limit': {'allowed': True, 'limit_reached': False,
                'primary_window': {'used_percent': 4, 'limit_window_seconds': 604800, 'reset_after_seconds': 100, 'reset_at': 1792939933},
                'secondary_window': {'used_percent': 55.56, 'limit_window_seconds': 18000, 'reset_at': 1792439933}},
                'credits': {'has_credits': False, 'unlimited': False, 'balance': '0'}}
        result = collect.normalize_chatgpt(data)
        self.assertEqual(result['plan'], 'pro')
        self.assertEqual([w['kind'] for w in result['windows']], ['weekly', 'current'])
        self.assertEqual(result['windows'][0]['label'], 'Weekly window')
        self.assertEqual(result['windows'][0]['resetsAt'], collect.now_iso(1792939933))
        self.assertEqual(result['windows'][1], {'id': 'secondary', 'label': '5-hour window', 'kind': 'current', 'usedPercent': 55.6, 'windowMinutes': 300.0, 'resetsAt': collect.now_iso(1792439933)})
        self.assertEqual([(r['id'], r['value']) for r in result['credits']], [('chatgpt-credits', '0 credits')])
        self.assertEqual(collect.merge_plan_credits(collect.normalize_chatgpt({'rate_limit': data['rate_limit']}), {'credits': [{'id': 'x'}]})['credits'], [{'id': 'x', 'source': 'checked'}])

    def test_session_log_shape_and_reset_after_fallback(self):
        data = {'plan_type': 'promax', 'primary': {'used_percent': 4.0, 'window_minutes': 10080, 'resets_at': 1792939933}, 'secondary': None}
        result = collect.normalize_chatgpt(data)
        self.assertEqual(len(result['windows']), 1)
        self.assertEqual(result['windows'][0]['kind'], 'weekly')
        self.assertEqual(result['windows'][0]['windowMinutes'], 10080.0)
        before = collect.time.time()
        result = collect.normalize_chatgpt({'rate_limit': {'primary_window': {'used_percent': 10, 'limit_window_seconds': 3600, 'reset_after_seconds': 600}}})
        self.assertEqual(result['windows'][0]['kind'], 'current')
        self.assertGreaterEqual(collect.datetime.fromisoformat(result['windows'][0]['resetsAt'].replace('Z', '+00:00')).timestamp(), before + 599)

    def test_additional_limits_and_missing_windows(self):
        data = {'rate_limit': {'primary_window': {'used_percent': 1, 'limit_window_seconds': 604800}},
                'additional_rate_limits': [{'limit_name': 'Deep research', 'rate_limit': {'primary_window': {'used_percent': 20, 'limit_window_seconds': 2592000}}}]}
        result = collect.normalize_chatgpt(data)
        self.assertEqual(result['windows'][1]['label'], 'Deep research · 30-day window')
        with self.assertRaises(collect.ProviderError):
            collect.normalize_chatgpt({'rate_limit': {'primary_window': None}})

    def test_model_usage_gates(self):
        base = {'plan_type': 'promax', 'rate_limit': {'primary_window': {'used_percent': 77, 'limit_window_seconds': 604800, 'reset_at': 1794082932}, 'secondary_window': None}}
        # A real answer on 2026-11-06: Astra available, so it is listed but adds no window.
        result = collect.normalize_chatgpt({**base, 'model_usage': {'gpt-6-astra': {'available': True, 'available_at': None, 'credits_would_enable': False}}})
        self.assertEqual(len(result['windows']), 1)
        self.assertEqual(result['models'], [{'id': 'gpt-6-astra', 'name': 'GPT-6 Astra', 'available': True, 'availableAt': None, 'creditsWouldEnable': False}])
        # Blocked until a known time: a used-up window scoped to that model.
        result = collect.normalize_chatgpt({**base, 'model_usage': {'gpt-6-astra': {'available': False, 'available_at': 1794082932, 'credits_would_enable': True},
                                                                    'gpt-6.1-sol': {'available': False, 'available_at': None}, 'broken': {'available': 'maybe'}, 'x': None}})
        self.assertEqual(result['windows'][1], {'id': 'model:gpt-6-astra', 'label': 'GPT-6 Astra', 'kind': 'weekly', 'usedPercent': 100.0, 'resetsAt': collect.now_iso(1794082932), 'model': 'GPT-6 Astra', 'gate': True})
        self.assertEqual(len(result['windows']), 2)
        self.assertEqual([(m['name'], m['available'], m['creditsWouldEnable']) for m in result['models']], [('GPT-6 Astra', False, True), ('GPT-6.1 Sol', False, False)])
        self.assertNotIn('models', collect.normalize_chatgpt(base))
        self.assertEqual(collect.model_name('o3-mini'), 'O3 Mini')

    def test_account_id_from_id_token(self):
        import base64
        claims = base64.urlsafe_b64encode(json.dumps({'https://api.openai.com/auth': {'chatgpt_account_id': 'acct-1'}}).encode()).decode().rstrip('=')
        self.assertEqual(collect.account_from_id_token(f'h.{claims}.s'), 'acct-1')
        self.assertIsNone(collect.account_from_id_token('garbage'))


class CreditTests(unittest.TestCase):
    def test_extra_usage_stays_visible_when_it_runs_out(self):
        # Shape of a real answer on 2026-11-06.
        extra = {'is_enabled': False, 'monthly_limit': None, 'used_credits': 4784.0, 'utilization': None, 'currency': 'USD', 'decimal_places': 2,
                 'disabled_reason': 'out_of_credits', 'user_disabled': False, 'spend_limit_reached': False}
        result = collect.normalize_claude({'seven_day': {'utilization': 51, 'resets_at': None}, 'extra_usage': extra})
        self.assertEqual(result['extra']['enabled'], False)
        self.assertEqual(result['extra']['disabledReason'], 'out_of_credits')
        self.assertEqual(result['credits'], [{'id': 'usage-credits', 'label': 'Usage credits', 'value': 'Out of credits',
                                              'detail': '$47.84 used so far. Requests past a plan limit stop until the limit resets or you buy more.',
                                              'state': 'empty', 'source': 'live', 'url': 'https://claude.ai/settings/billing'}])
        self.assertEqual(collect.claude_credit_rows({'is_enabled': True, 'used_credits': 1263})[0]['detail'], '$12.63 used so far. Pay-as-you-go past your plan limits.')
        self.assertEqual(collect.claude_credit_rows({'is_enabled': False}), [])
        self.assertEqual(collect.claude_credit_rows(None), [])

    def test_chatgpt_credits_and_limit_resets(self):
        # Shape of a real answer on 2026-11-06.
        rows = collect.chatgpt_credit_rows({'credits': {'has_credits': False, 'unlimited': False, 'balance': '0'}, 'rate_limit_reset_credits': {'available_count': 3, 'applicable_available_count': 0}})
        self.assertEqual([(r['id'], r['value'], r['state']) for r in rows], [('chatgpt-credits', '0 credits', 'empty'), ('limit-resets', '3 available', 'ok')])
        self.assertEqual(rows[1]['detail'], '0 apply right now. Run /usage in Codex to use one.')
        self.assertEqual(collect.chatgpt_credit_rows({'credits': {'unlimited': True}})[0]['value'], 'Unlimited')
        self.assertEqual(collect.chatgpt_credit_rows({'credits': {'balance': True}, 'rate_limit_reset_credits': {'available_count': 'many'}}), [])

    def test_agy_credits(self):
        rows = collect.agy_credit_rows('Remaining credits\t0\n')
        self.assertEqual((rows[0]['value'], rows[0]['state']), ('0', 'empty'))
        self.assertIn('not enabled', rows[0]['detail'])
        rows = collect.agy_credit_rows('noise\nRemaining credits\t25,000\n')
        self.assertEqual((rows[0]['value'], rows[0]['state'], rows[0]['detail']), ('25,000', 'ok', ''))
        self.assertEqual(collect.agy_credit_rows('nothing here'), [])

    def test_plan_name_comes_from_the_provider_and_failure_is_harmless(self):
        original = collect.get_json
        try:
            collect.get_json = lambda url, headers: {'organization': {'plan_display_name': 'Ultra', 'organization_type': 'claude_max'}}
            self.assertEqual(collect.claude_plan_name({}), 'Ultra')
            def broken(url, headers):
                raise collect.ProviderError('down')
            collect.get_json = broken
            self.assertIsNone(collect.claude_plan_name({}))
        finally:
            collect.get_json = original

    def test_hand_checked_rows_are_marked_and_survive_a_provider_failure(self):
        static = {'plan': 'AI Ultra', 'credits': [{'id': 'api-plan', 'label': 'L', 'value': 'V'}, 'junk']}
        failed = collect.merge_plan_credits({'status': 'error', 'message': 'x'}, static)
        self.assertEqual(failed['credits'], [{'id': 'api-plan', 'label': 'L', 'value': 'V', 'source': 'checked'}])
        self.assertEqual(failed['plan'], 'AI Ultra')
        live = collect.merge_plan_credits({'status': 'ok', 'plan': 'Ultra', 'credits': [{'id': 'a'}]}, static)
        self.assertEqual([r['id'] for r in live['credits']], ['a', 'api-plan'])
        self.assertEqual(live['plan'], 'Ultra')
        self.assertEqual(collect.merge_plan_credits({'status': 'ok'}, None), {'status': 'ok'})
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(collect.load_plan_credits(Path(empty) / 'missing.json'), {})

    def test_the_plan_credits_files_are_well_formed(self):
        example = collect.load_plan_credits(collect.HERE / 'plan-credits.example.json')
        self.assertEqual(set(example) - {'_note'}, {'claude', 'chatgpt', 'gemini'})
        for source in (example, collect.load_plan_credits()):  # your own copy, if there is one
            for name in set(source) - {'_note'}:
                for row in source[name]['credits']:
                    self.assertEqual(row['id'], 'api-plan')
                    self.assertTrue(row['url'].startswith('https://'))
                    self.assertRegex(row['checkedAt'], r'^\d{4}-\d{2}-\d{2}$')
                    self.assertLessEqual(len(row['detail']), 300)


class DeploymentTests(unittest.TestCase):
    def test_the_kv_namespace_comes_from_the_private_config(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'wrangler.toml'
            path.write_text('name = "x"\n[[kv_namespaces]]\nbinding = "OTHER"\nid = "no"\n[[kv_namespaces]]\nbinding = "LIVE"\nid = "abc"\n')
            self.assertEqual(collect.kv_namespace_id(path), 'abc')
            path.write_text('name = "x"\n')
            self.assertIsNone(collect.kv_namespace_id(path))
            path.write_text('not toml [')
            self.assertIsNone(collect.kv_namespace_id(path))
            self.assertIsNone(collect.kv_namespace_id(Path(folder) / 'missing.toml'))

    def test_the_example_config_has_a_live_namespace(self):
        self.assertEqual(collect.kv_namespace_id(collect.PROJECT / 'wrangler.toml.example'), 'your-kv-namespace-id')


class GeminiTests(unittest.TestCase):
    SAMPLE = ('Gemini Models\tWeekly Limit Remaining\t98%\t2026-10-24T14:49:27Z\n'
              'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-19T23:05:05Z\n'
              'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-26T18:05:05Z\n'
              'Claude and GPT models\tFive Hour Limit Remaining\t87.5%\t2026-10-19T23:05:05Z\n')

    def test_agy_table_becomes_windows_with_gemini_first(self):
        result = collect.normalize_agy(self.SAMPLE)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual([(w['id'], w['kind'], w['usedPercent']) for w in result['windows']], [
            ('gemini_models_5_hour_window', 'current', 0.0), ('gemini_models_weekly_window', 'weekly', 2.0),
            ('claude_and_gpt_models_5_hour_window', 'current', 12.5), ('claude_and_gpt_models_weekly_window', 'weekly', 0.0)])
        self.assertEqual(result['windows'][1]['label'], 'Gemini models · Weekly window')
        self.assertEqual(result['windows'][1]['resetsAt'], '2026-10-24T14:49:27Z')
        self.assertEqual(result['windows'][2]['label'], 'Claude and GPT models (Antigravity) · 5-hour window')
        self.assertNotIn('_gemini', result['windows'][0])

    def test_noise_is_ignored_and_empty_output_is_an_error(self):
        result = collect.normalize_agy('Welcome to agy\n' + self.SAMPLE.splitlines()[0] + '\nbye\n')
        self.assertEqual(len(result['windows']), 1)
        with self.assertRaises(collect.ProviderError):
            collect.normalize_agy('nothing here')


class AssemblyTests(unittest.TestCase):
    def test_missing_sign_ins_are_not_connected_without_network(self):
        with tempfile.TemporaryDirectory() as empty:
            os.environ['TOKEN_OVERVIEW_HOME'] = empty
            original = collect.gemini
            collect.gemini = lambda: collect.not_connected('agy stubbed out for the test')
            collect.PROVIDERS = tuple((name, collect.gemini if name == 'gemini' else fetch) for name, fetch in collect.PROVIDERS)
            try:
                payload = collect.collect(history=Path(empty) / 'history.jsonl')
            finally:
                del os.environ['TOKEN_OVERVIEW_HOME']
                collect.gemini = original
                collect.PROVIDERS = tuple((name, original if name == 'gemini' else fetch) for name, fetch in collect.PROVIDERS)
        self.assertEqual({k: v['status'] for k, v in payload['providers'].items()}, {'claude': 'not_connected', 'chatgpt': 'not_connected', 'gemini': 'not_connected'})
        self.assertTrue(payload['collectedAt'].endswith('Z'))

    def test_public_copy_drops_raw_answers(self):
        payload = {'version': 1, 'collectedAt': 'x', 'providers': {'claude': {'status': 'ok', 'windows': [], 'raw': {'secret-ish': 1}}}}
        self.assertNotIn('raw', collect.public_copy(payload)['providers']['claude'])
        self.assertIn('raw', payload['providers']['claude'])

    def test_time_parsing(self):
        self.assertEqual(collect.to_iso('2026-10-19T12:00:00.123+02:00'), '2026-10-19T10:00:00Z')
        self.assertEqual(collect.to_iso(1792939933000), collect.to_iso(1792939933))
        self.assertIsNone(collect.to_iso('soon'))
        self.assertIsNone(collect.to_iso(True))


if __name__ == '__main__':
    unittest.main(verbosity=1)
