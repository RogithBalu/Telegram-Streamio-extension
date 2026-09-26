import { Api } from "telegram";
import { parseFilename } from "../resolver/filenameParser.js";

export async function searchTelegram(client, query) {
  const results = [];
  try {
    // Dynamically fetch pinned chats to use as sources!
    const dialogs = await client.getDialogs();
    const sources = dialogs.filter(d => d.pinned && (d.isGroup || d.isChannel));

    if (sources.length === 0) {
      console.log("No pinned channels or groups found. Pin some chats in your Telegram app to search them.");
      return [];
    }

    // Search in each pinned chat
    for (const source of sources) {
      const messages = await client.invoke(
        new Api.messages.Search({
          peer: source.entity,
          q: query,
          filter: new Api.InputMessagesFilterDocument(),
          limit: 15,
        })
      );

      for (const msg of messages.messages) {
        if (!msg.media || !msg.media.document) continue;

        const doc = msg.media.document;
        // Find filename
        const filenameAttr = doc.attributes.find(
          (attr) => attr.className === "DocumentAttributeFilename"
        );
        const filename = filenameAttr ? filenameAttr.fileName : "Unknown";

        // Allow any file > 50MB since movies/episodes are large, and Telegram often uses obscure mime types
        const isLargeFile = doc.size > 50 * 1024 * 1024;
        const isVideoMime = doc.mimeType.startsWith("video/");
        const isVideoExt = filename.match(/\.(mkv|mp4|avi)$/i);
        
        if (!isLargeFile && !isVideoMime && !isVideoExt) {
          console.log(`Skipped (not a video/small file): ${filename} (${doc.mimeType}) - Size: ${doc.size}`);
          continue;
        }

        results.push({
          chatId: source.id.toString(),
          messageId: msg.id,
          filename: filename,
          size: doc.size,
          mimeType: doc.mimeType,
          messageDate: new Date(msg.date * 1000).toISOString(),
          source: source.title,
        });
      }
    }
  } catch (error) {
    console.error("Error during Telegram search:", error);
  }

  return results;
}
