# 🎮 Twitch → Telegram Notifier Bot

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-blue?logo=telegram)
![Twitch API](https://img.shields.io/badge/Twitch-API-purple?logo=twitch)

A simple **Node.js bot** that sends messages to your **Telegram chat, group, or channel** when your favorite streamers go live on **Twitch**.  
No database required. Runs on any VPS or even a local machine.

---

## ✨ Features

- 🔴 Track multiple Twitch streamers at once  
- 📡 Polls Twitch API every `N` seconds (default: 60s)  
- 📩 Sends notifications to Telegram (chat, group, or channel)  
- 🎮 Notification includes:
  - Streamer’s display name
  - Stream title
  - Game name
  - Viewer count
  - Twitch link
  - Thumbnail image 

  Example notification:

🔴 Shroud is live!
🎮 Counter-Strike 2
📝 "Late Night Games"
👥 Viewers: 32,000
⏱️ Started: 2025-09-21T03:41:11Z
▶️ https://twitch.tv/shroud

<thumbnail image>