import { Api, errors } from "telegram";
import { waitingForDocument } from "./forwarder.js";

// Sleep utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Returns { floodWait: seconds } if Telegram rate-limited this call, otherwise null.
// `sourceUsername` is the bot we already sent the search to, if any — when the
// callback's deep-link points back at that same bot, we're already in that exact
// conversation, so re-invoking StartBot is redundant (and is what tripped the
// flood-wait); just let the forwarder pick up whatever the bot sends next.
async function simulateButtonClick(client, peer, msgId, button, sourceUsername) {
  try {
    let urlToOpen = button.url;

    if (button.className === "KeyboardButtonCallback") {
      console.log(`[Automation] Pressing callback button: ${button.text.substring(0,30)}...`);
      const ans = await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: peer,
          msgId: msgId,
          data: button.data
        })
      );
      if (ans && ans.url) {
        console.log(`[Automation] Callback returned URL: ${ans.url}`);
        urlToOpen = ans.url;
      }
    }

    if (urlToOpen) {
      const match = urlToOpen.match(/t\.me\/([^?]+)\?start=(.+)/);
      if (match) {
        const botUsername = match[1];
        const startParam = match[2];
        if (sourceUsername && botUsername.toLowerCase() === sourceUsername.toLowerCase()) {
          console.log(`[Automation] Already chatting with @${botUsername} directly — skipping redundant StartBot`);
        } else {
          console.log(`[Automation] Starting bot @${botUsername} with param ${startParam}`);
          await client.invoke(
            new Api.messages.StartBot({
              bot: botUsername,
              peer: botUsername,
              randomId: BigInt(Math.floor(Math.random() * 100000000000)),
              startParam: startParam
            })
          );
        }
      }
    }
    return null;
  } catch (err) {
    console.error("[Automation] Error clicking button:", err.message);
    if (err instanceof errors.FloodWaitError) {
      return { floodWait: err.seconds };
    }
    return null;
  }
}

export async function automateMovieRequest(client, query) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. Get Pinned Groups/Channels via GetPinnedDialogs (avoids getDialogs() crash
      //    and flood-wait issues). Cached for 5 minutes.
      const now = Date.now();
      if (!automateMovieRequest._dialogsCache || now - automateMovieRequest._dialogsTs > 5 * 60 * 1000) {
        const raw = await client.invoke(new Api.messages.GetPinnedDialogs({ folderId: 0 }));
        const chatsById = new Map((raw.chats || []).map(c => [String(c.id), c]));
        const usersById = new Map((raw.users || []).map(u => [String(u.id), u]));

        const allSources = (raw.dialogs || [])
          .map(d => {
            const peer = d.peer;
            if (!peer) return null;

            let id, entity;
            if (peer.className === "PeerUser" && peer.userId) {
              id = String(peer.userId);
              const user = usersById.get(id);
              if (!user || !user.bot) return null; // only search bots directly, not regular DMs
              entity = user.username
                ? user.username
                : new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash || BigInt(0) });
              return { entity, title: user.username || user.firstName || "bot", kind: "bot" };
            }
            if (peer.className === "PeerChannel" && peer.channelId) {
              id = String(peer.channelId);
              const chat = chatsById.get(id);
              if (!chat) return null;
              entity = chat.username
                ? chat.username
                : new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash || BigInt(0) });
              return { entity, title: chat.title || "channel", kind: "channel" };
            }
            if (peer.className === "PeerChat" && peer.chatId) {
              id = String(peer.chatId);
              const chat = chatsById.get(id);
              if (!chat) return null;
              entity = new Api.InputPeerChat({ chatId: chat.id });
              return { entity, title: chat.title || "group", kind: "group" };
            }
            return null;
          })
          .filter(Boolean);

        // Prefer a pinned bot DM (direct search, no group + StartBot deep-link
        // hop needed) over group/channel sources, falling back if none pinned.
        const bots = allSources.filter(s => s.kind === "bot");
        automateMovieRequest._dialogsCache = bots.length > 0 ? bots : allSources;

        automateMovieRequest._dialogsTs = now;
        console.log(`[Automation] Found ${automateMovieRequest._dialogsCache.length} pinned source(s):`,
          automateMovieRequest._dialogsCache.map(s => `${s.title} (${s.kind})`));
      }
      const sources = automateMovieRequest._dialogsCache;

      if (sources.length === 0) {
        return resolve([]);
      }

      // Register listener for our query — collect ALL files that arrive within the window
      const results = [];
      let collectTimeout;
      let finalized = false; // Flag to stop button-clicking once we have enough

      const finalize = () => {
        if (finalized) return;
        finalized = true;
        clearTimeout(collectTimeout);
        clearTimeout(absoluteTimeout);
        waitingForDocument.delete(query);
        console.log(`[Automation] ✅ Done collecting: ${results.length} files for '${query}'`);
        resolve(results);
      };

      // Absolute max timeout — resolve with whatever we have after 20 seconds
      const absoluteTimeout = setTimeout(finalize, 20000);

      waitingForDocument.set(query, (doc) => {
        if (finalized) return; // ignore late arrivals
        results.push(doc);
        console.log(`[Automation] 📥 File ${results.length} received for '${query}': ${doc.filename}`);
        
        // Reset the collection window — wait 4 more seconds for additional files
        clearTimeout(collectTimeout);
        collectTimeout = setTimeout(() => {
          finalize();
        }, 4000);
      });

      // 2. Send the request to pinned groups and click buttons
      for (const source of sources) {
        if (finalized) break; // Stop if we already have enough results
        console.log(`[Automation] Sending request for '${query}' in ${source.title}`);
        const sentMsg = await client.sendMessage(source.entity, { message: query });
        await sleep(2000); // Wait for bot to reply
        
        // 3. Fetch recent messages to find the bot's reply
        const msgs = await client.getMessages(source.entity, { limit: 10 });
        
        for (const msg of msgs) {
          if (finalized) break; // Stop clicking if already done
          // Ensure we only click buttons on messages that are a reply to OUR request
          const isReplyToUs = msg.replyTo && msg.replyTo.replyToMsgId === sentMsg.id;
          const mentionsUs = msg.message && msg.message.includes(query);
          
          if (!isReplyToUs && !mentionsUs) continue;

          // Check if message has inline buttons
          if (msg.replyMarkup && msg.replyMarkup.rows) {
            let pressedCount = 0;
            for (const row of msg.replyMarkup.rows) {
              if (finalized || pressedCount >= 5) break;
              for (const button of row.buttons) {
                if (finalized || pressedCount >= 5) break;
                const btnText = button.text.toLowerCase();
                const cleanQuery = query.toLowerCase().split(' ')[0];
                
                if (btnText.includes(cleanQuery) || btnText.includes("mb") || btnText.includes("gb") || btnText.includes("1080") || btnText.includes("720")) {
                  const sourceUsername = source.kind === "bot" ? source.title : null;
                  const result = await simulateButtonClick(client, source.entity, msg.id, button, sourceUsername);
                  pressedCount++;
                  if (result?.floodWait) {
                    // Telegram is rate-limiting this account for this action right now —
                    // every further click would fail the same way, so stop immediately
                    // instead of burning through the rest of the candidates for nothing.
                    console.warn(`[Automation] ⏳ Flood-wait (${result.floodWait}s) — stopping this search early, returning what we have.`);
                    finalize();
                    break;
                  }
                  await sleep(1500); // Don't spam
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[Automation] Engine error:", err);
      resolve([]);
    }
  });
}
