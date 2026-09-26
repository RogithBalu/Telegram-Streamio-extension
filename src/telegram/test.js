import { createTelegramClient } from "./client.js";

async function main() {
  console.log("Testing Telegram connection...");
  let client;
  try {
    client = createTelegramClient();
    await client.connect();

    const isAuthorized = await client.checkAuthorization();
    if (!isAuthorized) {
      console.log("Session: INVALID (Not authorized)");
      process.exit(1);
    }
    console.log("Session: OK");

    const me = await client.getMe();
    if (me) {
      console.log("Logged-in account: OK");
      console.log(`User: ${me.firstName} ${me.lastName || ""} (@${me.username || "no-username"})`);
    }

    console.log("Telegram connection: OK");

  } catch (error) {
    console.error("Connection test failed:");
    console.error(error.message);
    process.exit(1);
  } finally {
    if (client) {
      await client.disconnect();
    }
  }
}

main();
