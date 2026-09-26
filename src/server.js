import "dotenv/config";
import express from "express";
import cors from "cors";
import { manifest } from "./stremio/manifest.js";
import { createTelegramClient, createStreamClient } from "./telegram/client.js";
import { createStremioRouter } from "./routes/stremio.js";
import { streamTelegramFile } from "./streaming/proxy.js";


async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 7000);

  // Enable CORS for Stremio
  app.use(cors());

  app.get("/manifest.json", (_req, res) => {
    res.json(manifest);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "telegram-stremio" });
  });

  console.log("Initializing Telegram Client...");
  let telegramClient;
  try {
    telegramClient = createTelegramClient();
    await telegramClient.connect();
    const me = await telegramClient.getMe();
    console.log(`Telegram connected successfully as @${me.username || "no-username"}`);
    
    // Initialize the auto-forwarder to catch bot files
    const { setupForwarder } = await import("./telegram/forwarder.js");
    setupForwarder(telegramClient);
    console.log("Auto-forwarder initialized.");

    console.log("Initializing isolated Stream Client...");
    const streamClient = createStreamClient();
    await streamClient.connect();
    console.log("Stream Client connected (TCPFull).");
    
    // Internal proxy endpoint for streaming actual video files
    app.get("/stream/:chatId/:messageId/:filename", async (req, res) => {
      const { chatId, messageId, filename } = req.params;

      // Disable Express's default socket timeout for streaming responses
      req.socket.setTimeout(0);
      res.setTimeout(0);
      
      try {
        await streamTelegramFile(req, res, streamClient, chatId, parseInt(messageId), filename);
      } catch (error) {
        console.error("Streaming error:", error);
        if (!res.headersSent) {
          res.status(500).send("Streaming failed");
        }
      }
    });

    // Mount Stremio routes
    app.use(createStremioRouter(telegramClient, streamClient));
  } catch (error) {
    console.error("Failed to connect to Telegram:", error.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(` Telegram Stremio Addon is running!`);
    console.log(`========================================`);
    console.log(`\n Addon URL for Stremio:`);
    console.log(` http://127.0.0.1:${PORT}/manifest.json\n`);
  });

  // Prevent Node from killing long-running streaming connections.
  // Stremio keeps range connections open for minutes during playback.
  server.keepAliveTimeout = 0;       // disable TCP keep-alive timeout
  server.headersTimeout = 0;         // disable headers timeout
  server.timeout = 0;                // disable socket inactivity timeout
}

startServer();
