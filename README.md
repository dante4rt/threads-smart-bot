# threads-smart-bot

CLI bot that runs on a cron schedule, crawls trending Threads posts via keyword search, crafts an original Bahasa Indonesia post using OpenRouter, and publishes it to your Threads account — twice daily.

**Pipeline:** Keyword search → OpenRouter (Claude) → Threads publish → SQLite log

---

## Requirements

- Node.js ≥ 20
- A Meta app with Threads API access (see [Permissions](#threads-permissions--app-review))
- An [OpenRouter](https://openrouter.ai) API key

---

## Setup

```bash
git clone https://github.com/dante4rt/threads-smart-bot.git
cd threads-smart-bot
npm install
cp .env.example .env   # fill in required values
npm run build
```

> [!IMPORTANT]
> Run `npm run auth` before `npm start`. The scheduler will fail without a token in SQLite.

---

## Auth Flow

```bash
npm run auth
```

1. Bot prints an OAuth URL — open it in your browser.
2. Approve the app permissions on Threads.
3. Copy the full redirect URL from your browser and paste it into the CLI.
4. Bot exchanges the code for a short-lived token, then immediately upgrades to a long-lived token (~60 days) and stores it in `data/state.db`.

After this, `THREADS_ACCESS_TOKEN` in `.env` is no longer read — SQLite is the token store.

> [!NOTE]
> `THREADS_REDIRECT_URI` must match the redirect URI registered in your Meta app exactly. Defaults to `https://localhost/callback`.

---

> [!NOTE]
> The CLI now validates the OAuth `state` parameter before accepting the callback URL.

---

## Run Modes

| Command            | Behaviour                                                   |
| ------------------ | ----------------------------------------------------------- |
| `npm start`        | Scheduler mode — runs pipeline at each time in `POST_TIMES` |
| `npm run run:once` | Run pipeline once and exit                                  |
| `npm run run:dry`  | Crawl + craft, log generated text, **skip publish**         |

Dev equivalents (no build required, uses `tsx`):

```bash
npm run dev           # scheduler
npm run dev:auth      # auth flow
npm run dev:run       # run once
npm run dev:run:dry   # dry run
```

---

## Environment Variables

Copy `.env.example` and fill in:

| Variable               | Required       | Default                      | Description                                    |
| ---------------------- | -------------- | ---------------------------- | ---------------------------------------------- |
| `THREADS_APP_ID`       | Yes            | —                            | Meta app ID                                    |
| `THREADS_APP_SECRET`   | Yes            | —                            | Meta app secret                                |
| `THREADS_USER_ID`      | Yes            | —                            | Your Threads user ID                           |
| `THREADS_REDIRECT_URI` | No             | `https://localhost/callback` | Must match Meta app config                     |
| `OPENROUTER_API_KEY`   | Yes            | —                            | OpenRouter API key                             |
| `THREADS_ACCESS_TOKEN` | First run only | —                            | Bypassed after `auth`; SQLite takes over       |
| `OPENROUTER_MODEL`     | No             | `anthropic/claude-opus-4-6`  | Any OpenRouter-supported model                 |
| `SEARCH_QUERIES`       | No             | `viral,tech,AI,trending`     | Comma-separated Threads keyword queries        |
| `POST_TIMES`           | No             | `09:00,17:00`                | Comma-separated 24h times                      |
| `TIMEZONE`             | No             | `Asia/Jakarta`               | IANA timezone name                             |
| `UNSPLASH_ACCESS_KEY`  | No             | —                            | If set, attaches a relevant image to each post |
| `DRY_RUN`              | No             | `false`                      | Set `true` to skip publishing globally         |
| `DB_PATH`              | No             | `data/state.db`              | SQLite file path                               |

---

## Token Refresh Behaviour

Long-lived tokens last **60 days**. The bot auto-refreshes at the **10-day mark** (≤10 days remaining):

- Each pipeline run calls `maybeRefreshToken()` before any API work.
- Authenticated Threads requests also retry once after a forced token refresh if Threads returns `401`.
- A successful refresh extends the token by another 60 days.
- If the bot was offline and the token expired, the next run logs an `AUTH_ERROR` and skips that run.

Tokens saved in SQLite are encrypted at rest using your `THREADS_APP_SECRET`, and the runtime locks down DB filesystem permissions on the local `data/` directory.

### Recovery after expiry

```bash
npm run auth   # re-runs full OAuth flow; overwrites expired token in SQLite
npm start
```

---

## Dry-Run Mode

Dry-run crawls and crafts but **does not call the Threads publish API**.

- Generated text is still logged to stdout.
- A post record is still stored in SQLite with `threads_post_id = NULL`, so you keep a local audit trail.
- Recent-post prompt context only uses published rows, so dry runs do not affect duplicate avoidance.

Enable per-run:

```bash
npm run run:dry
# or
npm run dev:run:dry
```

Enable globally via env:

```env
DRY_RUN=true
```

---

## Docker Deployment

This repo includes both `Dockerfile` and `docker-compose.yml`.

```bash
cp .env.example .env
# fill in real credentials first
docker compose up -d --build
```

Useful commands:

```bash
docker compose logs -f bot
docker compose run --rm bot node dist/index.js run
docker compose run --rm -e DRY_RUN=true bot node dist/index.js run --dry
docker compose down
```

> [!IMPORTANT]
> The compose file mounts `/app/data` on a named volume so `state.db` survives container replacement. Run `npm run auth` locally first to create a valid token, then copy that SQLite file into the mounted volume or authenticate inside a one-off container session.

---

## Error Handling

| Error                     | Behaviour                                                          |
| ------------------------- | ------------------------------------------------------------------ |
| `401 AuthError`           | Attempt token refresh; if refresh fails, skip run and log critical |
| `429 RateLimitError`      | Log warning, skip run (no retry)                                   |
| `5xx / network`           | Retry up to 3 times with exponential backoff (1 s → 2 s → 4 s)     |
| 3 consecutive failed runs | Log warning; scheduler stays alive                                 |
| Process crash             | Docker `restart: unless-stopped` recovers automatically            |

---

## Threads Permissions & App Review

Your Meta app needs these scopes approved before the bot can function:

| Scope                     | Purpose                 |
| ------------------------- | ----------------------- |
| `threads_basic`           | Core API access         |
| `threads_content_publish` | Publishing posts        |
| `threads_keyword_search`  | Crawling trending posts |

Request approval in the [Meta Developer Console](https://developers.facebook.com) under **App Review → Permissions and Features**.

> [!WARNING]
> Without `threads_keyword_search` approved, the crawl stage will fail on every run. The bot will log `AUTH_ERROR` or a permissions error and skip publishing.

---

## Development

```bash
npm run build      # compile TypeScript → dist/
npm run typecheck  # type-check without emitting
npm test           # run Vitest test suite
npm run test:watch # watch mode
```

State is stored in `data/state.db` (auto-created). Delete it to reset token and post history.
