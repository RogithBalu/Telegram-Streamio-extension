import { createTelegramClient } from "./client.js";
import { searchTelegram } from "./search.js";

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error("Usage: npm run search -- <query>");
    process.exit(1);
  }

  let client;
  try {
    client = createTelegramClient();
    await client.connect();

    console.log(`Searching Telegram pinned chats for: "${query}"...`);
    const results = await searchTelegram(client, query);
    
    console.log(`\nFound ${results.length} candidate files.\n`);
    results.forEach((r, i) => {
      console.log(`${i + 1}. [${r.source}] ${r.filename}`);
      console.log(`   Size: ${(r.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Date: ${r.messageDate}`);
    });
    
  } catch (error) {
    console.error("Search failed:", error.message);
  } finally {
    if (client) {
      await client.disconnect();
    }
    process.exit(0);
  }
}

main();
