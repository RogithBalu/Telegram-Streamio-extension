# Usage Guide

A complete walkthrough for setting this addon up from scratch, using your own Telegram account. Nothing here needs programming knowledge beyond running the commands shown.

## 1. Get your own Telegram API credentials

This addon needs to sign in to Telegram as an app, not just as a user — that requires an `api_id` and `api_hash` tied to **your own** account. Never use credentials that belong to someone else; they're personal to the account that created them.

1. Go to [my.telegram.org](https://my.telegram.org) and log in with your own phone number.
2. Click **API development tools**.
3. Fill in the form — any values work:
   - **App title**: anything, e.g. `Stremio Addon`
   - **Short name**: anything alphanumeric, 5–32 characters
   - **URL**: optional, can be left blank
   - **Platform**: Desktop (or Other)
4. Submit. You'll be shown an **App api_id** and **App api_hash** — copy both, you'll need them next.

## 2. Install

```bash
git clone <this-repo-url>
cd <repo-folder>
npm install
```

## 3. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in the two values from step 1:
```
TELEGRAM_API_ID=<your api_id>
TELEGRAM_API_HASH=<your api_hash>
```
Leave `TELEGRAM_SESSION` blank — the next step fills it in for you.

## 4. Log in (one-time)

```bash
npm run telegram:login
```

You'll be prompted for:
- Your phone number, with country code (e.g. `+1...`)
- The login code Telegram sends to your Telegram app

  **Never share this code with anyone, including AI assistants or anyone claiming to be from Telegram** — it's the one thing standing between your account and a takeover.
- Your 2FA password, if you have one set

On success it prints "Login successful" and writes a session string straight into `.env` for you. You won't need to log in again unless you clear that value.

## 5. Choose what gets searched

The addon searches whatever is **pinned** in your Telegram account — nothing else. Two kinds of sources work:

- **A file-request bot** (recommended if you have one) — pin it, and the addon will message it directly with your search and walk through whatever "join this channel to unlock" flow it presents, automatically.
- **A channel or group** where movie/series files are actually posted as documents.

To add one: open it in Telegram → pin it (long-press on mobile, right-click on desktop → Pin).

If you have **both** a bot and a group/channel pinned, the addon prefers the bot (it's a more direct, faster path). Unpin/re-pin to change your mind at any time — no restart needed, it re-checks pins every 5 minutes.

## 6. Run it

```bash
npm start
```
or, if you're actively changing files and want auto-restart:
```bash
npm run dev
```

You'll see:
```
========================================
 Telegram Stremio Addon is running!
========================================

 Addon URL for Stremio:
 http://127.0.0.1:7000/manifest.json
```

## 7. Add it to Stremio

Open Stremio → **Addons** (puzzle-piece icon) → paste into the search/URL bar:
```
http://127.0.0.1:7000/manifest.json
```
Press Enter, then **Install** on the addon card that appears.

Since it's bound to your machine, this URL only works from the same computer unless you've deployed it somewhere with a public address (see the main [README](README.md) for the security implications of that before you do).

## 8. Watch something

Search for any movie or TV episode in Stremio as normal — the addon will show up in the streams list once it finds matches. For series, just pick the episode in Stremio's UI; the addon builds the right `Title SxxExx` search automatically, you never type it yourself.

**The first search for any given title is slow** (it has to message the bot/channel and wait for real replies, often 20–30 seconds) — after that, it's cached and comes back instantly for about an hour, or until the server restarts and you search it again.

## Troubleshooting

**"Flood wait" errors in the console** — Telegram is temporarily rate-limiting your account for a specific action (usually because of a lot of rapid searching/testing). The addon already stops itself cleanly when this happens rather than making it worse, but you still need to just wait out the cooldown — don't keep retrying, that extends it.

**No streams show up for a title** — check:
1. Is anything actually pinned? Run `npm run telegram:chats` to list what you're in, and confirm you've pinned at least one source.
2. Does that source actually have files matching what you searched? Try `npm run search -- "Title"` to test the raw search engine directly.
3. Check the server's console output — it logs exactly what it searched, what it found, and why candidates got rejected.

**Playback is slow/choppy** — this depends heavily on your Telegram account's current download speed, which Telegram itself can throttle. Nothing in this addon caches video to disk, so a slow connection to Telegram will show up directly as slow playback; there's no local buffer to fall back on.

**I want to log in as a different account** — clear `TELEGRAM_SESSION=` in `.env` (leave it blank) and run `npm run telegram:login` again.
