# threads-smart-bot

Threads bot for crawling trending posts, generating original Bahasa Indonesia content via OpenRouter (or any self-hosted OpenAI-compatible endpoint), and publishing on demand or on a schedule.

Pipeline: `keyword search -> prompt -> grounding gate -> optional image -> publish -> SQLite`

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐
│  Crawl      │───>│  Craft       │───>│  Fact-Check  │───>│  Publish  │
│  Threads    │    │  OpenRouter  │    │  Grounding   │    │  Threads  │
│  keyword    │    │  Bahasa      │    │  gate (3x)   │    │  API      │
│  search     │    │  Indonesia   │    │              │    │           │
└─────────────┘    └──────────────┘    └──────────────┘    └───────────┘
       │                  │                                       │
       v                  v                                       v
  ┌─────────┐       ┌──────────┐                            ┌──────────┐
  │Category │       │ Author   │                            │ SQLite   │
  │Rotation │       │ Context  │                            │ state.db │
  │(7-day)  │       │ (optional)│                            │          │
  └─────────┘       └──────────┘                            └──────────┘
```

**Key features:**
- **Category rotation** — `CATEGORY_QUERIES` splits search terms into themed buckets, rotating a different lead category each day of the week
- **AI topic guard** — monitors recent posts; if AI/tooling content exceeds thresholds, forces a non-AI topic
- **Grounding gate** — drafts are fact-checked against source posts before publishing; unsupported claims trigger rewrites (up to 3 attempts)
- **Author context** — `AUTHOR_CONTEXT` injects a short bio/projects blurb so the LLM can reference your work naturally, auto-suppressed once it's been mentioned recently
- **Pluggable LLM backend** — `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` route generation through any self-hosted OpenAI-compatible endpoint; defaults to OpenRouter

## Quick Start

```bash
git clone https://github.com/dante4rt/threads-smart-bot.git
cd threads-smart-bot
npm install
cp .env.example .env
npm run build
```

```bash
# 1) authenticate once
npm run auth

# 2) smoke-test publishing immediately
npm run dev:post:test -- --text "Hello from my Threads bot"

# 3) test the full pipeline without posting
npm run dev:run:dry

# 4) run the scheduler
npm start
```

> [!IMPORTANT]
> Run `auth` in the same environment where the bot will run. Local auth writes to `data/state.db`. Docker auth writes to `/app/data/state.db` inside the Docker volume.

> [!TIP]
> `THREADS_USER_ID` can stay empty. The bot auto-discovers and stores it during `auth`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run auth` | OAuth flow, stores long-lived token in SQLite |
| `npm run auth:check` | Ask Threads whether the bot's current token can read its profile; does not publish |
| `npm run post:test` | Publish one manual test post immediately |
| `npm run run:once` | Run full pipeline once |
| `npm run run:dry` | Run full pipeline without publishing |
| `npm start` | Start scheduler using `POST_TIMES` |
| `npm run dev:*` | Same commands via `tsx` without building |

Common dev commands:

```bash
npm run dev:auth
npm run dev:post:test -- --dry --text "Smoke test"
npm run dev:run
npm run dev:run:dry
```

## Docker

```bash
docker compose up -d --build
docker compose run --rm bot node dist/index.js auth
docker compose run --rm bot node dist/index.js auth-check
docker compose run --rm bot node dist/index.js post-test --dry --text "Docker smoke test"
docker compose run --rm bot node dist/index.js run --dry
```

What Docker does:
- loads env from `.env`
- forces `DB_PATH=/app/data/state.db`
- persists SQLite in the named volume `bot-data`
- starts the scheduler by default with `docker compose up -d`

> [!NOTE]
> `.env` is injected at runtime by Compose. It is not copied into the image.

> [!WARNING]
> Do not mix `docker compose ... auth` with local `npm run ...` commands. If you auth in Docker, also run the bot in Docker.

If logs report a stored token expiry, run `docker compose run --rm bot node dist/index.js auth-check`.
This checks the token in the same Docker volume as the scheduler, then asks Threads for the account profile.
Local `npm run auth:check` rebuilds first, but checks the local SQLite database instead of the Docker volume.
If Threads rejects it, run `docker compose run --rm bot node dist/index.js auth` to authorize again.
Posts visible on the public profile do not prove that the Docker token still works.
`auth-check` verifies identity access; it does not verify publishing or keyword-search permissions.

To observe the whole caption pipeline without publishing, run
`docker compose run --rm bot node dist/index.js run --dry` and inspect the structured logs.
Startup and each run report whether JEV is enabled. An enabled run logs `JEV evaluation started`
and `JEV caption assessment` with the score, threshold, and approval result.
Without `TYPESAFE_API_KEY`, the log reports that the existing craft flow is in use.

## VPS Process Manager

For a long-running VPS process, do not leave the scheduler attached to an SSH shell. Use Docker Compose or a process manager that starts the bot after reboot and restarts it after external termination signals.

PM2 setup:

```bash
npm install
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` prints one system command for your server. Run that printed command once so the bot returns after reboot.

Useful checks:

```bash
pm2 status threads-smart-bot
pm2 logs threads-smart-bot
pm2 restart threads-smart-bot
```

## Required Permissions

Your Meta app needs:

| Scope | Needed for |
| --- | --- |
| `threads_basic` | all Threads API calls |
| `threads_content_publish` | publishing posts |
| `threads_keyword_search` | crawl stage |

Meta docs:
- [Threads Get Started](https://developers.facebook.com/docs/threads/get-started/)
- [Get Access Tokens](https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions/)
- [Long-Lived Tokens](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens/)

> [!WARNING]
> Without `threads_keyword_search`, the bot can auth and publish manual tests, but the crawl-based pipeline will fail.

## Environment

<details>
<summary>Environment Reference</summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `THREADS_APP_ID` | — | Meta Threads app ID |
| `THREADS_APP_SECRET` | — | Meta Threads app secret |
| `THREADS_USER_ID` | empty | Optional override; auto-stored after auth |
| `THREADS_REDIRECT_URI` | `https://localhost/callback` | Must match Meta app config exactly |
| `OPENROUTER_API_KEY` | — | Required for crawl + craft pipeline (unless `LLM_API_KEY` is set) |
| `THREADS_ACCESS_TOKEN` | empty | Optional bootstrap fallback before SQLite exists |
| `OPENROUTER_MODEL` | `anthropic/claude-opus-4-6` | OpenRouter model (unless `LLM_MODEL` is set) |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Point at a self-hosted/OpenAI-compatible endpoint (e.g. 9router) instead of OpenRouter. Works with or without a trailing `/v1` |
| `LLM_API_KEY` | — | Overrides `OPENROUTER_API_KEY` when set |
| `LLM_MODEL` | — | Overrides `OPENROUTER_MODEL` when set |
| `TYPESAFE_API_KEY` | empty | Optional; enables the JEV caption gate when set |
| `JEV_ENABLED` | auto | Overrides key detection; `true` requires `TYPESAFE_API_KEY`, `false` keeps the existing flow |
| `JEV_MIN_SCORE` | `0.65` | Minimum weighted caption quality score, from 0 to 1 |
| `SEARCH_QUERIES` | (long default — see `.env.example`) | Comma-separated seed queries for crawl |
| `CATEGORY_QUERIES` | auto-derived from `SEARCH_QUERIES` | JSON map of themed query buckets for day-of-week rotation. Example: `{"tech":["ngoding","SaaS"],"fintech":["crypto"]}` |
| `TREND_FEEDS` | Google News ID, Detik, CNN Indonesia, Antara, Google Trends (geo=ID) RSS | Comma-separated RSS feeds polled at crawl time; terms repeated across headlines become extra crawl queries, confirmed on Threads via `search_type=RECENT` before use. Set empty (`TREND_FEEDS=`) to disable trend-reactive crawling. |
| `MAX_TREND_QUERIES` | `3` | Max trending terms prepended to the day's query pool |
| `TREND_MANDATE_MIN_TITLES` | `4` | A trend seen in at least this many distinct headlines becomes a hard topic mandate for the post, grounded on those headlines. `0` disables the mandate (trends stay a soft preference). |
| `AUTHOR_CONTEXT` | empty | Short bio or project list. Lets the LLM reference your work naturally when topics align; suppressed automatically once your project was mentioned in 2+ of the last 10 posts, so it doesn't dominate the feed. |
| `MIN_SOURCE_POSTS` | `10` | Minimum unique source posts before crafting |
| `MIN_SOURCE_QUERIES` | `3` | Minimum distinct queries that must contribute posts |
| `MAX_SOURCE_POSTS_PER_QUERY` | `4` | Caps prompt dominance from one query |
| `POST_TIMES` | `12:15,19:30` | Scheduler times (lunch + prime evening scroll) |
| `TIMEZONE` | `Asia/Jakarta` | IANA timezone |
| `UNSPLASH_ACCESS_KEY` | empty | Optional image search |
| `DRY_RUN` | `false` | Skip publishing globally |
| `DB_PATH` | `data/state.db` | SQLite path |

</details>

## Runtime Behavior

- Auth exchanges a short-lived token for a long-lived token and stores it in SQLite.
- Tokens auto-refresh near expiry.
- If Unsplash fails, the bot posts text-only.
- Crafting is skipped unless crawl coverage is good enough:
  - at least `MIN_SOURCE_POSTS` unique posts
  - at least `MIN_SOURCE_QUERIES` contributing queries
- Prompt inputs are balanced by `MAX_SOURCE_POSTS_PER_QUERY` so one topic does not fully dominate.
- AI-specific query seeds are deferred behind broader trend queries, so the bot reacts to the flow first and only posts about AI when it is a specific fresh trend.
- The prompt uses a silent STEPPS filter (Social Currency, Triggers, Emotion, Public visibility, Practical Value, Stories) plus recent-post topic checks to avoid repeating generic AI angles.
- **Category rotation:** when `CATEGORY_QUERIES` is set, the bot picks a different lead bucket each day (Monday = bucket 1, Tuesday = bucket 2, etc.) so the feed stays varied. Without it, `SEARCH_QUERIES` is split into 7 round-robin buckets automatically.
- **Grounding gate:** every draft is checked against the source posts that inspired it. Claims that aren't directly supported by the source material trigger a rewrite, up to 3 attempts. If all attempts fail, the post is skipped.
- **Optional JEV caption gate:** Set `TYPESAFE_API_KEY` to enable TypeSafe scoring of the final caption's hook, conversation potential, substance, and novelty against recent posts. Without the key, the existing flow applies. A rejected caption triggers another grounded draft with feedback until one passes. Repeated attempts back off up to five minutes. The run stays active during retries, so later scheduled runs wait for its approved caption. Publishing waits for approval. Scores estimate editorial quality, not actual reach; adjust `JEV_MIN_SCORE` using observed results.
- **Author context:** set `AUTHOR_CONTEXT` to a short description of your projects or expertise. The LLM can weave references naturally when topics align, no hard selling. It's dropped from the prompt once your project name shows up in 2+ of the last 10 posts, so the account doesn't turn into a single-topic feed.
- **Self-hosted LLM:** set `LLM_BASE_URL` (+ `LLM_API_KEY`, `LLM_MODEL`) to route generation through any OpenAI-compatible chat-completions endpoint (e.g. [9router](https://github.com/dante4rt/threads-multi-bot)) instead of OpenRouter. Falls back to OpenRouter when unset.

## Troubleshooting

<details>
<summary>Common Issues</summary>

| Problem | Cause | Fix |
| --- | --- | --- |
| `No access token found — run auth first` | Auth was done in a different environment | Re-run `auth` in the same environment you use to run the bot |
| `Threads API error 400` on publish | Bad stored user ID or invalid request | Re-run `auth`; current code also auto-repairs bad stored IDs |
| Crawl returns too few posts | Query set is too thin | Broaden `SEARCH_QUERIES` or lower crawl thresholds |
| Images never attach | Unsplash key missing/invalid | Set `UNSPLASH_ACCESS_KEY` or accept text-only posts |
| `SIGTERM received, stopping scheduler` then bot stays down | Server, Docker, PM2, systemd, or another parent process asked Node to terminate; a raw `npm start` shell will not restart it | Run with Docker Compose or PM2; check `pm2 logs`, `journalctl`, or provider reboot/OOM events |

</details>

## Development

```bash
npm run build
npm run typecheck
npm test
```

## License

Licensed under the MIT License. See [LICENSE](./LICENSE).
