import { createTelegramClient } from "./client.js";

async function main() {
  let client;
  try {
    client = createTelegramClient();
    await client.connect();

    console.log("Fetching your chats/channels...");
    const dialogs = await client.getDialogs();
    
    console.log("\n--- Your Groups & Channels ---");
    let count = 0;
    for (const dialog of dialogs) {
      if (dialog.isGroup || dialog.isChannel) {
        console.log(`ID: ${dialog.id} | Name: ${dialog.title}`);
        count++;
      }
    }
    console.log(`\nFound ${count} groups/channels.`);
    
  } catch (error) {
    console.error("Error listing chats:", error.message);
  } finally {
    if (client) {
      await client.disconnect();
    }
    process.exit(0);
  }
}

main();
