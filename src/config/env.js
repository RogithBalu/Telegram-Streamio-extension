import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 7000),
  telegramApiId: process.env.TELEGRAM_API_ID,
  telegramApiHash: process.env.TELEGRAM_API_HASH,
  telegramSession: process.env.TELEGRAM_SESSION || ""
};
