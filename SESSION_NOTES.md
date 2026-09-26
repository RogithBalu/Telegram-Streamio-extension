# Session Notes — Telegram Stremio Addon

This document summarizes the work done in one session: migrating the addon to a
personal Telegram account, getting it fully working end-to-end in Stremio, and
diagnosing/fixing several real bugs in the streaming pipeline along the way.

---

## 1. Migrated Telegram credentials to a personal account

The `.env` file was using a friend's `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` (and
their login session). Since the credentials belonged to someone else:

1. Created a new app at [my.telegram.org](https://my.telegram.org) under the
   user's own account to get a personal `api_id` / `api_hash`.
2. Updated `.env` with the new credentials and cleared the old `TELEGRAM_SESSION`.
3. Re-ran `npm run telegram:login` to authenticate as the user's own account,
   which wrote a fresh session string back into `.env`.
4. Verified with `npm run telegram:test` and `npm run telegram:chats`.

**Files touched:** `.env`

---

## 2. Bug: flood-wait from blindly re-joining channels

**Symptom:** Searching for a movie ("Salaar") triggered Telegram flood-wait
errors escalating to *"A wait of 286 seconds is required"*, and the search
returned 0 results.

**How it was found:** Reading the live server log during a real search showed
`forwarder.js` calling `ImportChatInvite` / `JoinChannel` repeatedly for the
**same** invite links, several times within the same second — once per
"force-join" bot prompt, with no check for whether the account was already a
member of that channel.

**Root cause:** `src/telegram/forwarder.js` treated every "join this channel"
button on every bot reply as something to act on unconditionally, including
channels the account had already joined seconds earlier from a different
result message. Telegram's anti-abuse system throttles repeated
`ImportChatInvite` calls, so this pattern reliably tripped a flood-wait.

**Fix:**
- Before joining an invite link, call `messages.CheckChatInvite` — if it comes
  back as `ChatInviteAlready`, skip joining entirely.
- Before joining a public channel, call `channels.GetParticipant` for `"me"` —
  if that succeeds, skip joining.
- Added a small in-memory join-lock/cache (10 minute TTL) keyed by
  invite-hash/username so concurrent bot prompts for the same channel can't
  double-fire a join, and so a channel already handled recently is never
  retried.

**Files touched:** `src/telegram/forwarder.js`

---

## 3. Bug: "Get File" buttons misclassified as join links

**Symptom:** After fixing the flood-wait, searches still returned 0 files. The
log showed `Failed to join public channel @c/3047239761/237965: Cannot find
any entity corresponding to "c/3047239761/237965"`.

**How it was found:** Recognized `t.me/c/<channelId>/<messageId>` as
Telegram's URL format for a **direct permalink to a specific message** inside a
channel — not a join/invite link at all. The button code was naively treating
any `t.me/...` URL without `?start=` as "something to join," so it tried
(and failed) to "join" a channel using a message-link fragment as if it were a
username.

**Root cause:** The bot's "Get File" button points straight at the file's
location in one of the user's already-joined "Files N" channels, rather than
sending the file directly. This link type wasn't handled at all.

**Fix:**
- Detect `t.me/c/<channelId>/<messageId>` links specifically.
- Resolve the channel entity from the account's joined-dialogs list (cached 5
  minutes) using the raw channel ID.
- Fetch that exact message, forward it into Saved Messages (required — see bug
  #4 below for why), and feed the resulting document into the same
  file-matching pipeline used for directly-DM'd files.

**Verified:** Re-tested via the real Stremio endpoint (`/stream/movie/tt….json`)
for both *Salaar* and *The Shawshank Redemption* — both returned multiple real,
correctly-parsed streams (resolution, codec, audio, size).

**Files touched:** `src/telegram/forwarder.js`

---

## 4. Bug: disk cache silently died after the first few seconds

**Symptom:** Playback was choppy throughout an entire movie, not just at the
start — reported as "audio playing somewhere, video full of lag."

**How it was found:** The player was observed reconnecting with a brand-new
HTTP range request roughly every 15–20 seconds (confirmed via server logs
showing repeated stream open/close cycles with no errors on the server side —
ruling out a crash or network fault as the cause). Reading
`src/streaming/proxy.js`'s cache-write logic revealed:

```js
if (start === 0 && !isProbe && !cacheManager.isComplete(fileKey, totalSize)) {
  // ...open disk cache write stream...
}
```

**Root cause:** Disk caching only ever activated for a request starting at
byte 0. Every reconnect after the very first one starts at some non-zero byte,
so caching silently turned off for the rest of the file — meaning *every*
15–20 second reconnect had to cold-fetch fresh from Telegram instead of
building a growing local cache.

**Fix:** Changed the condition to compare against the cache's actual current
end position (`start === cacheManager.getDownloadedBytes(fileKey)`), so
caching continues correctly on any request that picks up exactly where the
cache left off — not just the first one.

**Files touched:** `src/streaming/proxy.js`

---

## 5. Bug: "parallel workers" download code was dead — throughput capped at ~0.5 MB/s

**Symptom:** During real playback (*Meet Joe Black*, 1080p HEVC), logged
throughput was only 0.5–0.6 MB/s — too slow for smooth playback.

**How it was found:** The code computed a `workers` count and passed it into
`client.iterDownload({ ..., workers })`, implying multi-chunk parallel
downloading. Reading gramJS's own source
(`node_modules/telegram/requestIter.js` and `client/downloads.js`) confirmed
the installed version's downloader is **fully sequential** — one
`upload.GetFile` request at a time, always awaited before the next is sent.
The `workers` option isn't read anywhere in that code path. Throughput was
therefore capped purely by per-chunk network round-trip latency, with nothing
overlapping it.

**Fix:** Implemented a custom async generator, `iterDownloadParallel`, that
keeps several `upload.GetFile` requests genuinely in flight at once (via
`client.invokeWithSender`, confirmed to queue onto the shared connection
rather than blocking) and reassembles the results strictly in order. This
hides round-trip latency behind concurrent requests instead of paying it once
per megabyte.

**Files touched:** `src/streaming/proxy.js`

---

## 6. Bug (introduced, then fixed in the same session): server crash on unaligned offsets

**Symptom:** Shortly after deploying the parallel fetcher, the server process
crashed outright with an uncaught `RPCError: 400: OFFSET_INVALID`.

**How it was found:** Checked the crash log directly. Telegram's
`upload.GetFile` requires the requested byte `offset` to be aligned to the
chunk size — but a player resuming mid-file sends whatever arbitrary byte it
last read, almost never aligned. The new parallel fetcher passed that raw
offset straight through (unlike gramJS's own `GenericDownloadIter`, which
handles exactly this case by rounding down and trimming). On top of that, when
one of several concurrently in-flight requests failed, its rejection was never
`.catch()`-handled if the generator had already stopped consuming it — an
unhandled promise rejection, which crashes Node by default.

**Fix:**
- Round the fetch start down to the nearest 1 MB boundary, fetch from there,
  and trim the unwanted leading bytes off only the first yielded chunk (same
  technique gramJS's own fallback iterator uses).
- Attach a no-op `.catch()` to every in-flight request the moment it's
  launched, so a chunk that's never awaited can't crash the process — the real
  error still surfaces normally wherever that chunk *is* awaited.

**Verified:** Re-tested the exact byte offset that had crashed the server
before; it now streams cleanly with no errors, and throughput ramped from
3.2 MB/s up to 7.5 MB/s over the course of the request.

**Files touched:** `src/streaming/proxy.js`

---

## 7. Feature: persist resolved movie searches across restarts

**Problem:** Resolved stream links (which Telegram chat/message a given
quality came from) were only cached in memory for 1 hour
(`CACHE_TTL`). Every server restart during testing wiped that cache, forcing
the full slow bot-automation flow to re-run even for titles searched minutes
earlier.

**Fix:** Added disk persistence for the resolved-stream cache
(`.stream-cache/.resolved-streams.json`, already covered by `.gitignore`):
- Loaded back into memory on startup.
- Written to disk immediately whenever a new title is resolved, or an
  expired entry is evicted.
- The existing 1-hour freshness window is unchanged — this only means an
  already-searched title survives a restart instead of always starting cold.

**Files touched:** `src/resolver/movieResolver.js`

---

## Summary of files changed

| File | What changed |
|---|---|
| `.env` | Personal Telegram API credentials + fresh login session |
| `src/telegram/forwarder.js` | Membership check before joining channels (fixes flood-wait); resolves `t.me/c/...` file-permalink buttons instead of mis-treating them as joins |
| `src/streaming/proxy.js` | Disk cache now persists past the first request; real parallel chunk fetching (replacing dead sequential "workers" code); offset alignment + crash-safety fix |
| `src/resolver/movieResolver.js` | Resolved movie searches persisted to disk, surviving server restarts |

## End-to-end result

The addon now: authenticates as the user's own Telegram account, searches
pinned chats/bots without tripping Telegram's flood-wait protection, correctly
resolves files gated behind "join to unlock" bot flows, streams with
real (not fake) parallel chunk fetching for meaningfully higher throughput,
keeps a working disk cache across reconnects, and remembers previously
searched titles across server restarts.
