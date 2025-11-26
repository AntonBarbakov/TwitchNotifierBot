// Node.js 18+ (global fetch available)
// This bot polls Twitch API for a list of logins and sends a message to a Telegram

if (!process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_PROJECT_ID) { // loads .env from project root
  require('dotenv').config();
}

// Load environment variables ---
const {
  TELEGRAM_BOT_TOKEN,      // Bot token from @BotFather
  TELEGRAM_CHAT_ID,        // Target chat ID (e.g., -100123...), or @channel_username
  TWITCH_CLIENT_ID,        // Twitch app Client ID
  TWITCH_CLIENT_SECRET,    // Twitch app Client Secret
  TWITCH_LOGINS,           // Comma-separated Twitch logins, e.g. "shroud,riotgames"
  POLL_SECONDS = "60",     // Poll interval in seconds (default: 60)
} = process.env;

// Load helper methods (moved to a separate file)
const {
  requireEnv,
  getAppToken,
  getUserIds,
  getLiveStreams,
  tgSendStream,
  startDeletionLoop,
} = require('./methods');

// Validate required envs early ---
requireEnv("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);
requireEnv("TELEGRAM_CHAT_ID", TELEGRAM_CHAT_ID);
requireEnv("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
requireEnv("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);
requireEnv("TWITCH_LOGINS", TWITCH_LOGINS);

/**
 * Main entrypoint for the bot. Resolves Twitch user IDs from configured
 * logins, then enters a polling loop that periodically checks which users
 * are live and sends notifications to Telegram when a user starts streaming.
 * Also starts a background cleanup loop to remove old bot messages from
 * Telegram.
 * @returns {Promise<void>} Resolves when the bot shuts down (normally or via signal).
 */
async function main() {
  console.log("Starting twitch2telegram (Node)…");

  // Start periodic deletion loop that removes messages older than one hour.
  // Note: deleting messages in channels requires the bot to be an admin.
  startDeletionLoop();

  const logins = TWITCH_LOGINS.split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean); // remove empty strings

  if (!logins.length) {
    console.error("No valid Twitch logins in TWITCH_LOGINS.");
    process.exit(1);
  }

  const loginToId = await getUserIds(logins);
  const ids = Object.values(loginToId);

  if (!ids.length) {
    console.error("Could not resolve any Twitch user IDs. Check TWITCH_LOGINS and API credentials.");
    process.exit(1);
  }

  // Track who is already live to avoid duplicate notifications.
  const wasLive = Object.fromEntries(ids.map(id => [id, false]));
  const delayMs = Math.max(5, Number(POLL_SECONDS)) * 1000; // minimum 5s for safety

  // graceful shutdown
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; console.log("\nShutting down…"); });
  process.on("SIGTERM", () => { stopped = true; console.log("\nShutting down…"); });

  // Simple forever loop with delay
  while (!stopped) {
    try {
      const liveNow = await getLiveStreams(ids);

      for (const uid of ids) {
        const isLive = Boolean(liveNow[uid]);
        if (isLive && !wasLive[uid]) {
          await tgSendStream(liveNow[uid]);
        }
        wasLive[uid] = isLive;
      }
    } catch (err) {
      // Common reasons: network hiccup, expired token, invalid credentials
      console.error("Loop error:", err?.message || err);
      try { await getAppToken(); } catch (e2) { console.error("Token refresh error:", e2?.message || e2); }
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  process.exit(0);
}

// KICK OFF
main().catch(err => {
  console.error("Fatal startup error:", err?.message || err);
  process.exit(1);
});