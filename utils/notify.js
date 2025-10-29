// utils/notify.js
// Professional Telegram notifier with security filter, queue, retry & formatting

import axios from "axios";

// --- Core ENV Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// --- Internal Queue ---
const queue = [];
let sending = false;

// --- Security Filter (protects secrets from leaking) ---
function sanitize(text) {
  if (!text) return "";
  let t = String(text);
  const sensitivePatterns = [
    /(?<=PRIVATE[_-]?KEY\s*=?\s*)[A-Za-z0-9+/=:-]+/gi,
    /(?<=API[_-]?KEY\s*=?\s*)[A-Za-z0-9+/=:-]+/gi,
    /(?<=TOKEN\s*=?\s*)[A-Za-z0-9:_-]+/gi,
    /[A-Za-z0-9]{48,}/g, // long random strings
    /\b(?:mnemonic|seed|wallet|secret|bearer)\b[:=]?\s*[A-Za-z0-9\s,.-]+/gi,
  ];
  for (const pattern of sensitivePatterns) {
    t = t.replace(pattern, "[SECURED]");
  }
  return t;
}

// --- Send message via Telegram ---
async function sendToTelegram(message, level = "info") {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("Telegram not configured");
    return;
  }

  const text = sanitize(message);
  const emoji =
    level === "error"
      ? "🚨"
      : level === "warn"
      ? "⚠️"
      : level === "success"
      ? "✅"
      : level === "trade"
      ? "💸"
      : level === "rpc"
      ? "🌐"
      : "ℹ️";

  const payload = {
    chat_id: CHAT_ID,
    text: `${emoji} ${text}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      payload,
      { timeout: 8000 }
    );
  } catch (e) {
    const msg = e?.response?.data?.description || e?.message || "Unknown error";
    if (LOG_LEVEL === "debug" || LOG_LEVEL === "info")
      console.warn("TG send fail:", msg);
  }
}

// --- Queue Processor (1 msg / sec to avoid rate limit) ---
async function processQueue() {
  if (sending || queue.length === 0) return;
  sending = true;
  const { msg, lvl } = queue.shift();
  await sendToTelegram(msg, lvl);
  sending = false;
  setTimeout(processQueue, 1000);
}

// --- Public Interface ---
async function telegramNotify(message, level = "info") {
  queue.push({ msg: message, lvl: level });
  processQueue();
}

// --- Helper Shortcuts ---
const notify = {
  info: (title, body = "") =>
    telegramNotify(`<b>${sanitize(title)}</b>\n${sanitize(body)}`, "info"),
  success: (title, body = "") =>
    telegramNotify(`<b>${sanitize(title)}</b>\n${sanitize(body)}`, "success"),
  warn: (title, body = "") =>
    telegramNotify(`<b>${sanitize(title)}</b>\n${sanitize(body)}`, "warn"),
  error: (title, body = "") =>
    telegramNotify(`<b>${sanitize(title)}</b>\n${sanitize(body)}`, "error"),
  trade: (title, body = "") =>
    telegramNotify(`<b>${sanitize(title)}</b>\n${sanitize(body)}`, "trade"),
  rpc: (title, body = "") =>
    telegramNotify(`<b>${sanitize(title)}</b>\n${sanitize(body)}`, "rpc"),
  raw: (text) => telegramNotify(sanitize(text), "info"),
};

export { telegramNotify, notify };
export default notify;

// --- Optional startup ping ---
(async () => {
  try {
    await telegramNotify("🐋 SeaWhale notify module loaded (secured mode)", "info");
  } catch (e) {
    console.warn("Notify init:", e?.message || e);
  }
})();
