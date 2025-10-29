// utils/heliusStream.js
import WebSocket from "ws";
import fetch from "node-fetch";

/**
 * Robust Helius WebSocket stream helper
 *
 * Usage:
 *   const stream = startHeliusStream({
 *     wssUrl: process.env.HELIUS_WSS || `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
 *     rpcUrl: process.env.FAST_RPC,
 *     onMessage: (msg) => {},
 *     onConnect: () => {},
 *     onDisconnect: (err) => {},
 *     notify: async (type, text) => {} // optional - send to Telegram/logger
 *   });
 *
 *   // stop:
 *   stream.stop();
 */

const DEFAULT_PING_MS = Number(process.env.WS_PING_INTERVAL_MS || 20000);
const MAX_BACKOFF_MS = Number(process.env.WS_RECONNECT_MAX_DELAY_MS || 60_000);

export function startHeliusStream(opts = {}) {
  const {
    wssUrl,
    rpcUrl,
    onMessage = () => {},
    onConnect = () => {},
    onDisconnect = () => {},
    notify = async () => {},
    pingIntervalMs = DEFAULT_PING_MS,
  } = opts;

  if (!wssUrl && !process.env.HELIUS_API_KEY) {
    throw new Error("Helius WSS URL or API key is required");
  }

  const url = wssUrl || `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  let ws = null;
  let closedByUser = false;
  let pingTimer = null;
  let backoff = 1000; // start 1s
  let reconnectTimer = null;
  let lastConnectTs = 0;

  function jitter(ms) {
    return Math.floor(ms * (0.7 + Math.random() * 0.6)); // 0.7x - 1.3x
  }

  async function tryFallbackRpcPoll() {
    if (!rpcUrl) return;
    try {
      // simple health check - get recent slot
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        timeout: 8000,
      });
      if (res.ok) {
        const j = await res.json();
        await notify("info", `RPC fallback healthy - slot ${j?.result}`);
      } else {
        await notify("warn", `RPC fallback returned ${res.status}`);
      }
    } catch (e) {
      await notify("error", `RPC fallback failed: ${String(e)}`);
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          // send a ping frame if ws supports it, else send a lightweight message
          try {
            ws.ping();
          } catch {
            // fallback: send a noop text message (Helius ignores unknown)
            ws.send(JSON.stringify({ op: "noop" }));
          }
        }
      } catch (e) {
        // ignore
      }
    }, pingIntervalMs);
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  async function connect() {
    closedByUser = false;
    await notify("debug", `Connecting to Helius WS: ${url}`);
    lastConnectTs = Date.now();

    ws = new WebSocket(url, { handshakeTimeout: 12_000 });

    ws.on("open", async () => {
      backoff = 1000; // reset backoff on success
      await notify("connected", "Helius WS connected");
      onConnect();
      startPing();
      // subscribe to program logs or transaction notifications if needed
      // Example subscription (customize as your bot expects):
      // ws.send(JSON.stringify({ "op": "logsSubscribe", "filters": { "mentions":["..."] } }));
    });

    ws.on("message", async (data) => {
      // data can be Buffer or string
      let text;
      try { text = data.toString(); } catch { text = String(data); }
      // quick health-ack: ignore PONG/heartbeat echoes
      onMessage(text);
    });

    ws.on("pong", () => {
      // received PONG
    });

    ws.on("close", async (code, reason) => {
      stopPing();
      await notify("warn", `Helius WS closed (code=${code})`);
      onDisconnect(new Error(`closed code=${code} reason=${reason}`));
      if (!closedByUser) scheduleReconnect();
    });

    ws.on("error", async (err) => {
      await notify("error", `Helius WS error: ${String(err)}`);
      // will get 'close' as well - ensure reconnect scheduled
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    // exponential backoff with jitter
    const delay = Math.min(MAX_BACKOFF_MS, backoff);
    const j = jitter(delay);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      await notify("info", `Reconnecting to Helius WS (delay ${j}ms)...`);
      // as a fallback, call RPC check
      await tryFallbackRpcPoll();
      connect().catch(async (e) => {
        await notify("error", `Reconnect failed: ${String(e)}`);
        scheduleReconnect();
      });
    }, j);
  }

  function stopReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function stop() {
    closedByUser = true;
    stopReconnectTimer();
    stopPing();
    if (ws) {
      try { ws.terminate(); } catch {}
      ws = null;
    }
    await notify("info", "Helius stream stopped by user");
  }

  // start immediately
  connect().catch((e) => {
    notify("error", `Initial Helius connect failed: ${String(e)}`);
    scheduleReconnect();
  });

  return { stop, getWs: () => ws };
}
