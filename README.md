# Telegram Stremio Addon

A personal Stremio addon that streams movies and TV episodes directly from your own Telegram account — pinned chats and file-request bots become your source library, with no re-uploading or manual configuration.

It acts as a live proxy: it never downloads a whole file to disk, it streams the exact byte ranges Stremio asks for, straight from Telegram, with full seeking (byte-range) support.

## Features

- **Movies and series** — search either, series queries are automatically formatted as `Title S04E04` and matched by exact season/episode.
- **Zero manual configuration** — sources are whatever you've **pinned** in your own Telegram account (a channel, a group, or a file-request bot). Pin something new, it's searched next time, no restart or config file needed.
- **Bot-aware automation** — if you pin a file-request bot, the addon messages it directly and walks through its "join this channel to unlock" flow automatically, including resolving direct file-permalink buttons.
- **True streaming proxy** — bytes are fetched from Telegram and piped straight into Stremio's response. Nothing is ever written to disk.
- **Real parallel chunk fetching** — multiple Telegram file-chunk requests are kept in flight at once, which matters a lot for sustained throughput on larger/higher-bitrate files.
- **Resolved-search cache** — once a title's been searched, its stream links are remembered (on disk, separate from any video data) so re-opening it later is instant instead of re-running the whole search.

## Architecture

1. **Search** — when you open a title in Stremio, the addon fetches metadata (title, year, or season/episode) from Cinemeta, then searches your pinned Telegram source for it.
2. **Match** — candidate filenames are parsed for title, year, season/episode, resolution, codec, and audio, and filtered against what Stremio actually asked for.
3. **Stream** — a matched file is proxied over HTTP with byte-range support, so Stremio can seek freely without downloading the whole thing first.

## Requirements

- Node.js v18+
- Your own Telegram account, with **your own** API credentials from [my.telegram.org](https://my.telegram.org) (never share these or reuse someone else's)
- At least one pinned Telegram chat, group, or bot that actually serves movie/series files

New here? See **[USAGE.md](USAGE.md)** for a full step-by-step walkthrough, from getting API credentials to adding the addon in Stremio.

## Quick start

```bash
npm install
cp .env.example .env       # then fill in your own TELEGRAM_API_ID / TELEGRAM_API_HASH
npm run telegram:login     # one-time: authenticate your Telegram account
npm start
```

Add to Stremio using:
```
http://127.0.0.1:7000/manifest.json
```

## Configuration (`.env`)

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | Your personal app credentials from my.telegram.org |
| `TELEGRAM_SESSION` | Written automatically by `npm run telegram:login` — don't edit by hand |
| `PORT` | HTTP port the addon listens on (default `7000`) |
| `CACHE_TTL` | How long (seconds) a resolved search is served from cache before re-searching (default `3600`) |

## Available scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the addon server |
| `npm run dev` | Same, restarting automatically on file changes |
| `npm run telegram:login` | One-time interactive login (phone + OTP + 2FA) |
| `npm run telegram:test` | Confirms the saved session can connect |
| `npm run telegram:chats` | Lists your groups/channels (handy for finding IDs) |
| `npm run search -- "Title"` | Tests the raw search engine from the CLI |

## Security notes

- Binds to all interfaces by default (there's no host restriction in code) — if you deploy this somewhere with a public IP, **anyone who reaches the URL can use it**, since there's no built-in authentication. Keep it on `127.0.0.1`/a private network, or add your own access control, unless you've deliberately decided otherwise.
- Nothing is written to disk except the small resolved-search-links cache (`.stream-cache/.resolved-streams.json`) — no video data ever touches disk.
- It only searches chats you're already a member of and have pinned — it doesn't join or scan anything on its own initiative beyond what a pinned bot's flow requires.

## Disclaimer

This project relies on the unofficial `gramjs` client and the Telegram MTProto API. Don't abuse the API by spamming search requests — Telegram will rate-limit (flood-wait) an account that does, sometimes for extended periods.
