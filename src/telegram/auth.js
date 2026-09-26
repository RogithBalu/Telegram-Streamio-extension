import input from "input";
import { StringSession } from "telegram/sessions/index.js";
import { createTelegramClient } from "./client.js";
import { config } from "../config/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const client = createTelegramClient(new StringSession("").save());

  await client.start({
    phoneNumber: async () => input.text("Phone number: "),
    password: async () => input.text("2FA password (if enabled): "),
    phoneCode: async () => input.text("Telegram code: "),
    onError: (err) => console.error(err)
  });

  const session = client.session.save();

  console.log("\nLogin successful.");
  
  const envPath = path.resolve(__dirname, "../../.env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf-8");
    if (envContent.includes("TELEGRAM_SESSION=")) {
      envContent = envContent.replace(/TELEGRAM_SESSION=.*/g, `TELEGRAM_SESSION=${session}`);
    } else {
      envContent += `\nTELEGRAM_SESSION=${session}\n`;
    }
    fs.writeFileSync(envPath, envContent, "utf-8");
    console.log("Session saved to .env securely.");
  } else {
    console.log("\nAdd this value to your .env as TELEGRAM_SESSION:\n");
    console.log(session);
  }

  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
