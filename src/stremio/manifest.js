export const manifest = {
  id: "com.telegram.personal",
  version: "1.0.0",
  name: "Telegram Personal Stream",
  description: "Stream movies and series directly from your authorized Telegram channels and groups.",
  logo: "https://telegram.org/img/t_logo.png",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};
