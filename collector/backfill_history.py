#!/usr/bin/env python3
"""Seed history.jsonl from the collector's journal lines, for the time before it kept history itself. Safe to rerun:
only lines older than the first existing row are added. Reset times aren't in the journal, so those rows have none."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE))
import forecast  # noqa: E402

LINE = re.compile(r'^(\S+) \S+ python3\[\d+\]: (.*)$')
PROVIDER = re.compile(r'^(claude|chatgpt|gemini): ok \((.*)\)$')
WINDOW = re.compile(r'^(.+) ([\d.]+)% used$')
IDS = {
    'claude': {'5-hour window': 'five_hour', 'Weekly · all models': 'seven_day', 'Weekly · Opus': 'seven_day_opus', 'Weekly · Fable': 'limit:weekly_scoped_fable'},
    'chatgpt': {'Weekly window': 'primary'},
    'gemini': {'Gemini models · 5-hour window': 'gemini_models_5_hour_window', 'Gemini models · Weekly window': 'gemini_models_weekly_window',
               'Claude and GPT models (Antigravity) · 5-hour window': 'claude_and_gpt_models_5_hour_window',
               'Claude and GPT models (Antigravity) · Weekly window': 'claude_and_gpt_models_weekly_window'},
}


def parse_line(line: str) -> dict | None:
    match = LINE.match(line.rstrip('\n'))
    if not match:
        return None
    used = {}
    for part in match[2].split(' | '):
        provider = PROVIDER.match(part)
        if not provider:
            continue
        for item in provider[2].split(', '):
            window = WINDOW.match(item)
            key = IDS[provider[1]].get(window[1]) if window else None
            if key:
                used[f'{provider[1]}/{key}'] = float(window[2])
    if not used:
        return None
    stamp = datetime.fromisoformat(match[1]).astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    return {'t': stamp, 'u': used, 'r': {}}


def main() -> int:
    path = HERE / 'history.jsonl'
    existing = path.read_text().splitlines() if path.exists() else []
    first = forecast.to_epoch(json.loads(existing[0])['t']) if existing else float('inf')
    text = subprocess.run(['journalctl', '--user', '-u', 'token-overview-collector.service', '-o', 'short-iso', '--no-pager'], capture_output=True, text=True).stdout
    rows = [row for row in map(parse_line, text.splitlines()) if row and forecast.to_epoch(row['t']) < first]
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.writelines(json.dumps(row, separators=(',', ':'), ensure_ascii=False) + '\n' for row in rows)
        handle.writelines(line + '\n' for line in existing)
    os.replace(temp, path)
    print(f'{len(rows)} rows added from the journal, {len(existing)} already there.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
