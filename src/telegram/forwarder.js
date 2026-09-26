import { Api } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { parseFilename } from "../resolver/filenameParser.js";

// Global map to resolve promises when a document is forwarded
export const waitingForDocument = new Map();

// Dedupes join attempts across concurrent bot prompts for the same channel,
// and remembers the outcome for a while so we never re-attempt a channel we're
// already in (this is what was tripping Telegram's ImportChatInvite flood-wait).
const joinState = new Map(); // key -> { status: "pending"|"already"|"joined"|"failed", ts, promise }
const JOIN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function withJoinLock(key, performJoin) {
  const cached = joinState.get(key);
  if (cached) {
    if (cached.status === "pending") {
      await cached.promise; // another prompt is already joining this exact channel
      return;
    }
    if (cached.status !== "failed" && Date.now() - cached.ts < JOIN_CACHE_TTL) {
      return; // already a member or already joined recently — skip
    }
  }

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  joinState.set(key, { status: "pending", ts: Date.now(), promise: pending });

  try {
    const status = await performJoin();
    joinState.set(key, { status, ts: Date.now() });
  } catch (e) {
    joinState.set(key, { status: "failed", ts: Date.now() });
    throw e;
  } finally {
    release();
  }
}

async function ensureJoinedByInvite(client, hash) {
  if (!hash) return;
  await withJoinLock(`invite:${hash}`, async () => {
    try {
      const invite = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
      if (invite.className === "ChatInviteAlready") {
        console.log(`[Forwarder] Already a member — skipping join for invite ${hash}`);
        return "already";
      }
      console.log(`[Forwarder] Joining forced channel via invite ${hash}...`);
      await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      console.log(`[Forwarder] Successfully joined channel via invite ${hash}.`);
      return "joined";
    } catch (e) {
      console.error(`[Forwarder] Failed to join/check invite ${hash}:`, e.message);
      return "failed";
    }
  }).catch(() => {});
}

async function ensureJoinedByUsername(client, username) {
  if (!username) return;
  await withJoinLock(`user:${username}`, async () => {
    try {
      await client.invoke(new Api.channels.GetParticipant({ channel: username, participant: "me" }));
      console.log(`[Forwarder] Already a member of @${username} — skipping join.`);
      return "already";
    } catch (e) {
      try {
        console.log(`[Forwarder] Joining public channel @${username}...`);
        await client.invoke(new Api.channels.JoinChannel({ channel: username }));
        console.log(`[Forwarder] Successfully joined public channel: ${username}`);
        return "joined";
      } catch (joinErr) {
        console.error(`[Forwarder] Failed to join public channel @${username}:`, joinErr.message);
        return "failed";
      }
    }
  }).catch(() => {});
}

// Cache of all joined dialogs, used to resolve raw channel IDs from t.me/c/<id>/<msg>
// links (those links carry no access hash, only the entity cache from getDialogs has it).
let dialogsCache = null;
let dialogsCacheTs = 0;
const DIALOGS_CACHE_TTL = 5 * 60 * 1000;

async function getJoinedChannelEntity(client, channelId) {
  const now = Date.now();
  if (!dialogsCache || now - dialogsCacheTs > DIALOGS_CACHE_TTL) {
    dialogsCache = await client.getDialogs({});
    dialogsCacheTs = now;
  }
  let dialog = dialogsCache.find(d => d.isChannel && String(d.entity.id) === String(channelId));
  if (!dialog) {
    // Not found — refresh once in case it's a very recent join, then give up.
    dialogsCache = await client.getDialogs({});
    dialogsCacheTs = Date.now();
    dialog = dialogsCache.find(d => d.isChannel && String(d.entity.id) === String(channelId));
  }
  return dialog ? dialog.entity : null;
}

// Forwards a message into Saved Messages so proxy.js (which only resolves
// messages via the plain "me"-scoped message space) can stream it later.
// Falls back to streaming straight from its original chat if forwarding is blocked.
async function forwardToSavedMessages(client, fromPeer, msgId, inlineDoc) {
  try {
    const forwarded = await client.invoke(
      new Api.messages.ForwardMessages({
        fromPeer,
        id: [msgId],
        toPeer: "me",
        randomId: [BigInt(Math.floor(Math.random() * 100000000000))]
      })
    );
    const newMsgUpdate = forwarded?.updates?.find(u => u.className === "UpdateNewMessage");
    if (newMsgUpdate?.message?.media?.document) {
      return { chatId: "me", messageId: newMsgUpdate.message.id, doc: newMsgUpdate.message.media.document };
    }
  } catch (err) {
    if (err.message.includes("CHAT_FORWARDS_RESTRICTED") && inlineDoc) {
      console.warn("[Forwarder] Chat restricts forwarding. Serving stream directly from source chat! Note: it may get deleted later.");
      const chatId = fromPeer.userId ? fromPeer.userId.toString()
        : fromPeer.channelId ? fromPeer.channelId.toString()
        : String(fromPeer);
      return { chatId, messageId: msgId, doc: inlineDoc };
    }
    console.error("[Forwarder] Error forwarding document to Saved Messages:", err.message);
  }
  return null;
}

function dispatchDocument(chatId, messageId, doc) {
  const filenameAttr = doc.attributes.find(a => a.className === "DocumentAttributeFilename");
  const filename = filenameAttr ? filenameAttr.fileName : "Unknown";

  for (const [query, resolver] of waitingForDocument.entries()) {
    const cleanFilename = filename.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (cleanFilename.includes(cleanQuery)) {
      console.log(`[Forwarder] Matched file for query '${query}': ${filename}`);
      const parsed = parseFilename(filename);
      resolver({
        chatId,
        messageId,
        filename,
        size: doc.size,
        mimeType: doc.mimeType,
        resolution: parsed.resolution,
        source: parsed.source,
        codec: parsed.codec,
        audio: parsed.audio
      });
      // Don't delete or break the listener — keep collecting more files for the same query!
      break;
    }
  }
}

// Handles a "Get File"-style button that links directly at a message inside a
// channel we've already joined (t.me/c/<channelId>/<messageId>), rather than a
// bot deep-link or a channel invite.
async function followChannelMessageLink(client, channelId, messageId) {
  try {
    const entity = await getJoinedChannelEntity(client, channelId);
    if (!entity) {
      console.warn(`[Forwarder] Can't open file link — not a member of channel ${channelId}`);
      return;
    }
    const messages = await client.getMessages(entity, { ids: [Number(messageId)] });
    const msg = messages && messages[0];
    if (!msg || !msg.media || !msg.media.document) {
      console.warn(`[Forwarder] File link t.me/c/${channelId}/${messageId} has no document`);
      return;
    }
    const result = await forwardToSavedMessages(client, entity, msg.id, msg.media.document);
    if (result) {
      console.log(`[Forwarder] Resolved file link t.me/c/${channelId}/${messageId}`);
      dispatchDocument(result.chatId, result.messageId, result.doc);
    }
  } catch (e) {
    console.error(`[Forwarder] Failed to resolve file link t.me/c/${channelId}/${messageId}:`, e.message);
  }
}

// Follows a bot deep-link (e.g. "Get File" -> t.me/bot?start=xxx) or a plain
// callback button (e.g. "Verify" / "Try Again").
async function followActionButton(client, msg, button) {
  try {
    if (button.className === "KeyboardButtonUrl" && button.url) {
      const match = button.url.match(/t\.me\/([^?]+)\?start=(.+)/);
      if (match) {
        const [, botUsername, startParam] = match;
        console.log(`[Forwarder] Following "${button.text}" -> starting @${botUsername}`);
        await client.invoke(new Api.messages.StartBot({
          bot: botUsername,
          peer: botUsername,
          randomId: BigInt(Math.floor(Math.random() * 100000000000)),
          startParam
        }));
      }
    } else if (button.className === "KeyboardButtonCallback") {
      console.log(`[Forwarder] Pressing button "${button.text}"`);
      await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer: msg.peerId,
        msgId: msg.id,
        data: button.data
      }));
    }
  } catch (e) {
    console.error(`[Forwarder] Failed to follow button "${button.text}":`, e.message);
  }
}

export function setupForwarder(client) {
  // Listen to new private messages (usually from bots sending files)
  client.addEventHandler(async (event) => {
    const msg = event.message;

    // Check if message has a document
    if (msg.media && msg.media.document) {
      const result = await forwardToSavedMessages(client, msg.peerId, msg.id, msg.media.document);
      if (result) dispatchDocument(result.chatId, result.messageId, result.doc);
    } else if (msg.isPrivate && msg.replyMarkup && msg.replyMarkup.rows) {
      const joinButtons = [];
      const fileLinkButtons = [];
      const actionButtons = [];

      for (const row of msg.replyMarkup.rows) {
        for (const button of row.buttons) {
          const url = button.className === "KeyboardButtonUrl" ? button.url : null;
          const cLinkMatch = url && url.match(/t\.me\/c\/(\d+)\/(\d+)/);

          if (cLinkMatch) {
            fileLinkButtons.push({ button, channelId: cLinkMatch[1], messageId: cLinkMatch[2] });
          } else if (url && (url.includes("t.me/+") || url.includes("t.me/joinchat/") ||
              (url.includes("t.me/") && !url.includes("?start=")))) {
            joinButtons.push(button);
          } else {
            actionButtons.push(button);
          }
        }
      }

      // A bare search-results list (language/quality filters, one button per
      // file, pagination) has neither a join link nor a direct file-permalink —
      // only an actual "force-join then get file" prompt does. Without this
      // gate we were blindly pressing every button on the results list itself
      // (search filters, every file entry, pagination) on top of whatever
      // automation.js already clicked deliberately — doubling StartBot calls
      // and escalating Telegram's flood-wait far worse than necessary.
      if (joinButtons.length === 0 && fileLinkButtons.length === 0) {
        return;
      }

      console.log(`[Forwarder] Received bot prompt in PM. Checking for Force-Join...`);

      // Step 1: make sure we're in every required channel (skips ones we're already in)
      for (const button of joinButtons) {
        const url = button.url;
        if (url.includes("t.me/+") || url.includes("t.me/joinchat/")) {
          const hash = url.split("t.me/+")[1] || url.split("t.me/joinchat/")[1];
          await ensureJoinedByInvite(client, hash);
        } else {
          const username = url.split("t.me/")[1].split("?")[0];
          await ensureJoinedByUsername(client, username);
        }
      }

      // Step 2: pull files that are linked directly (no join/click needed, we're already a member)
      for (const { channelId, messageId } of fileLinkButtons) {
        await followChannelMessageLink(client, channelId, messageId);
      }

      // Step 3: follow the remaining buttons (e.g. "Verify", "Try Again")
      for (const button of actionButtons) {
        await followActionButton(client, msg, button);
      }
    }
  }, new NewMessage({ incoming: true }));
}
