# Allowance

A private dashboard showing how much of your Claude, ChatGPT and Gemini allowances is left, and which limit is likely to run out first. It runs on Cloudflare Pages behind Cloudflare Access, and is fed by a small collector on your own machine.

**The chat-plan numbers come from private endpoints, not supported APIs.** The collector calls the same endpoints the Claude Code, Codex and Antigravity CLIs use for their own usage screens, with the sign-ins those CLIs already stored on your machine. These can change or break without notice. Check each provider's terms before running it. If an answer changes shape, the card shows an error rather than a made-up number.

## How it works

```
your machine                                   Cloudflare
┌────────────────────────────────────┐         ┌──────────────────────────────┐
│ collector/collect.py (every 5 min) │ wrangler│ KV "LIVE", key "live"        │
│  Claude Code sign-in ──► Anthropic │ ──────► │        │                     │
│  Codex sign-in ───────► ChatGPT    │         │        ▼                     │
│  agy (Antigravity) ───► Google     │         │ Worker /api/live ──► page    │
└────────────────────────────────────┘         └──────────────────────────────┘
```

| Provider | Source | What it reports |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json`, then `api.anthropic.com/api/oauth/usage` | 5-hour and weekly windows, model-only limits such as Fable, extra usage, weekly use by surface |
| ChatGPT | `~/.codex/auth.json`, then `chatgpt.com/backend-api/wham/usage` | Rate-limit windows, per-model availability such as GPT-6 Astra, credits, limit resets |
| Gemini | `agy --print /usage` and `/credits` | Quota for Gemini models and for Claude and GPT models in Antigravity, AI credits |

Each card's gauge shows the most limiting window, with "% left" next to the "% used" the provider reports. When that window covers only one model, a smaller gauge underneath shows what is left for the model you would switch to, set as `fallbackModel` in `public/model.js`.

The **Credits & APIs** tab lists each pot of money separately: usage credits, API credits included with a plan, and purchased balances. Where no trustworthy live source exists, a row comes from `collector/plan-credits.json`, which you fill in by hand, and it shows the date you checked. The API usage cards read OpenAI's and Anthropic's admin reporting APIs if you set keys. Anthropic's Admin API is unavailable for individual accounts.

## What stays where

- **Sign-in tokens** are only ever sent to their own provider, and never leave your machine otherwise.
- **The feed in Cloudflare KV** holds percentages, reset times, plan names and credit rows. It is served only after sign-in.
- **`collector/live.json`** keeps each provider's raw answer, which includes account identifiers. **`collector/history.jsonl`** keeps your usage over time. Both are created with mode 600 and ignored by git.
- **`wrangler.toml`** and **`collector/plan-credits.json`** hold your own values and are ignored by git.
- **Manual readings and budgets** stay in your browser.

Access is enforced twice: by Cloudflare Access at the edge, and by the Worker, which verifies the Access JWT's signature, issuer, audience, expiry and owner email before serving any asset or API route. Missing settings or failed checks deny access, and it never trusts an email header alone.

## Set up

Requires Node 20+, Python 3.11+, and Wrangler 4 logged in to your Cloudflare account.

1. Create a Pages project, and a KV namespace with `wrangler kv namespace create LIVE`.
2. In Cloudflare Zero Trust, create a self-hosted Access application covering `<project>.pages.dev` and `*.<project>.pages.dev`, with an Allow policy for your email only. Do this before the first deploy.
3. `cp wrangler.toml.example wrangler.toml` and fill in your values.
4. Optionally, `cp collector/plan-credits.example.json collector/plan-credits.json` and fill in your plan's credits.
5. Run `npm run deploy`. Upload only `dist/`: `public/` on its own lacks the authentication Worker.
6. Run `collector/install-timer.sh`, which installs a systemd user timer that collects every 5 minutes and runs once. Use `loginctl enable-linger` if it should run while you are logged out.

Run wrangler from this folder, not your home directory: it creates `.wrangler/` in the working directory, and one in `$HOME` shadows its login.

## The forecast

Every collector run adds a line to the history. `collector/forecast.py` simulates the future by resampling 6-hour blocks of your own past usage. Blocks from recent days, a similar time of day and a similar busy or idle state are the likeliest, and each simulated future gets a random "how busy will you be" multiplier. Each window then follows its real rules: a weekly window fills until its reset, and a 5-hour window starts at first use and empties 5 hours later. How often each window reaches 100% first gives the odds.

A window with too little recent history follows the main window through an exchange rate: measured, else from this cycle's readings, else from the provider's stated share of the week. With no basis, it is reported as unknown.

**It is a rough guide.** `npm run backtest` replays each past hour using only what was known then. On 18 days of one person's usage, on 2026-11-06:

| Next-24-hour burn, mean error in points | Model | Same as last 24h | 7-day pace |
| --- | --- | --- | --- |
| Claude weekly (237 forecasts) | 4.69 | 4.60 | 4.48 |
| ChatGPT weekly (282 forecasts) | 3.65 | 3.74 | 3.66 |

The model does not beat those simple rules at predicting the next day. What it adds is the race between windows, the reset rules and the date ranges. Its 80% ranges held the truth 74% of the time on Claude, so they are too narrow. It can't foresee a sudden jump in activity. Its odds are also sensitive to assumptions, which is why the page rounds them and words them loosely. Only two full weeks were available to score.

## Run locally and test

```sh
npm test               # node and Python tests, no network and no credentials
node tests/browser.mjs # headless Chrome against a loopback fixture; set CHROME_BIN if Chrome is elsewhere
npm run dev            # http://127.0.0.1:8788, shows collector/live.json if present
npm run backtest       # needs collector/history.jsonl
```

There are no npm dependencies, and the collector uses only the Python standard library.

## Files

- `public/`: the dashboard.
- `worker.js`: Access verification, `/api/session`, `/api/live`, `/api/usage`, then assets.
- `server/usage.js`: OpenAI and Anthropic admin-API reporting.
- `collector/`: `collect.py`, `forecast.py`, `backtest.py`, `backfill_history.py` (seeds history from the collector's systemd journal), tests, systemd units and the installer.
- `scripts/`: `build.mjs` bundles the Worker and assets into `dist/`, `dev.mjs` is the local preview, and `preview.mjs` makes a standalone review copy that must never be deployed.
- `tests/`: authentication, reporting, model and browser tests.
