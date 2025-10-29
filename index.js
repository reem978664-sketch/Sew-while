// index.js
// SeaWhale Pro — unified stream + watchdog + admin HTTP + safe execution bridge
// ESM, top-level await expected (package.json "type": "module")

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import http from "http";
import path from "path";
import fetch from "node-fetch";
import WebSocket from "ws";
import { Keypair } from "@solana/web3.js";
import { setTimeout as delay } from "timers/promises";

const ROOT = process.cwd();

// -----------------------------
// Environment / Config
// -----------------------------
const ENV = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: Number(process.env.PORT || 8080),
  LIVE: process.env.LIVE === "true",
  PAPER: process.env.PAPER === "true",
  AUTO_EXECUTE: process.env.AUTO_EXECUTE === "true",
  DRY_SIMULATE: process.env.DRY_SIMULATE === "true",
  ENABLE_LIVE_TRADING: process.env.ENABLE_LIVE_TRADING === "true",
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || process.env.HELIUS_KEY || "",
  HELIUS_WSS: process.env.HELIUS_WSS || null,
  FAST_RPC: process.env.FAST_RPC || "https://api.mainnet-beta.solana.com",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || "",
  REDIS_URL: process.env.REDIS_URL || "",
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",
  PRIVATE_KEY_BASE58: process.env.PRIVATE_KEY_BASE58 || "",
  FLY_APP: process.env.FLY_APP || process.env.FLY_APP_NAME || "",
  BUY_AMOUNT_SOL: Number(process.env.BUY_AMOUNT_SOL || process.env.BUY_AMOUNT || 0.002),
  MAX_SLIPPAGE_PERCENT: Number(process.env.MAX_SLIPPAGE_PERCENT || 1),
  MIN_TRADE_SOL: Number(process.env.MIN_TRADE_SOL || 0.001),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || "3", 10),
  RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS || "1500", 10),
  POSITIONS_FILE: process.env.POSITIONS_FILE || path.join(ROOT, "positions.json"),
};

// ensure HELIUS_WSS if api key present
if (!ENV.HELIUS_WSS && ENV.HELIUS_API_KEY) {
  ENV.HELIUS_WSS = `wss://mainnet.helius-rpc.com/?api-key=${ENV.HELIUS_API_KEY}`;
}

// -----------------------------
// Logger
// -----------------------------
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}
const info = (...a) => log("info", ...a);
const warn = (...a) => log("warn", ...a);
const error = (...a) => log("error", ...a);
const debug = (...a) => { if (ENV.NODE_ENV !== "production") log("debug", ...a); };

// -----------------------------
// Optional modules (dynamic imports)
// -----------------------------
let generateOrLoadWalletFn = null;
let sendTelegramMessage = null;
let handleTransaction = null;
let startHeliusStream = null;
let executeTradeFn = null; // optional trade executor (if exists)

try {
  generateOrLoadWalletFn =
    (await import("./utils/generateWallet.js")).generateOrLoadWallet ||
    (await import("./utils/generateWallet.js")).default;
  info("Loaded utils/generateWallet.js");
} catch (e) {
  debug("generateWallet not found:", e?.message || e);
}

try {
  const tg = await import("./telegram.js");
  sendTelegramMessage = tg.sendTelegramMessage || tg.telegramNotify || (tg.default && tg.default.raw) || null;
  info("Loaded telegram.js");
} catch (e) {
  debug("telegram wrapper not found:", e?.message || e);
}

try {
  const de = await import("./ai/decisionEngine.js");
  handleTransaction =
    de.handleTransaction || de.decide || de.heuristicDecision || de.default;
  info("Loaded ai/decisionEngine.js");
} catch (e) {
  debug("decision engine not found:", e?.message || e);
}

try {
  startHeliusStream =
    (await import("./utils/heliusStream.js")).startHeliusStream ||
    (await import("./utils/heliusStream.js")).default;
  info("Loaded utils/heliusStream.js");
} catch (e) {
  debug("heliusStream not found:", e?.message || e);
}

// try load trade executor (optional)
try {
  const te = await import("./utils/tradeExecutor.js");
  executeTradeFn = te.executeTrade || te.default || null;
  if (executeTradeFn) info("Loaded utils/tradeExecutor.js (executeTrade available)");
} catch (e) {
  debug("tradeExecutor not found (live trading disabled):", e?.message || e);
}

// -----------------------------
// Notify helper (uses telegram.js if available)
// -----------------------------
async function notify(type = "info", text = "") {
  const prefixMap = { info: "ℹ️", warn: "⚠️", error: "❌", connected: "🟢", success: "✅", trade: "💸", rpc: "🌐" };
  const prefix = prefixMap[type] || "💬";
  const message = `${prefix} ${text}`;
  if (type === "error") error(message); else info(message);

  if (typeof sendTelegramMessage === "function" && ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) {
    try {
      // sendTelegramMessage may be different shapes; try safe call
      await sendTelegramMessage(ENV.TELEGRAM_CHAT_ID, message);
    } catch (err) {
      warn("Telegram notify failed:", err?.message || err);
    }
  }
}

// -----------------------------
// Wallet loading (robust)
// -----------------------------
async function loadWalletFromFileOrEnv() {
  // 1) generate function
  if (typeof generateOrLoadWalletFn === "function") {
    try { const w = await generateOrLoadWalletFn(); if (w && w.publicKey) return w; } catch (e) { warn("generateOrLoadWallet failed:", e?.message || e); }
  }

  // 2) wallet.json
  try {
    const raw = fs.readFileSync(path.join(ROOT, "wallet.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return Keypair.fromSecretKey(Uint8Array.from(parsed));
    if (parsed?.secretKey && Array.isArray(parsed.secretKey)) return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey));
    if (typeof parsed === "string") {
      const bs58 = (await import("bs58")).default;
      return Keypair.fromSecretKey(Uint8Array.from(bs58.decode(parsed)));
    }
  } catch (e) {
    debug("No wallet.json or failed parse:", e?.message || e);
  }

  // 3) PRIVATE_KEY env (JSON array) or PRIVATE_KEY_BASE58
  if (ENV.PRIVATE_KEY) {
    try {
      const parsed = JSON.parse(ENV.PRIVATE_KEY);
      if (Array.isArray(parsed)) return Keypair.fromSecretKey(Uint8Array.from(parsed));
    } catch (e) { debug("PRIVATE_KEY parse failed:", e?.message || e); }
  }
  if (ENV.PRIVATE_KEY_BASE58) {
    try {
      const bs58 = (await import("bs58")).default;
      const decoded = bs58.decode(ENV.PRIVATE_KEY_BASE58);
      return Keypair.fromSecretKey(Uint8Array.from(decoded));
    } catch (e) { debug("PRIVATE_KEY_BASE58 decode failed:", e?.message || e); }
  }

  throw new Error("No wallet available. Provide utils/generateWallet.js or wallet.json or PRIVATE_KEY.");
}

// load wallet
let wallet;
try {
  wallet = await loadWalletFromFileOrEnv();
  await notify("info", `Wallet loaded: ${wallet.publicKey.toBase58()}`);
} catch (e) {
  error("❌ Failed to load wallet:", e?.message || e);
  process.exit(1);
}

// -----------------------------
// Positions store (simple file-backed + optional Redis later)
// -----------------------------
function safeReadPositions() {
  try {
    if (fs.existsSync(ENV.POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(ENV.POSITIONS_FILE, "utf8") || "{}");
    }
  } catch (e) { debug("read positions failed:", e?.message || e); }
  return {};
}
function safeWritePositions(obj) {
  try { fs.writeFileSync(ENV.POSITIONS_FILE, JSON.stringify(obj, null, 2)); } catch (e) { warn("write positions failed:", e?.message || e); }
}
let POSITIONS = safeReadPositions();

// -----------------------------
// Core stream handler
// -----------------------------
let lastMessageTime = Date.now();
let rpcFailures = 0;
let restarting = false;

async function onIncomingMessageParsed(parsed) {
  lastMessageTime = Date.now();
  try {
    if (typeof handleTransaction === "function") {
      // decisionEngine may return different shapes: try to accept both
      const result = await handleTransaction(parsed, wallet, {
        LIVE: ENV.LIVE, PAPER: ENV.PAPER, AUTO_EXECUTE: ENV.AUTO_EXECUTE, DRY_SIMULATE: ENV.DRY_SIMULATE,
      });

      // If decisionEngine returns explicit instruction, handle it
      // Support shapes: { buy, sell, protocol_hint, reason } OR { action: "buy"/"sell"}
      const action = (result && (result.buy ? "buy" : result.sell ? "sell" : result.action)) || null;

      if (action && ENV.AUTO_EXECUTE && !ENV.DRY_SIMULATE && ENV.ENABLE_LIVE_TRADING) {
        // only attempt execution if executeTrade available
        if (typeof executeTradeFn === "function") {
          try {
            await notify("trade", `Attempting ${action} (auto-exec) — ${result?.reason || ""}`);
            const txRes = await safeExecuteTradeFlow(parsed, result, action);
            if (txRes?.success) {
              // record position if buy
              if (action === "buy") {
                POSITIONS[txRes.mint || txRes.asset || "unknown"] = POSITIONS[txRes.mint || txRes.asset || "unknown"] || [];
                POSITIONS[txRes.mint || txRes.asset || "unknown"].push({
                  ts: Date.now(), sig: txRes.sig, amount: txRes.amount || 0, price: txRes.price || null,
                });
                safeWritePositions(POSITIONS);
              }
              await notify("success", `Trade executed: ${txRes.sig || "unknown"}`);
            } else {
              await notify("warn", `Trade attempt failed: ${txRes?.error || "unknown"}`);
            }
          } catch (e) {
            warn("executeTrade flow error:", e?.message || e);
            await notify("error", `ExecuteTrade failed: ${e?.message || e}`);
          }
        } else {
          debug("AUTO_EXECUTE requested but executeTradeFn not present; skipping actual execution.");
          await notify("warn", "AUTO_EXECUTE requested but executor missing.");
        }
      } else {
        // Not auto executing — just log decision
        debug("Decision result (no auto-exec):", result);
      }

      return;
    }
    debug("[stream] message received (no handler defined)");
  } catch (err) {
    error("[stream] handle incoming error:", err?.message || err);
    await notify("error", `[stream] handle error: ${err?.message || err}`);
  }
}

// -----------------------------
// Safe trade execution wrapper
// -----------------------------
async function safeExecuteTradeFlow(parsed, decisionResult, action) {
  // decisionResult may include mint/amount/protocol_hint
  const mint = decisionResult?.mint || parsed?.mint || null;
  const amountSOL = ENV.BUY_AMOUNT_SOL;
  const slippage = Math.max(0, ENV.MAX_SLIPPAGE_PERCENT) / 100;
  const maxRetries = ENV.MAX_RETRIES;
  const retryDelay = ENV.RETRY_DELAY_MS;

  if (!mint) return { success: false, error: "no_mint_info" };
  if (amountSOL < ENV.MIN_TRADE_SOL) return { success: false, error: "amount_below_min" };

  // Build context for executor
  const ctx = { wallet, mint, amountSOL, slippage, decisionResult, parsed };

  // Attempt up to maxRetries
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // If executor provides a simulate mode, call it first
      if (typeof executeTradeFn.simulate === "function") {
        const sim = await executeTradeFn.simulate(ctx);
        if (!sim?.ok) {
          // simulation indicates failure => bail or retry based on sim.reason
          await notify("warn", `Simulate trade failed (attempt ${attempt}): ${sim?.reason || "unknown"}`);
          if (attempt === maxRetries) return { success: false, error: "simulate_failed", meta: sim };
          await delay(retryDelay);
          continue;
        }
      }

      // execute actual trade
      const res = await executeTradeFn(ctx); // expect { success, sig, amount, price, mint }
      if (res && res.success) {
        return { success: true, ...res };
      } else {
        await notify("warn", `Executor returned failure (attempt ${attempt}): ${res?.error || "unknown"}`);
        if (attempt === maxRetries) return { success: false, error: res?.error || "executor_failed" };
        await delay(retryDelay);
        continue;
      }
    } catch (e) {
      warn(`Trade attempt ${attempt} error:`, e?.message || e);
      if (attempt === maxRetries) return { success: false, error: e?.message || e };
      await delay(retryDelay);
    }
  }
  return { success: false, error: "unknown_retry_failure" };
}

// -----------------------------
// runWithStartHeliusStream / connectWSLocal
// -----------------------------
async function runWithStartHeliusStream() {
  if (!startHeliusStream) return false;
  try {
    await startHeliusStream({
      wssUrl: ENV.HELIUS_WSS,
      rpcUrl: ENV.FAST_RPC,
      onMessage: async (raw) => {
        lastMessageTime = Date.now();
        try {
          const parsed = JSON.parse(raw);
          await onIncomingMessageParsed(parsed);
        } catch (e) { debug("startHeliusStream parse error:", e?.message || e); }
      },
      onConnect: () => notify("connected", "Helius WS connected ✅"),
      onDisconnect: (err) => notify("warn", "Helius WS disconnected: " + String(err || "")),
      notify,
    });
    return true;
  } catch (e) {
    debug("startHeliusStream failed:", e?.message || e);
    return false;
  }
}

let ws = null, reconnectCount = 0;
async function connectWSLocal(wssUrl) {
  if (!wssUrl) throw new Error("No Helius WSS URL provided.");
  ws = new WebSocket(wssUrl);

  ws.on("open", async () => {
    reconnectCount++;
    await notify("info", `🌐 Helius WS connected (try #${reconnectCount}) — Whale ${wallet.publicKey.toBase58()}`);
    debug("[WS] connected ->", wssUrl);
    // subscribe to account or program activity as appropriate
    const sub = {
      jsonrpc: "2.0", id: "subscribe", method: "transactionSubscribe",
      params: [{ accountInclude: [wallet.publicKey.toBase58()] }],
    };
    try { ws.send(JSON.stringify(sub)); } catch (e) { warn("Failed to send subscribe:", e?.message || e); }
  });

  ws.on("message", async (raw) => {
    lastMessageTime = Date.now();
    try {
      const parsed = JSON.parse(raw.toString());
      if (parsed?.params?.result) {
        await onIncomingMessageParsed(parsed.params.result);
      } else {
        await onIncomingMessageParsed(parsed);
      }
    } catch (e) { debug("WS message parse error:", e?.message || e); }
  });

  ws.on("close", async (code, reason) => {
    stopPing();
    await notify("warn", `⚠️ Helius WS closed (code ${code}) — reconnecting in 3s`);
    debug("[WS] closed:", code, reason?.toString?.() || reason);
    await delay(3000);
    connectWSLocal(wssUrl).catch(err => debug("reconnect failed:", err?.message || err));
  });

  ws.on("error", (err) => { error("[WS] error:", err?.message || err); try { ws.close(); } catch {} });
}

// -----------------------------
// Ping timer control (for WS)
let pingTimer = null;
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { ws.send(JSON.stringify({ op: "noop" })); }
      }
    } catch (e) {}
  }, Number(process.env.WS_PING_INTERVAL_MS || 20000));
}
function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

// start stream
if (!(await runWithStartHeliusStream())) {
  await connectWSLocal(ENV.HELIUS_WSS);
  startPing();
}

// -----------------------------
// Watchdog checks
// -----------------------------
setInterval(async () => {
  const silenceSec = Math.floor((Date.now() - lastMessageTime) / 1000);
  if (silenceSec > 180) {
    await safeRestart(`WebSocket silence > ${Math.floor(silenceSec / 60)} min`);
    return;
  }
  try {
    const res = await fetch(ENV.FAST_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const data = await res.json();
    if (data?.result !== "ok") { rpcFailures++; warn("[Watchdog] RPC not healthy", data); } else rpcFailures = 0;
  } catch (e) {
    rpcFailures++; warn("[Watchdog] RPC error:", e?.message || e);
  }
  if (rpcFailures > 3) await safeRestart("RPC failures > 3");
}, 60_000);

// -----------------------------
// Metrics & counting
// -----------------------------
const METRICS = { startTime: Date.now(), handledMessages: 0, tradesExecuted: 0 };
const originalIncoming = onIncomingMessageParsed;
onIncomingMessageParsed = async (parsed) => { METRICS.handledMessages++; await originalIncoming(parsed); };

// -----------------------------
// Admin HTTP server (status, health, metrics, positions)
// -----------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) req.url = "/";
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <head><title>SeaWhale Pro</title></head>
          <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; text-align:center; padding:40px;">
            <h1>🐋 SeaWhale Pro</h1>
            <p>Running on <strong>${ENV.FLY_APP || "unknown-app"}</strong></p>
            <p>Wallet: <code>${wallet.publicKey.toBase58()}</code></p>
            <p>Mode: ${ENV.LIVE ? "LIVE" : ENV.PAPER ? "PAPER" : "UNKNOWN"}</p>
            <p><a href="/health">Health</a> • <a href="/metrics">Metrics</a> • <a href="/positions">Positions</a></p>
          </body>
        </html>
      `);
      return;
    }
    if (req.url === "/health") {
      const uptime = Math.floor((Date.now() - METRICS.startTime) / 1000);
      const silent = Math.floor((Date.now() - lastMessageTime) / 1000);
      const payload = { status: "ok", uptime_seconds: uptime, last_message_seconds_ago: silent, rpcFailures };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === "/metrics") {
      const uptime = Math.floor((Date.now() - METRICS.startTime) / 1000);
      const body = [
        `sea_start_time_seconds ${Math.floor(METRICS.startTime / 1000)}`,
        `sea_uptime_seconds ${uptime}`,
        `sea_handled_messages_total ${METRICS.handledMessages}`,
        `sea_trades_executed_total ${METRICS.tradesExecuted}`,
        `sea_rpc_failures ${rpcFailures}`,
      ].join("\n");
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
      return;
    }
    if (req.url === "/positions") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(POSITIONS));
      return;
    }
    // default 404
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (err) {
    error("HTTP handler error:", err?.message || err);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.listen(ENV.PORT, () => info(`✅ SeaWhale admin server running on port ${ENV.PORT}`));

// -----------------------------
// Graceful shutdown & restart
// -----------------------------
async function safeRestart(reason) {
  if (restarting) return;
  restarting = true;
  await notify("warn", `🔁 SeaWhale Pro restarting automatically... reason: ${reason}`);
  setTimeout(() => process.exit(1), 2500);
}

async function shutdown(signal) {
  try {
    await notify("warn", `🛑 SeaWhale shutting down (${signal})`);
    try { if (ws) ws.close(); } catch {}
    try { server.close(); } catch {}
  } catch (e) {
    error("Error during shutdown:", e?.message || e);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", async (err) => {
  await notify("error", "Uncaught exception: " + (err?.stack || err?.message || err));
  setTimeout(() => process.exit(1), 2000);
});
process.on("unhandledRejection", async (reason) => {
  await notify("error", "Unhandled rejection: " + String(reason));
});

// -----------------------------
// Startup message
// -----------------------------
(async () => {
  const startMsg = ENV.LIVE ? "🟢 SeaWhale Pro starting on LIVE network" : "🧪 SeaWhale Pro starting in PAPER/DRY mode";
  await notify("info", `${startMsg} | PORT=${ENV.PORT} | APP=${ENV.FLY_APP || "unknown"}`);
})();
