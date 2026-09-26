import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/env.js";
import { ConnectionTCPObfuscated } from "telegram/network/connection/index.js";
import { ConnectionTCPFull } from "telegram/network/connection/index.js";

export function createTelegramClient(session = config.telegramSession) {
  if (!config.telegramApiId || !config.telegramApiHash) {
    throw new Error("Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env");
  }

  const stringSession = new StringSession(session);

  return new TelegramClient(
    stringSession,
    Number(config.telegramApiId),
    config.telegramApiHash,
    { 
      connectionRetries: 5,
      connection: ConnectionTCPObfuscated
    }
  );
}

// Stream client uses TCPFull — less overhead than Obfuscated, faster throughput for large file transfers
export function createStreamClient(session = config.telegramSession) {
  if (!config.telegramApiId || !config.telegramApiHash) {
    throw new Error("Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env");
  }

  const stringSession = new StringSession(session);

  return new TelegramClient(
    stringSession,
    Number(config.telegramApiId),
    config.telegramApiHash,
    {
      connectionRetries: 10,
      connection: ConnectionTCPFull,   // faster for raw data transfers
      requestRetries: 5,
    }
  );
}
