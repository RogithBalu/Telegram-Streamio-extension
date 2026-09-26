import express from "express";
import { resolveStreams } from "../resolver/movieResolver.js";
import { streamTelegramFile } from "../streaming/proxy.js";

export function createStremioRouter(telegramClient, streamClient) {
  const router = express.Router();

  // Stremio stream endpoint
  router.get("/stream/:type/:id.json", async (req, res) => {
    const { type, id } = req.params;

    if (type !== "movie" && type !== "series") {
      return res.json({ streams: [] });
    }

    try {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const streams = await resolveStreams(telegramClient, id, type, baseUrl);
      res.json({ streams });
    } catch (error) {
      console.error("Error resolving streams:", error);
      res.json({ streams: [] });
    }
  });

  // Internal proxy endpoint for streaming actual video files
  router.get("/stream/:chatId/:messageId/:filename", async (req, res) => {
    const { chatId, messageId } = req.params;
    
    try {
      await streamTelegramFile(req, res, streamClient, chatId, parseInt(messageId));
    } catch (error) {
      console.error("Streaming error:", error);
      if (!res.headersSent) {
        res.status(500).send("Streaming failed");
      }
    }
  });

  return router;
}
