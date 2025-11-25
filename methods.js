// Helper methods for Twitch <-> Telegram interactions.
// This module contains functions moved out of index.js so main remains small.

// State for Twitch App Access Token
let TWITCH_TOKEN = null;          // current bearer token
let TWITCH_TOKEN_EXPIRES_AT = 0;  // epoch ms when token should be refreshed

// Track messages this bot has sent to Telegram so we can delete them later.
// Each entry: { chatId, messageId, sentAt }
const sentMessages = [];

// --- Validate required envs early ---
function requireEnv(name, value) {
  if (!value || String(value).trim() === "") {
    console.error(`❗ Missing required env: ${name}`);
    process.exit(1);
  }
}

// --- Acquire/refresh Twitch App Access Token (client_credentials flow) ---
async function getAppToken() {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
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

// --- Build headers for Twitch Helix calls, refreshing token when needed ---
async function twitchHeaders() {
  if (!TWITCH_TOKEN || Date.now() > TWITCH_TOKEN_EXPIRES_AT) {
    await getAppToken();
  }
  return {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    "Authorization": `Bearer ${TWITCH_TOKEN}`,
  };
}

// --- Resolve Twitch logins -> user IDs (done once on startup) ---
async function getUserIds(logins) {
  // Returns a map: { loginLowerCase: user_id }
  const map = {};
  for (let i = 0; i < logins.length; i += 100) { // max 100 twitch users per request
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

// --- Query who is LIVE for a list of user IDs ---
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

// --- Basic HTML escaping for Telegram parse_mode=HTML ---
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Send a message to Telegram ---
// `TELEGRAM_CHAT_ID` can be numeric (-100...) or string "@channel_username".
async function tgSendStream(stream, disablePreview = false) {
  const thumb = (stream.thumbnail_url || "")
    .replace("{width}", "640")
    .replace("{height}", "360");

  const caption =
    `🔴 ${escapeHtml(stream.user_name)} ведет стримчанский!\n` +
    `🎮 ${escapeHtml(stream.game_name)}\n` +
    `📝 ${escapeHtml(stream.title)}\n` +
    `▶️ Запрыгиваем здесь https://twitch.tv/${stream.user_login}`;

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      photo: thumb,
      caption,
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview,
    }),
  });

  // Parse response body for better error handling and to capture message_id
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error("Telegram parse error:", text);
    return null;
  }

  if (!res.ok || !data || data.ok === false) {
    console.error("Telegram error:", text);
    return null;
  }

  // If Telegram returned a message id, record it so we can delete it later.
  const messageId = data.result && data.result.message_id;
  if (messageId != null) {
    try {
      sentMessages.push({ chatId: process.env.TELEGRAM_CHAT_ID, messageId, sentAt: Date.now() });
    } catch (e) {
      // should never happen for in-memory push, but guard just in case
      console.error("Failed to record sent message:", e?.message || e);
    }
  }

  return messageId;
}

// --- Telegram deletion helper + hourly cleanup ---
async function deleteTelegramMessage(chatId, messageId) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error(`delete failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return true;
  } catch (err) {
    console.error(`Telegram deleteMessage error (chat=${chatId}, id=${messageId}):`, err?.message || err);
    return false;
  }
}

function startDeletionLoop() {
  const HOUR = 60 * 60 * 1000;

  // Run every hour and delete messages older than one hour.
  setInterval(async () => {
    const now = Date.now();
    const cutoff = now - HOUR;
    // Find messages that are older than an hour
    const toDelete = sentMessages.filter(m => m.sentAt <= cutoff);
    if (!toDelete.length) return;

    for (const m of toDelete) {
      try {
        await deleteTelegramMessage(m.chatId, m.messageId);
      } catch (e) {
        // deleteTelegramMessage already logs; continue with others
      }
      // remove from array
      const idx = sentMessages.findIndex(x => x.messageId === m.messageId && x.chatId === m.chatId);
      if (idx !== -1) sentMessages.splice(idx, 1);
    }
  }, HOUR);
}

module.exports = {
  requireEnv,
  getAppToken,
  twitchHeaders,
  getUserIds,
  getLiveStreams,
  tgSendStream,
  escapeHtml,
  deleteTelegramMessage,
  startDeletionLoop,
};
