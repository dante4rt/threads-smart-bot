# Threads Smart Bot — Design Spec

## Purpose

CLI bot that runs 24/7 in Docker. Twice daily (9am & 5pm UTC+7), it crawls trending Threads posts, crafts an original post in Bahasa Indonesia using X algorithm principles via OpenRouter, and publishes it to Threads.

## Required Permissions

App must be approved for these Threads API scopes:

| Scope | Purpose |
|-------|---------|
| `threads_basic` | Core API access |
| `threads_content_publish` | Publishing posts |
| `threads_keyword_search` | Searching public posts |

App review required via Meta Developer Console. Without `threads_keyword_search`, crawl stage won't work.

## Architecture

Single TypeScript process. `node-cron` scheduler triggers a linear pipeline. SQLite for state persistence. Docker with volume mount for reliability.

```
node-cron (9am/5pm UTC+7)
    ↓
Keyword Search (Threads API, search_type=TOP, 25-50 posts)
    ↓
Send top posts to OpenRouter (craft 1 post in Bahasa)
    ↓
Publish to Threads (text, optionally with Unsplash image)
    ↓
Log to SQLite (avoid duplicates, track token refresh)
```

## Pipeline Stages

### 1. Crawl

- Endpoint: `GET https://graph.threads.net/v1.0/keyword_search`
- Params: `q` from configured search queries, `search_type=TOP`, `limit=25`
- Picks 2-3 random queries per run from the configured list
- Collects 25-50 posts per run, deduplicates by post ID

### 2. Craft

- Sends crawled posts as context to OpenRouter
- Model: `anthropic/claude-opus-4-6` (configurable via env)
- System prompt bakes in X algorithm principles:
  - Maximize reply probability (ask questions, take stances)
  - Make it quotable/shareable
  - Drive profile curiosity
  - Under 500 chars, scannable with line breaks
  - Bahasa Indonesia, sound human
  - Original content inspired by trending topics, never copy
- Also receives last 5 published posts from SQLite to avoid repetition
- Output: 1 post text

### 3. Publish

- Two-step Threads publish flow:
  1. `POST /{user_id}/threads` — create media container
  2. `POST /{user_id}/threads_publish` — publish container
- If `UNSPLASH_ACCESS_KEY` is set, search Unsplash with a keyword extracted from the generated post, attach first result (JPEG, max 1440px wide)
- If no image found or no key, post text-only
- Log published post to SQLite

### 4. Error Handling

- Each stage wrapped in try/catch
- **Auth errors (401):** attempt token refresh, if fails log critical and skip
- **Rate limit (429):** log warning, skip run
- **Transient errors (5xx, network):** retry up to 3 times with exponential backoff within same run
- After 3 consecutive failed runs: log warning, keep scheduler alive
- Docker `restart: unless-stopped` handles process crashes

## Auth & Token Management

1. User runs `npx tsx src/index.ts auth`
2. Bot prints authorization URL → user opens in browser → approves → pastes redirect URL back into CLI
3. Bot exchanges authorization code for short-lived token (1hr)
4. Exchanges short-lived for long-lived token (60 days)
5. Stores long-lived token + expiry date in SQLite
6. On startup: reads token from SQLite (falls back to `THREADS_ACCESS_TOKEN` env var on first run)
7. Auto-refreshes at 50-day mark (10-day buffer). Refresh extends token by 60 days.
8. If token is expired (bot was down too long), logs error and requires re-running `auth`

## Database Schema

```sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_query TEXT,
  source_post_ids TEXT,      -- JSON array of Threads post IDs used as context
  generated_text TEXT,
  threads_post_id TEXT,      -- published post ID from Threads
  published_at TEXT           -- ISO 8601
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  access_token TEXT,
  refreshed_at TEXT,
  expires_at TEXT
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT,               -- 'success' | 'failed'
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT
);
```

Duplicate avoidance: before crafting, the bot loads last 5 posts from `posts` table and includes them in the AI prompt as "don't repeat these topics."

## Config

All via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `THREADS_APP_ID` | Yes | — | Meta app ID |
| `THREADS_APP_SECRET` | Yes | — | Meta app secret |
| `THREADS_ACCESS_TOKEN` | First run | — | Initial long-lived token (SQLite takes over after) |
| `THREADS_USER_ID` | Yes | — | Your Threads user ID |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `OPENROUTER_MODEL` | No | `anthropic/claude-opus-4-6` | Model for content generation |
| `SEARCH_QUERIES` | No | `viral,tech,AI,trending` | Comma-separated search terms |
| `POST_TIMES` | No | `09:00,17:00` | Comma-separated times (24h) |
| `TIMEZONE` | No | `Asia/Jakarta` | IANA timezone |
| `UNSPLASH_ACCESS_KEY` | No | — | For image attachment |
| `DRY_RUN` | No | `false` | Crawl + craft but don't publish (logs to stdout) |

## CLI Commands

```bash
npx tsx src/index.ts           # Start the bot (scheduler mode)
npx tsx src/index.ts auth      # Run OAuth flow
npx tsx src/index.ts run       # Run pipeline once (for testing)
npx tsx src/index.ts run --dry # Dry run (no publish)
```

## File Structure

```
threads-smart-bot/
├── src/
│   ├── index.ts           # Entry point + scheduler + CLI
│   ├── pipeline.ts        # Crawl → Craft → Publish orchestration
│   ├── threads-api.ts     # Threads API client
│   ├── openrouter.ts      # OpenRouter API client
│   ├── prompt.ts          # System prompt with X algorithm rules
│   ├── db.ts              # SQLite setup + queries
│   ├── media.ts           # Unsplash image fetcher
│   └── config.ts          # Env loading + validation
├── data/                  # Docker volume (runtime)
│   └── state.db
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

## Tech Stack

| Tool | Purpose |
|------|---------|
| TypeScript | Language |
| node-cron | Scheduler |
| better-sqlite3 | Local state |
| Docker | Deployment |

## README

- Concise, DRY, no fluff
- Uses GitHub Alerts syntax (`> [!NOTE]`, `> [!WARNING]`, etc.)
- Sections: what it does, setup, run, deploy, env vars

## Out of Scope

- Web UI or dashboard
- Multi-account support
- Analytics/reporting
- Content approval workflow
- AI image generation
