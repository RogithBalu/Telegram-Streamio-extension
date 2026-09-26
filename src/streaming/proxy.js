import { parseRangeHeader } from "./range.js";
import { Api, errors } from "telegram";
import bigInt from "big-integer";

const documentCache = new Map();
const dcSenderCache = new Set();
const activeStreams = new Map();

function killStaleStreams(chatIdStr, messageId) {
  const currentFile = `${chatIdStr}|${messageId}`;
  let killed = 0;
  for (const [key, info] of activeStreams.entries()) {
    if (info.file !== currentFile) {
      console.log(`[Proxy] 🔪 Killing stale stream: "${info.filename}" @ byte ${info.start}`);
      try { info.res.destroy(); } catch (e) {}
      killed++;
    }
  }
  if (killed > 0) console.log(`[Proxy] 🔪 Killed ${killed} stale stream(s)`);
}

function logActiveStreams() {
  if (activeStreams.size === 0) {
    console.log(`[Proxy] 📡 Active streams: NONE`);
  } else {
    console.log(`[Proxy] 📡 Active streams (${activeStreams.size}):`);
    for (const [, info] of activeStreams.entries()) {
      console.log(`  → "${info.filename}" @ byte ${info.start}`);
    }
  }
}

async function getDocument(client, chatIdStr, messageId) {
  const cacheKey = `${chatIdStr}_${messageId}`;
  if (documentCache.has(cacheKey)) return documentCache.get(cacheKey);

  const messages = await client.invoke(
    new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] })
  );
  if (!messages.messages?.length) throw new Error("Message not found");
  const msg = messages.messages[0];
  if (!msg.media?.document) throw new Error("Message has no document media");

  documentCache.set(cacheKey, msg.media.document);
  if (documentCache.size > 100) documentCache.delete(documentCache.keys().next().value);
  return msg.media.document;
}

async function waitDrain(res) {
  return new Promise(resolve => {
    const onDrain = () => { res.removeListener("close", onClose); resolve(); };
    const onClose = () => { res.removeListener("drain", onDrain); resolve(); };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

const REQ_SIZE = 1024 * 1024; // 1 MB per Telegram chunk

// gramJS's built-in iterDownload only ever has one upload.GetFile request in
// flight at a time — throughput is capped by round-trip latency alone, which
// is what was causing the very low (~0.5 MB/s) speeds during playback. This
// keeps `concurrency` requests in flight at once (MTProto multiplexes several
// outstanding requests over one connection) and yields the chunks back in
// order, so a slow round trip is hidden behind the ones already in flight.
//
// Telegram requires the `offset` in upload.GetFile to be aligned to the chunk
// size (a player's resume position rarely is), so we fetch from the aligned
// offset at or before it and trim the unwanted leading bytes off the first
// chunk locally, same trick gramJS's own GenericDownloadIter uses.
async function* iterDownloadParallel(client, { fileLocation, offset, fileSize, dcId, concurrency }) {
  let sender = await client.getSender(dcId);
  const inFlight = new Map(); // offset -> Promise<Buffer> (always has a .catch attached, see launch())

  const launch = (off) => {
    const request = new Api.upload.GetFile({
      location: fileLocation,
      offset: bigInt(off),
      limit: REQ_SIZE
    });
    const p = (async () => {
      let timedOut = false;
      for (;;) {
        try {
          const result = await client.invokeWithSender(request, sender);
          if (result instanceof Api.upload.FileCdnRedirect) {
            throw new Error("CDN download not supported");
          }
          return Buffer.from(result.bytes);
        } catch (e) {
          if (e.errorMessage === "TIMEOUT" && !timedOut) {
            timedOut = true;
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          if (e instanceof errors.FileMigrateError) {
            sender = await client.getSender(e.newDc);
            continue;
          }
          throw e;
        }
      }
    })();
    // A chunk we never end up awaiting (e.g. the caller stopped early after an
    // earlier chunk failed) must not become an unhandled rejection and crash
    // the process — the real error is still delivered wherever this same
    // promise IS awaited, below.
    p.catch(() => {});
    inFlight.set(off, p);
  };

  const alignedStart = offset - (offset % REQ_SIZE);
  const leadingTrim = offset - alignedStart;

  let launchOffset = alignedStart;
  for (let i = 0; i < concurrency; i++) {
    if (fileSize !== undefined && launchOffset >= fileSize) break;
    launch(launchOffset);
    launchOffset += REQ_SIZE;
  }

  let yieldOffset = alignedStart;
  let first = true;
  while (inFlight.has(yieldOffset)) {
    let buf = await inFlight.get(yieldOffset);
    inFlight.delete(yieldOffset);

    const isLast = buf.length < REQ_SIZE || (fileSize !== undefined && yieldOffset + buf.length >= fileSize);
    if (!isLast && (fileSize === undefined || launchOffset < fileSize)) {
      launch(launchOffset);
      launchOffset += REQ_SIZE;
    }

    if (first) {
      buf = buf.subarray(leadingTrim);
      first = false;
    }

    yield buf;
    yieldOffset += REQ_SIZE;

    if (isLast) break;
  }
}

// The player reliably reconnects with a fresh range request every ~15-20s
// during real playback (confirmed by observation) — so a single connection
// still running well past that with no sign of the client actually reading
// almost certainly means the player was closed/navigated away from without
// the socket ever being torn down, and it'll otherwise happily keep pulling
// data (and hogging a Telegram connection slot) for the rest of the file.
const ZOMBIE_TIMEOUT_MS = 60 * 1000;

export async function streamTelegramFile(req, res, client, chatIdStr, messageId, filename) {
  let aborted = false;
  let streamKey = null;
  let zombieTimer = null;

  const cleanupTimer = () => {
    if (zombieTimer) { clearTimeout(zombieTimer); zombieTimer = null; }
  };

  req.on("close", () => {
    aborted = true;
    cleanupTimer();
    if (streamKey) {
      const info = activeStreams.get(streamKey);
      activeStreams.delete(streamKey);
      console.log(`[Proxy] ⛔ Closed: "${info?.filename || "unknown"}" @ byte ${info?.start} (${activeStreams.size} still active)`);
      if (activeStreams.size > 0) logActiveStreams();
    }
  });

  try {
    const document = await getDocument(client, chatIdStr, messageId);
    const totalSize = Number(document.size);

    // ── Parse range BEFORE writing headers ──────────────────────────────────
    let start = 0;
    let end = totalSize - 1;
    let chunkSize = totalSize;
    let isProbe = false;
    let hasRange = false;

    if (req.headers.range) {
      try {
        const range = parseRangeHeader(req.headers.range, totalSize);
        start = range.start;
        end = range.end;
        chunkSize = range.chunkSize;
        isProbe = chunkSize < 5 * 1024 * 1024;
        hasRange = true;
      } catch {
        res.status(416).send("Requested Range Not Satisfiable");
        return;
      }
    }

    // ── File location & DC pre-warm ─────────────────────────────────────────
    const fileLocation = new Api.InputDocumentFileLocation({
      id: document.id,
      accessHash: document.accessHash,
      fileReference: document.fileReference,
      thumbSize: ""
    });
    const fileDcId = Number(document.dcId || document.dc_id);
    fileLocation.dcId = fileDcId;

    if (fileDcId && !dcSenderCache.has(fileDcId)) {
      console.log(`[Proxy] Pre-warming connection to DC ${fileDcId}...`);
      try {
        await client.getSender(fileDcId);
        dcSenderCache.add(fileDcId);
        console.log(`[Proxy] DC ${fileDcId} ready.`);
      } catch (e) {
        console.warn(`[Proxy] DC ${fileDcId} pre-warm failed:`, e.message);
      }
    }

    if (aborted) return;

    const filenameAttr = document.attributes?.find(a => a.className === "DocumentAttributeFilename");
    const docFilename = filenameAttr ? filenameAttr.fileName : (filename || "unknown");
    const mimeType = document.mimeType || "application/octet-stream";

    streamKey = `${chatIdStr}|${messageId}|${start}`;
    const streamInfo = { filename: docFilename, start, file: `${chatIdStr}|${messageId}`, res };
    activeStreams.set(streamKey, streamInfo);
    if (!isProbe) killStaleStreams(chatIdStr, messageId);
    console.log(`[Proxy] ▶ "${docFilename}" @ byte ${start} (${activeStreams.size} active)`);

    if (!isProbe) {
      zombieTimer = setTimeout(() => {
        console.warn(`[Proxy] 🧟 "${docFilename}" @ byte ${start} ran ${ZOMBIE_TIMEOUT_MS / 1000}s straight with no reconnect — assuming abandoned, closing it.`);
        aborted = true;
        try { res.destroy(); } catch {}
      }, ZOMBIE_TIMEOUT_MS);
    }

    // ── Stream straight from Telegram — nothing is ever written to disk ────
    if (hasRange) {
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mimeType
      });
    } else {
      res.writeHead(200, {
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Content-Type": mimeType
      });
    }

    const TOTAL_WORKERS = 4;
    const streamWorkers = Math.max(1, Math.floor(TOTAL_WORKERS / Math.max(1, activeStreams.size)));
    const workers = isProbe ? 1 : streamWorkers;
    console.log(`[Proxy] Workers: ${workers} (${isProbe ? "probe" : "stream"}, ${activeStreams.size} active)`);

    req.socket.setNoDelay(true);

    const iter = iterDownloadParallel(client, {
      fileLocation,
      offset: start,
      fileSize: totalSize,
      dcId: fileDcId,
      concurrency: workers
    });

    let downloaded = 0;
    let throughputBytes = 0;
    let throughputTs = Date.now();

    for await (const chunk of iter) {
      if (aborted || req.socket.destroyed) break;
      if (!chunk) break;

      const chunkData = Buffer.from(chunk);

      const remaining = chunkSize - downloaded;
      if (remaining <= 0) break;

      const toWrite = chunkData.length > remaining ? chunkData.slice(0, remaining) : chunkData;
      downloaded += toWrite.length;
      throughputBytes += toWrite.length;

      if (throughputBytes >= 5 * 1024 * 1024) {
        const elapsed = (Date.now() - throughputTs) / 1000;
        const mbps = ((throughputBytes / 1024 / 1024) / elapsed).toFixed(1);
        console.log(`[Proxy] ⚡ "${docFilename}" speed: ${mbps} MB/s`);
        throughputBytes = 0;
        throughputTs = Date.now();
      }

      const ok = res.write(toWrite);
      if (!ok && !aborted) await waitDrain(res);
    }

    cleanupTimer();
    res.end();

  } catch (error) {
    cleanupTimer();
    if (aborted) return;
    console.error(`[Proxy] Streaming error for ${chatIdStr}_${messageId}:`, error.message);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    } else {
      res.end();
    }
  }
}
