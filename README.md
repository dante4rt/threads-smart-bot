# threads-smart-bot

CLI bot for Threads: crawl trending posts, generate one original Bahasa Indonesia post with OpenRouter, then publish and log it to SQLite.

Pipeline: `keyword search -> prompt -> optional image -> publish -> SQLite`

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
| `OPENROUTER_API_KEY` | — | Required for crawl + craft pipeline |
| `THREADS_ACCESS_TOKEN` | empty | Optional bootstrap fallback before SQLite exists |
| `OPENROUTER_MODEL` | `anthropic/claude-opus-4-6` | OpenRouter model |
| `SEARCH_QUERIES` | `viral,tech,AI,trending` | Seed queries for crawl |
| `MIN_SOURCE_POSTS` | `10` | Minimum unique source posts before crafting |
| `MIN_SOURCE_QUERIES` | `3` | Minimum distinct queries that must contribute posts |
| `MAX_SOURCE_POSTS_PER_QUERY` | `4` | Caps prompt dominance from one query |
| `POST_TIMES` | `09:00,17:00` | Scheduler times |
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

## Troubleshooting

<details>
<summary>Common Issues</summary>

| Problem | Cause | Fix |
| --- | --- | --- |
| `No access token found — run auth first` | Auth was done in a different environment | Re-run `auth` in the same environment you use to run the bot |
| `Threads API error 400` on publish | Bad stored user ID or invalid request | Re-run `auth`; current code also auto-repairs bad stored IDs |
| Crawl returns too few posts | Query set is too thin | Broaden `SEARCH_QUERIES` or lower crawl thresholds |
| Images never attach | Unsplash key missing/invalid | Set `UNSPLASH_ACCESS_KEY` or accept text-only posts |

</details>

## Development

```bash
npm run build
npm run typecheck
npm test
```
