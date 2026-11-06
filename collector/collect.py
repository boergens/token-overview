#!/usr/bin/env python3
"""Collect what is left of the Claude and ChatGPT allowances and publish it to the dashboard.

Sources (read-only; the same calls the CLIs make for their own /usage and /status screens):
  * Claude   the Claude Code sign-in in ~/.claude/.credentials.json -> https://api.anthropic.com/api/oauth/usage
  * ChatGPT  the Codex sign-in in ~/.codex/auth.json               -> https://chatgpt.com/backend-api/wham/usage
  * Gemini   the agy sign-in (Google Antigravity CLI): `agy --print /usage` and `/credits` print quota and AI credits.
  * Credits with no trustworthy live source come from plan-credits.json, checked by hand and dated.

The sign-in tokens are only ever sent to their own provider, in the Authorization header.
What gets published (Cloudflare KV, key "live") is percentages, reset times, plan names and
timestamps. The local copy collector/live.json additionally keeps each provider's raw answer
(no tokens in there) so the parser can be checked against reality.

Usage:  collect.py            collect, save the local copy, push to KV
        collect.py --no-push  collect and save only
        collect.py --print    also print the published payload
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
sys.path.append(str(HERE))  # -I leaves the script's folder off the path; appended so the standard library still wins
import forecast  # noqa: E402

LOCAL_COPY = HERE / 'live.json'
PLAN_CREDITS = HERE / 'plan-credits.json'
HISTORY = HERE / 'history.jsonl'
KV_KEY = 'live'
USER_AGENT = 'personal-token-overview-collector/1.0'
TIMEOUT = 20
CLAUDE_OAUTH = 'https://api.anthropic.com/api/oauth'
CLAUDE_USAGE_URL = f'{CLAUDE_OAUTH}/usage'
CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'


class ProviderError(Exception):
    """A provider problem whose message is safe to publish (no bodies, no tokens)."""


def home() -> Path:
    return Path(os.environ.get('TOKEN_OVERVIEW_HOME') or Path.home())


def now_iso(seconds: float | None = None) -> str:
    stamp = datetime.fromtimestamp(time.time() if seconds is None else seconds, timezone.utc)
    return stamp.replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def to_iso(value) -> str | None:
    """Accept ISO-8601 strings or epoch seconds/milliseconds; return ISO-8601 UTC or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return now_iso(value / 1000 if value > 1e11 else value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    return None


def percent(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    return round(max(0.0, min(100.0, float(value))), 1)


def positive_number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value <= 0:
        return None
    return float(value)


def get_json(url: str, headers: dict) -> dict:
    request = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': USER_AGENT, **headers})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise ProviderError(f'The sign-in was rejected (HTTP {error.code}). Open the CLI once so it refreshes its token.') from None
        raise ProviderError(f'The provider answered HTTP {error.code}.') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ProviderError('The provider could not be reached.') from None
    try:
        data = json.loads(body)
    except ValueError:
        raise ProviderError('The provider answered with something that is not JSON.') from None
    if not isinstance(data, dict):
        raise ProviderError('The provider answered with an unexpected shape.')
    return data


def not_connected(message: str) -> dict:
    return {'status': 'not_connected', 'message': message}


# --- Claude -------------------------------------------------------------------------------------

# Classic top-level windows: id -> (label, kind, model scope, surface scope).
CLAUDE_WINDOWS = {
    'five_hour': ('5-hour window', 'current', None, None),
    'seven_day': ('Weekly · all models', 'weekly', None, None),
    'seven_day_opus': ('Weekly · Opus', 'weekly', 'Opus', None),
    'seven_day_sonnet': ('Weekly · Sonnet', 'weekly', 'Sonnet', None),
    'seven_day_oauth_apps': ('Weekly · connected apps', 'weekly', None, 'connected apps'),
    'seven_day_cowork': ('Weekly · Cowork', 'weekly', None, 'Cowork'),
}
# Unscoped kinds in the newer `limits` list that duplicate a classic window.
CLAUDE_LIMIT_KINDS = {'session': 'five_hour', 'weekly_all': 'seven_day'}


def claude_window(wid, label, kind, used, resets, model=None, surface=None) -> dict:
    window = {'id': wid, 'label': label, 'kind': kind, 'usedPercent': used, 'resetsAt': resets}
    if model:
        window['model'] = model
    if surface:
        window['surface'] = surface
    return window


def scope_names(scope) -> tuple:
    """(model, surface) display names from a `limits[].scope` object such as {"model": {"display_name": "Fable"}}."""
    names = []
    for key in ('model', 'surface'):
        value = scope.get(key) if isinstance(scope, dict) else None
        if isinstance(value, dict):
            value = value.get('display_name') or value.get('id')
        names.append(value.strip()[:40] if isinstance(value, str) and value.strip() else None)
    return names[0], names[1]


def claude_limits(limits, existing: list, scoped_shares=None) -> list:
    """Windows from the `limits` list that the classic fields don't carry, e.g. Max's separate weekly Fable limit
    (kind "weekly_scoped", scope.model.display_name "Fable"), which appears nowhere else in the answer."""
    if not isinstance(limits, list):
        return []
    ids, labels, found = {w['id'] for w in existing}, {w['label'] for w in existing}, []
    shares = {share.get('limit_index'): percent(share.get('allowance_percent_of_weekly')) for share in scoped_shares if isinstance(share, dict)} if isinstance(scoped_shares, list) else {}
    for index, entry in enumerate(limits):
        if not isinstance(entry, dict) or not isinstance(entry.get('kind'), str) or not entry['kind']:
            continue
        used = percent(entry.get('percent'))
        if used is None:
            continue
        kind_name, group = entry['kind'], entry.get('group') if isinstance(entry.get('group'), str) else ''
        model, surface = scope_names(entry.get('scope'))
        kind = 'current' if group == 'session' or 'session' in kind_name or 'hour' in kind_name else 'weekly'
        if kind_name in CLAUDE_LIMIT_KINDS and not model and not surface:
            wid = CLAUDE_LIMIT_KINDS[kind_name]
            label = CLAUDE_WINDOWS[wid][0]
        else:
            names = [name for name in (model, surface) if name]
            prefix = '5-hour' if kind == 'current' else 'Weekly'
            label = f"{prefix} · {' · '.join(names)}" if names else f"{prefix} · {kind_name.replace('_', ' ')}"
            wid = 'limit:' + re.sub(r'[^a-z0-9]+', '_', ' '.join([kind_name, *names]).lower()).strip('_')
        if wid in ids or label in labels:
            continue
        ids.add(wid)
        labels.add(label)
        window = claude_window(wid, label, kind, used, to_iso(entry.get('resets_at')), model, surface)
        allowance = shares.get(index)
        if allowance:
            window['allowanceOfWeekly'] = allowance
        found.append(window)
    return found


def money_text(minor, places, currency='USD') -> str:
    symbol = '$' if currency == 'USD' else f'{currency} '
    return f'{symbol}{minor / 10 ** places:,.2f}'


def claude_credit_rows(extra) -> list:
    if not isinstance(extra, dict):
        return []
    reason = extra.get('disabled_reason') if isinstance(extra.get('disabled_reason'), str) else None
    if extra.get('is_enabled'):
        value, state, detail = 'On', 'ok', 'Pay-as-you-go past your plan limits.'
    elif reason == 'out_of_credits':
        value, state, detail = 'Out of credits', 'empty', 'Requests past a plan limit stop until the limit resets or you buy more.'
    elif reason:
        value, state, detail = 'Off', 'unknown', ''
    else:
        return []
    used = extra.get('used_credits')
    if isinstance(used, (int, float)) and not isinstance(used, bool):
        places = extra.get('decimal_places') if isinstance(extra.get('decimal_places'), int) and not isinstance(extra.get('decimal_places'), bool) else 2
        currency = extra.get('currency') if isinstance(extra.get('currency'), str) else 'USD'
        detail = f'{money_text(used, places, currency)} used so far. {detail}'.strip()
    return [{'id': 'usage-credits', 'label': 'Usage credits', 'value': value, 'detail': detail, 'state': state, 'source': 'live', 'url': 'https://claude.ai/settings/billing'}]


def normalize_claude(data: dict, plan: str | None = None) -> dict:
    windows = []
    for key, value in data.items():
        if not isinstance(value, dict):
            continue
        used = percent(value.get('utilization'))
        if used is None:
            continue
        label, kind, model, surface = CLAUDE_WINDOWS.get(key, (key.replace('_', ' ').capitalize(), 'current' if 'hour' in key else 'weekly', None, None))
        windows.append(claude_window(key, label, kind, used, to_iso(value.get('resets_at')), model, surface))
    order = list(CLAUDE_WINDOWS)
    windows.sort(key=lambda w: order.index(w['id']) if w['id'] in order else len(order))
    windows.extend(claude_limits(data.get('limits'), windows, data.get('weekly_scoped_shares')))
    if not windows:
        raise ProviderError('The usage report contained no usage windows.')
    result = {'status': 'ok', 'plan': plan, 'source': 'Claude Code sign-in', 'windows': windows}
    breakdown = data.get('seven_day_breakdown')
    if isinstance(breakdown, dict) and isinstance(breakdown.get('rows'), list):
        rows = []
        for row in breakdown['rows']:
            if not isinstance(row, dict):
                continue
            name, share = row.get('display_name') or row.get('key'), percent(row.get('percent'))
            if isinstance(name, str) and name.strip() and share is not None:
                rows.append({'name': name.strip()[:40], 'percent': share})
        if rows:
            # Shares of this week's use by surface (Claude Code, Chats, Cowork, ...), not shares of the limit.
            rows.sort(key=lambda row: -row['percent'])
            result['breakdown'] = {'windowStartedAt': to_iso(breakdown.get('window_started_at')), 'rows': rows}
    extra = data.get('extra_usage')
    if isinstance(extra, dict) and (extra.get('is_enabled') or extra.get('disabled_reason')):
        money = lambda v: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        result['extra'] = {'enabled': bool(extra.get('is_enabled')), 'usedPercent': percent(extra.get('utilization')),
                           'disabledReason': extra.get('disabled_reason') if isinstance(extra.get('disabled_reason'), str) else None,
                           'monthlyLimit': money(extra.get('monthly_limit')), 'usedCredits': money(extra.get('used_credits')),
                           'currency': extra.get('currency') if isinstance(extra.get('currency'), str) else 'USD',
                           'decimalPlaces': extra.get('decimal_places') if isinstance(extra.get('decimal_places'), int) and not isinstance(extra.get('decimal_places'), bool) else 2,
                           'spendLimitReached': bool(extra.get('spend_limit_reached'))}
    rows = claude_credit_rows(extra)
    if rows:
        result['credits'] = rows
    return result


def claude_plan_name(headers: dict) -> str | None:
    """The plan as the provider names it. The sign-in file's subscriptionType lags: it still said "max" on an Ultra plan."""
    try:
        org = get_json(f'{CLAUDE_OAUTH}/profile', headers).get('organization')
    except ProviderError:
        return None
    name = org.get('plan_display_name') if isinstance(org, dict) else None
    return name.strip() if isinstance(name, str) and name.strip() else None


def claude() -> dict:
    path = home() / '.claude' / '.credentials.json'
    if not path.is_file():
        return not_connected('No Claude Code sign-in on the collector machine.')
    try:
        creds = json.loads(path.read_text()).get('claudeAiOauth') or {}
    except (ValueError, AttributeError):
        return {'status': 'error', 'message': 'The Claude Code credentials file could not be read.'}
    token = creds.get('accessToken') if isinstance(creds, dict) else None
    if not isinstance(token, str) or not token:
        return not_connected('Claude Code is not signed in with a claude.ai account on the collector machine.')
    plan = creds.get('subscriptionType') if isinstance(creds.get('subscriptionType'), str) else None
    headers = {'Authorization': f'Bearer {token}', 'anthropic-beta': 'oauth-2025-04-20'}
    data = get_json(CLAUDE_USAGE_URL, headers)
    result = normalize_claude(data, claude_plan_name(headers) or plan)
    result['raw'] = data
    return result


# --- ChatGPT (Codex) ----------------------------------------------------------------------------

def window_label(minutes: float | None) -> str:
    if minutes is None:
        return 'Usage window'
    if minutes <= 360:
        return f'{minutes / 60:g}-hour window'
    if minutes % 1440 == 0:
        days = int(minutes // 1440)
        return 'Weekly window' if days == 7 else f'{days}-day window'
    return f'{minutes / 60:g}-hour window'


def chatgpt_window(w: dict, wid: str, prefix: str | None = None) -> dict | None:
    used = percent(w.get('used_percent'))
    if used is None:
        return None
    seconds = positive_number(w.get('limit_window_seconds'))
    minutes = seconds / 60 if seconds else positive_number(w.get('window_minutes'))
    resets = to_iso(w.get('reset_at')) or to_iso(w.get('resets_at'))
    after = w.get('reset_after_seconds')
    if resets is None and isinstance(after, (int, float)) and not isinstance(after, bool) and after >= 0:
        resets = now_iso(time.time() + after)
    kind = 'current' if minutes is not None and minutes <= 360 else 'weekly'
    label = (f'{prefix} · ' if prefix else '') + window_label(minutes)
    return {'id': wid, 'label': label, 'kind': kind, 'usedPercent': used, 'windowMinutes': minutes, 'resetsAt': resets}


def model_name(slug: str) -> str:
    """'gpt-6-astra' -> 'GPT-6 Astra', 'gpt-6.1-sol' -> 'GPT-6.1 Sol'."""
    parts = [part for part in slug.split('-') if part]
    if len(parts) >= 2 and parts[0].lower() == 'gpt':
        parts = [f'GPT-{parts[1]}'] + [part.capitalize() for part in parts[2:]]
        return ' '.join(parts)
    return ' '.join(part.capitalize() for part in parts) or slug


def chatgpt_credit_rows(data: dict) -> list:
    rows = []
    credits = data.get('credits')
    if isinstance(credits, dict):
        balance = credits.get('balance')
        if credits.get('unlimited'):
            rows.append({'id': 'chatgpt-credits', 'label': 'ChatGPT credits', 'value': 'Unlimited', 'detail': '', 'state': 'ok', 'source': 'live'})
        elif isinstance(balance, (str, int, float)) and not isinstance(balance, bool):
            rows.append({'id': 'chatgpt-credits', 'label': 'ChatGPT credits', 'value': f'{balance} credits', 'detail': 'Extend Codex and ChatGPT past the plan limit.',
                         'state': 'ok' if credits.get('has_credits') else 'empty', 'source': 'live'})
    resets = data.get('rate_limit_reset_credits')
    if isinstance(resets, dict) and isinstance(resets.get('available_count'), int) and not isinstance(resets.get('available_count'), bool):
        usable = resets.get('applicable_available_count')
        lead = f'{usable} apply right now. ' if isinstance(usable, int) and not isinstance(usable, bool) else ''
        rows.append({'id': 'limit-resets', 'label': 'Limit resets', 'value': f"{resets['available_count']} available", 'detail': f'{lead}Run /usage in Codex to use one.',
                     'state': 'ok' if resets['available_count'] else 'empty', 'source': 'live'})
    return rows


def normalize_chatgpt(data: dict) -> dict:
    windows = []
    for container, prefix, tag in ((data.get('rate_limit'), None, ''), (data, None, '')):
        if not isinstance(container, dict):
            continue
        for key, wid in (('primary_window', 'primary'), ('secondary_window', 'secondary'), ('primary', 'primary'), ('secondary', 'secondary')):
            w = container.get(key)
            if isinstance(w, dict) and not any(x['id'] == wid for x in windows):
                item = chatgpt_window(w, wid, prefix)
                if item:
                    windows.append(item)
    additional = data.get('additional_rate_limits')
    if isinstance(additional, list):
        for index, entry in enumerate(additional):
            if not isinstance(entry, dict):
                continue
            name = entry.get('limit_name') or entry.get('limit_id') or f'limit {index + 1}'
            inner = entry.get('rate_limit') if isinstance(entry.get('rate_limit'), dict) else entry
            for key, suffix in (('primary_window', 'primary'), ('secondary_window', 'secondary')):
                w = inner.get(key)
                if isinstance(w, dict):
                    item = chatgpt_window(w, f'{name}:{suffix}', str(name))
                    if item:
                        windows.append(item)
    if not windows:
        raise ProviderError('The usage report contained no rate-limit windows.')
    plan = data.get('plan_type') if isinstance(data.get('plan_type'), str) else None
    result = {'status': 'ok', 'plan': plan, 'source': 'Codex sign-in', 'windows': windows}
    # Per-model gates, e.g. {"gpt-6-astra": {"available": true, "available_at": null, "credits_would_enable": false}}.
    # No percentage is reported: only whether the model can be used now and, if not, when it reopens.
    usage = data.get('model_usage')
    if isinstance(usage, dict):
        models = []
        for slug, info in usage.items():
            if not isinstance(slug, str) or not slug or not isinstance(info, dict) or not isinstance(info.get('available'), bool):
                continue
            name, reopens = model_name(slug)[:40], to_iso(info.get('available_at'))
            models.append({'id': slug, 'name': name, 'available': info['available'], 'availableAt': reopens,
                           'creditsWouldEnable': bool(info.get('credits_would_enable'))})
            if not info['available'] and reopens:
                # Blocked until a known time. The 100 is inferred, not reported, so `gate` tells the page not to print it.
                windows.append({'id': f'model:{slug}', 'label': name, 'kind': 'weekly', 'usedPercent': 100.0, 'resetsAt': reopens, 'model': name, 'gate': True})
        if models:
            result['models'] = models
    rows = chatgpt_credit_rows(data)
    if rows:
        result['credits'] = rows
    return result


def account_from_id_token(id_token) -> str | None:
    if not isinstance(id_token, str) or id_token.count('.') != 2:
        return None
    try:
        payload = id_token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        account = (claims.get('https://api.openai.com/auth') or {}).get('chatgpt_account_id')
        return account if isinstance(account, str) and account else None
    except Exception:
        return None


def chatgpt() -> dict:
    path = home() / '.codex' / 'auth.json'
    if not path.is_file():
        return not_connected('No Codex sign-in on the collector machine.')
    try:
        auth = json.loads(path.read_text())
    except ValueError:
        return {'status': 'error', 'message': 'The Codex auth file could not be read.'}
    tokens = auth.get('tokens') if isinstance(auth, dict) else None
    if not isinstance(tokens, dict) or not isinstance(tokens.get('access_token'), str) or not tokens['access_token']:
        return not_connected('Codex is not signed in with a ChatGPT account on the collector machine.')
    headers = {'Authorization': f"Bearer {tokens['access_token']}"}
    account = tokens.get('account_id') if isinstance(tokens.get('account_id'), str) else None
    account = account or account_from_id_token(tokens.get('id_token'))
    if account:
        headers['ChatGPT-Account-Id'] = account
    data = get_json(CHATGPT_USAGE_URL, headers)
    result = normalize_chatgpt(data)
    result['raw'] = data
    return result


# --- Gemini (agy, Google Antigravity CLI) -------------------------------------------------------

AGY_WORKSPACE = HERE / 'agy-workspace'
AGY_LINE = re.compile(r'^(?P<group>[^\t]+)\t(?P<label>[^\t]+)\t(?P<remaining>\d+(?:\.\d+)?)%\t(?P<resets>\S+)\s*$')


def normalize_agy(text: str) -> dict:
    """Parse the tab-separated table `agy --print /usage` prints:
    <model group>\t<Weekly|Five Hour> Limit Remaining\t<n>%\t<reset ISO-8601>"""
    windows = []
    for line in text.splitlines():
        match = AGY_LINE.match(line.strip('\r'))
        if not match:
            continue
        group, label = match['group'].strip(), match['label'].strip()
        remaining = percent(float(match['remaining']))
        lowered = label.lower()
        if 'five hour' in lowered or '5-hour' in lowered or '5 hour' in lowered:
            kind, window = 'current', '5-hour window'
        elif 'week' in lowered:
            kind, window = 'weekly', 'Weekly window'
        else:
            kind, window = 'weekly', label
        slug = re.sub(r'[^a-z0-9]+', '_', f'{group} {window}'.lower()).strip('_')
        gemini_group = group.lower().startswith('gemini')
        name = 'Gemini models' if gemini_group else f'{group} (Antigravity)'
        windows.append({'id': slug, 'label': f'{name} · {window}', 'kind': kind, 'usedPercent': round(100 - remaining, 1), 'resetsAt': to_iso(match['resets']), '_gemini': gemini_group})
    if not windows:
        raise ProviderError('agy printed no quota lines.')
    windows.sort(key=lambda w: (not w.pop('_gemini'), w['kind'] != 'current'))
    return {'status': 'ok', 'plan': None, 'source': 'agy sign-in', 'windows': windows}


AGY_CREDITS = re.compile(r'^Remaining credits\t(\d[\d,.]*)\s*$', re.M)


def agy_credit_rows(text: str) -> list:
    match = AGY_CREDITS.search(text or '')
    if not match:
        return []
    zero = float(match[1].replace(',', '')) == 0
    detail = "On Nov 6, agy's own credits screen said AI credits are not enabled; its /settings can turn them on." if zero else ''
    return [{'id': 'agy-credits', 'label': 'AI credits (agy)', 'value': match[1], 'detail': detail, 'state': 'empty' if zero else 'ok', 'source': 'live'}]


def gemini() -> dict:
    agy = shutil.which('agy') or (str(Path.home() / '.local' / 'bin' / 'agy') if (Path.home() / '.local' / 'bin' / 'agy').is_file() else None)
    if not agy:
        return not_connected('No agy (Gemini CLI) on the collector machine.')
    AGY_WORKSPACE.mkdir(exist_ok=True)
    try:
        result = subprocess.run([agy, '--print', '/usage', '--print-timeout', '60s'], cwd=AGY_WORKSPACE, capture_output=True, text=True, timeout=120,
                                env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'})
    except subprocess.TimeoutExpired:
        raise ProviderError('agy did not answer within two minutes.') from None
    except OSError:
        raise ProviderError('agy could not be started.') from None
    output = strip_ansi(result.stdout)
    if result.returncode != 0:
        lowered = (output + strip_ansi(result.stderr)).lower()
        if 'sign in' in lowered or 'login' in lowered or 'auth' in lowered:
            raise ProviderError('agy is not signed in on the collector machine. Run agy once and sign in.')
        raise ProviderError(f'agy exited with status {result.returncode}.')
    normalized = normalize_agy(output)
    normalized['raw'] = output
    try:
        # Best effort: a failure here must never cost the quota reading.
        credits = subprocess.run([agy, '--print', '/credits', '--print-timeout', '60s'], cwd=AGY_WORKSPACE, capture_output=True, text=True, timeout=120,
                                 env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'})
        rows = agy_credit_rows(strip_ansi(credits.stdout)) if credits.returncode == 0 else []
    except (subprocess.TimeoutExpired, OSError):
        rows = []
    if rows:
        normalized['credits'] = rows
    return normalized


# --- Assemble, store, publish -------------------------------------------------------------------

PROVIDERS = (('claude', claude), ('chatgpt', chatgpt), ('gemini', gemini))


def load_plan_credits(path: Path = PLAN_CREDITS) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def merge_plan_credits(provider: dict, static) -> dict:
    """Add the hand-checked rows, which apply whether or not the provider's live source answered."""
    if not isinstance(static, dict):
        return provider
    rows = static.get('credits')
    rows = [dict(row, source='checked') for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    if rows:
        provider['credits'] = [*provider.get('credits', []), *rows]
    if isinstance(static.get('plan'), str) and not provider.get('plan'):
        provider['plan'] = static['plan']
    return provider


def record_and_forecast(stamp: str, providers: dict, history: Path | None = None) -> None:
    """Add this run to the history and forecast from it. A failure here must never cost the live readings."""
    path = history or HISTORY
    row = forecast.history_row(stamp, providers)
    try:
        if row['u']:
            forecast.append_history(path, row)
    except OSError as error:
        print(f'history not saved: {error}', file=sys.stderr)
    moment = forecast.to_epoch(stamp)
    for name, provider in providers.items():
        if provider.get('status') != 'ok':
            continue
        try:
            result = forecast.forecast_provider(provider, forecast.load_history(path, name, moment), moment)
        except Exception as error:  # noqa: BLE001  a modelling bug must not stop the feed
            print(f'forecast failed for {name}: {type(error).__name__}: {error}', file=sys.stderr)
            continue
        if result:
            provider['forecast'] = result


def collect(history: Path | None = None) -> dict:
    providers = {}
    plan_credits = load_plan_credits()
    for name, fetch in PROVIDERS:
        try:
            providers[name] = fetch()
        except ProviderError as error:
            providers[name] = {'status': 'error', 'message': str(error)}
        except Exception as error:  # never let one provider take the whole feed down
            providers[name] = {'status': 'error', 'message': f'The collector failed on this provider ({type(error).__name__}).'}
        merge_plan_credits(providers[name], plan_credits.get(name))
    stamp = now_iso()
    record_and_forecast(stamp, providers, history)
    return {'version': 1, 'collectedAt': stamp, 'collector': socket.gethostname(), 'providers': providers}


def public_copy(payload: dict) -> dict:
    copy = json.loads(json.dumps(payload))
    for provider in copy['providers'].values():
        provider.pop('raw', None)
    return copy


def write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(text)


def strip_ansi(text: str) -> str:
    return re.sub(r'\x1b\[[0-9;]*m', '', text)


def kv_namespace_id(path: Path | None = None) -> str | None:
    """The LIVE namespace from the private wrangler.toml."""
    try:
        config = tomllib.loads((path or PROJECT / 'wrangler.toml').read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return None
    for namespace in config.get('kv_namespaces') or []:
        if isinstance(namespace, dict) and namespace.get('binding') == 'LIVE' and isinstance(namespace.get('id'), str) and namespace['id']:
            return namespace['id']
    return None


def push(payload: dict) -> None:
    """Publish the public copy to Cloudflare KV through wrangler (its own OAuth login; no token handling here)."""
    namespace = kv_namespace_id()
    if not namespace:
        raise RuntimeError('no LIVE KV namespace in wrangler.toml; copy wrangler.toml.example and fill it in')
    tmp = HERE / 'live.push.json'
    write_private(tmp, json.dumps(public_copy(payload)))
    env = dict(os.environ)
    env['WRANGLER_SEND_METRICS'] = 'false'
    env['PATH'] = f"{Path.home() / '.local' / 'bin'}:{env.get('PATH', '/usr/local/bin:/usr/bin:/bin')}"
    command = ['wrangler', 'kv', 'key', 'put', KV_KEY, '--namespace-id', namespace, '--remote', '--path', str(tmp)]
    try:
        # cwd must be the project, never $HOME: wrangler creates ./.wrangler there and would shadow its login.
        result = subprocess.run(command, cwd=PROJECT, env=env, capture_output=True, text=True, timeout=150)
    finally:
        tmp.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError('wrangler kv put failed: ' + strip_ansi(result.stderr or result.stdout).strip()[-600:])


def summary(payload: dict) -> str:
    parts = []
    for name, provider in payload['providers'].items():
        if provider.get('status') == 'ok':
            windows = ', '.join(f"{w['label']} {w['usedPercent']:g}% used" for w in provider['windows'])
            parts.append(f'{name}: ok ({windows})')
        else:
            parts.append(f"{name}: {provider.get('status')} ({provider.get('message', '')})")
    return ' | '.join(parts)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--no-push', action='store_true', help='collect and save the local copy, do not publish')
    parser.add_argument('--print', action='store_true', help='print the published payload')
    args = parser.parse_args(argv)
    payload = collect()
    write_private(LOCAL_COPY, json.dumps(payload, indent=1))
    if args.print:
        print(json.dumps(public_copy(payload), indent=1))
    pushed, failure = False, None
    if not args.no_push:
        try:
            push(payload)
            pushed = True
        except Exception as error:
            failure = str(error)
    print(summary(payload) + (' | pushed' if pushed else ' | not pushed' + (f': {failure}' if failure else '')))
    return 1 if failure else 0


if __name__ == '__main__':
    sys.exit(main())
