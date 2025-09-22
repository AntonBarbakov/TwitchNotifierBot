// ==== index.js ====
// Node.js 18+ (global fetch available)
// This bot polls Twitch API for a list of logins and sends a message to a Telegram
// chat/group/channel when a stream goes live.
//
// IMPORTANT: This version loads secrets from a local .env file stored in the repo.
// Keep the repository PRIVATE to avoid leaking tokens.

require('dotenv').config(); // loads .env from project root

// --- 1) Load environment variables ---
const {
  TELEGRAM_BOT_TOKEN,      // Bot token from @BotFather
  TELEGRAM_CHAT_ID,        // Target chat ID (e.g., -100123...), or @channel_username
  TWITCH_CLIENT_ID,        // Twitch app Client ID
  TWITCH_CLIENT_SECRET,    // Twitch app Client Secret
  TWITCH_LOGINS,           // Comma-separated Twitch logins, e.g. "shroud,riotgames"
  POLL_SECONDS = "60",     // Poll interval in seconds (default: 60)
} = process.env;

// --- 2) Validate required envs early ---
function requireEnv(name, value) {
  if (!value || String(value).trim() === "") {
    console.error(`❗ Missing required env: ${name}`);
    process.exit(1);
  }
}
requireEnv("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);
requireEnv("TELEGRAM_CHAT_ID", TELEGRAM_CHAT_ID);
requireEnv("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
requireEnv("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);
requireEnv("TWITCH_LOGINS", TWITCH_LOGINS);

// --- 3) State for Twitch App Access Token ---
let TWITCH_TOKEN = null;          // current bearer token
let TWITCH_TOKEN_EXPIRES_AT = 0;  // epoch ms when token should be refreshed

// --- 4) Acquire/refresh Twitch App Access Token (client_credentials flow) ---
async function getAppToken() {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Twitch token error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  TWITCH_TOKEN = data.access_token;

  // Refresh 5 minutes before actual expiration to be safe.
  const ttlSec = Number(data.expires_in || 3600);
  TWITCH_TOKEN_EXPIRES_AT = Date.now() + Math.max(ttlSec - 300, 300) * 1000;
}

// --- 5) Build headers for Twitch Helix calls, refreshing token when needed ---
async function twitchHeaders() {
  if (!TWITCH_TOKEN || Date.now() > TWITCH_TOKEN_EXPIRES_AT) {
    await getAppToken();
  }
  return {
    "Client-ID": TWITCH_CLIENT_ID,
    "Authorization": `Bearer ${TWITCH_TOKEN}`,
  };
}

// --- 6) Resolve Twitch logins -> user IDs (done once on startup) ---
async function getUserIds(logins) {
  // Returns a map: { loginLowerCase: user_id }
  const map = {};
  for (let i = 0; i < logins.length; i += 100) {
    const batch = logins.slice(i, i + 100);
    const qs = batch.map(l => `login=${encodeURIComponent(l)}`).join("&");
    const res = await fetch(`https://api.twitch.tv/helix/users?${qs}`, {
      headers: await twitchHeaders(),
    });
    if (!res.ok) throw new Error(`users error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    for (const u of data.data || []) {
      map[u.login.toLowerCase()] = u.id;
    }
  }
  return map;
}

// --- 7) Query who is LIVE for a list of user IDs ---
// Returns { user_id: streamObject } only for users currently live.
async function getLiveStreams(userIds) {
  const live = {};
  if (!userIds.length) return live;

  for (let i = 0; i < userIds.length; i += 100) {
    const batch = userIds.slice(i, i + 100);
    const qs = batch.map(id => `user_id=${id}`).join("&");
    const res = await fetch(`https://api.twitch.tv/helix/streams?${qs}`, {
      headers: await twitchHeaders(),
    });
    if (!res.ok) throw new Error(`streams error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    for (const s of data.data || []) {
      // s.type === "live"
      live[s.user_id] = s;
    }
  }
  return live;
}

// --- 8) Send a message to Telegram ---
// `TELEGRAM_CHAT_ID` can be numeric (-100...) or string "@channel_username".
async function tgSend(text, disablePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview,
    }),
  });
  if (!res.ok) {
    console.error("Telegram error:", await res.text());
  }
}

// --- 9) Human-friendly message formatting for a Twitch stream object ---
function formatMsg(s) {
  const user = s.user_name || "";
  const login = s.user_login || "";
  const title = s.title || "";
  const game = s.game_name || "Unknown game";
  const url = `https://twitch.tv/${login}`;
  const started = s.started_at || "";
  const viewers = s.viewer_count || 0;

  // Twitch thumbnail uses placeholders {width} and {height}
  const thumb = (s.thumbnail_url || "").replace("{width}", "1280").replace("{height}", "720");

  return (
    `🔴 <b>${escapeHtml(user)}</b> is live!\n` +
    `🎮 <b>${escapeHtml(game)}</b>\n` +
    `📝 ${escapeHtml(title)}\n` +
    `👥 Viewers: ${viewers}\n` +
    `⏱️ Started: ${started}\n` +
    `▶️ ${url}\n` +
    `${thumb}`
  );
}

// --- 10) Basic HTML escaping for Telegram parse_mode=HTML ---
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- 11) Main loop: resolve IDs, then poll forever ---
async function main() {
  console.log("Starting twitch2telegram (Node)…");

  const logins = TWITCH_LOGINS.split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

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
          await tgSend(formatMsg(liveNow[uid]));
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

// --- 12) Kick off ---
main().catch(err => {
  console.error("Fatal startup error:", err?.message || err);
  process.exit(1);
});