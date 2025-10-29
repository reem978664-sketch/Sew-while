// ai/decisionEngine.js
// SeaWhale Pro - Decision Engine
// Exports: heuristicDecision(ctx)  &  decide(ctx, openaiKey)
// - ctx: { mint, logs, txInfo, whaleAddress }
// - decide uses OPENAI (if provided) with rate-limiting & caching

import axios from "axios";

const CACHE_TTL_MS = 30 * 1000; // cache decisions per mint for 30s
const OPENAI_MIN_INTERVAL_MS = 3000; // minimal gap between openai calls
const MAX_OPENAI_TOKENS = 1500; // safety cap for prompt content

const modelFromEnv = process.env.OPENAI_MODEL || "gpt-4o-mini";

const _cache = new Map();
let _lastOpenAICall = 0;
let _openAiQueue = 0;

/* ---------------------------
   Helper utilities
   --------------------------- */

function now() {
  return Date.now();
}

function short(s, n = 1000) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "...[truncated]" : s;
}

// sanitize anything that looks like private key / secret before sending to OpenAI
function sanitizeForModel(input) {
  if (!input) return "";
  let t = String(input);
  // remove long base58-like / hex-like strings and replace with placeholder
  t = t.replace(/[A-Za-z0-9_\-]{40,}/g, "[REDACTED_SECRET]");
  // remove HTTP query api-keys
  t = t.replace(/api[-_]?key=([A-Za-z0-9_\-]+)/gi, "api-key=[REDACTED]");
  return t;
}

// safe parse for model JSON output
function safeParseModelJSON(s) {
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    return j;
  } catch {
    // try to extract first {...}
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

/* ---------------------------
   Heuristic Decision (fast)
   - lightweight, deterministic rules
   - returns { buy, sell, protocol_hint }
   --------------------------- */
export function heuristicDecision(ctx = {}) {
  try {
    const { mint, txInfo, logs, whaleAddress } = ctx;
    if (!mint) return { buy: false, sell: false };

    // If txInfo has token balance changes, infer direction for the whale account
    const pre = (txInfo?.meta?.preTokenBalances || []).filter(Boolean);
    const post = (txInfo?.meta?.postTokenBalances || []).filter(Boolean);

    // map by accountIndex or mint to compare amounts
    function mapBalances(arr) {
      const m = new Map();
      for (const b of arr) {
        // try owner if present, else use accountIndex + mint
        const key = `${b?.owner || b?.accountIndex || ""}:${b?.mint || ""}`;
        const amt = parseFloat(b?.uiTokenAmount?.ui || b?.uiTokenAmount?.amount || 0) || 0;
        m.set(key, amt);
      }
      return m;
    }

    const preMap = mapBalances(pre);
    const postMap = mapBalances(post);

    // look for increase/decrease for the whaleAddress specifically
    let whaleIncreased = false;
    let whaleDecreased = false;
    for (const [k, postAmt] of postMap.entries()) {
      // if owner contains whaleAddress
      if (k.startsWith(`${whaleAddress}:`)) {
        const preAmt = preMap.get(k) || 0;
        if (postAmt > preAmt + 1e-12) whaleIncreased = true;
        if (postAmt < preAmt - 1e-12) whaleDecreased = true;
      }
    }

    // fallback: compare total post vs pre for this mint across owners
    if (!whaleIncreased && !whaleDecreased) {
      // sum for mint in pre/post
      const sum = (map, mintKey) => {
        let s = 0;
        for (const [k, v] of map.entries()) {
          if (k.endsWith(`:${mintKey}`)) s += v || 0;
        }
        return s;
      };
      const sPre = sum(preMap, mint);
      const sPost = sum(postMap, mint);
      if (sPost > sPre + 1e-12) whaleIncreased = true;
      if (sPost < sPre - 1e-12) whaleDecreased = true;
    }

    // if whale got tokens => they bought (follow-buy)
    if (whaleIncreased && !whaleDecreased) {
      return { buy: true, sell: false, protocol_hint: "auto", reason: "heuristic: whale token increase" };
    }
    // if whale lost tokens => they sold (we should consider selling)
    if (whaleDecreased && !whaleIncreased) {
      return { buy: false, sell: true, protocol_hint: "raydium", reason: "heuristic: whale token decrease" };
    }

    // Additional heuristic: inspect logs or instruction types for 'swap' or 'swapExact'
    const logStr = (Array.isArray(logs) ? logs.join(" ") : String(logs || "")).toLowerCase();
    if (/swap|swapexact|swap_to|amm|serum/i.test(logStr)) {
      // ambiguous: assume buy if "buy" appears or "in" direction hints
      if (/(buy|bought)/i.test(logStr)) {
        return { buy: true, sell: false, protocol_hint: "auto", reason: "heuristic: logs indicate buy" };
      }
      if (/(sell|sold)/i.test(logStr)) {
        return { buy: false, sell: true, protocol_hint: "raydium", reason: "heuristic: logs indicate sell" };
      }
      // fallback ambiguous swap -> do not act (let OpenAI or prebuild)
      return { buy: false, sell: false, reason: "heuristic: ambiguous swap" };
    }

    return { buy: false, sell: false, reason: "heuristic: no clear signal" };
  } catch (e) {
    return { buy: false, sell: false, reason: "heuristic error" };
  }
}

/* ---------------------------
   OpenAI-backed decision
   - decide(ctx, openaiKey)
   - returns { buy, sell, protocol_hint?, confidence?, reason? }
   --------------------------- */

async function canCallOpenAI(openaiKey) {
  if (!openaiKey) return false;
  // throttle to prevent rapid repeated calls
  const elapsed = now() - _lastOpenAICall;
  if (elapsed < OPENAI_MIN_INTERVAL_MS) return false;
  return true;
}

async function callOpenAI(prompt, openaiKey, model = modelFromEnv) {
  // basic rate counting
  _openAiQueue++;
  try {
    // Respect minimal interval
    const elapsed = now() - _lastOpenAICall;
    if (elapsed < OPENAI_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, OPENAI_MIN_INTERVAL_MS - elapsed));
    }
    _lastOpenAICall = now();

    // Use Chat Completions endpoint for compatibility
    const payload = {
      model: model,
      messages: [
        { role: "system", content: "You are a helpful trading assistant. Answer in strict JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.0,
      max_tokens: 400,
    };

    const res = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${openaiKey}` },
      timeout: 12000,
    });

    const text = res?.data?.choices?.[0]?.message?.content || "";
    return text;
  } finally {
    _openAiQueue = Math.max(0, _openAiQueue - 1);
  }
}

function buildOpenAIPrompt(ctx) {
  // Prepare sanitized summary of ctx
  const safeMint = sanitizeForModel(ctx?.mint || "");
  const whale = sanitizeForModel(ctx?.whaleAddress || "");
  const txInfo = ctx?.txInfo || {};
  const logs = Array.isArray(ctx?.logs) ? ctx.logs.join("\n") : (ctx?.logs || "");
  const shortLogs = short(sanitizeForModel(logs), MAX_OPENAI_TOKENS);
  // Summarize pre/post balances (if available) into minimal table
  let balanceSummary = "";
  try {
    const pre = txInfo?.meta?.preTokenBalances || [];
    const post = txInfo?.meta?.postTokenBalances || [];
    const pairs = {};
    for (const b of [...pre, ...post]) {
      if (!b) continue;
      const key = `${b.mint || "?"}:${b.owner || b.accountIndex || "?"}`;
      pairs[key] = pairs[key] || { mint: b.mint || "?", owner: b.owner || "?", pre: 0, post: 0 };
    }
    for (const b of pre) {
      const key = `${b.mint || "?"}:${b.owner || b.accountIndex || "?"}`;
      pairs[key].pre = parseFloat(b?.uiTokenAmount?.ui || b?.uiTokenAmount?.amount || 0) || 0;
    }
    for (const b of post) {
      const key = `${b.mint || "?"}:${b.owner || b.accountIndex || "?"}`;
      pairs[key].post = parseFloat(b?.uiTokenAmount?.ui || b?.uiTokenAmount?.amount || 0) || 0;
    }
    for (const k of Object.keys(pairs)) {
      const v = pairs[k];
      if (v.mint === safeMint || v.owner === whale) balanceSummary += `MINT:${v.mint} OWNER:${v.owner} PRE:${v.pre} POST:${v.post}\n`;
    }
  } catch {}

  // Build final prompt instructing model to return JSON only
  const prompt = `
Context: You are given a Solana transaction observation for monitoring a whale address.
Return a strict JSON object with keys: { "action": "buy"|"sell"|"hold", "confidence": 0.0-1.0, "protocol_hint": "raydium"|"pumpfun"|"auto"|"unknown", "explain": "short reason" }

Observation:
- mint: ${safeMint}
- whale: ${whale}
- tx slot: ${txInfo?.slot || "unknown"}
- brief balance summary:
${balanceSummary || "[none]"}

Recent logs (truncated):
${shortLogs}

Important:
- Do NOT include any private keys or secrets in the output.
- Output must be valid JSON only (no commentary).
- If unsure, return {"action":"hold","confidence":0,"protocol_hint":"unknown","explain":"insufficient data"}.
`;

  return prompt;
}

export async function decide(ctx = {}, openaiKey = "") {
  try {
    const mint = String(ctx?.mint || "");
    if (!mint) return { buy: false, sell: false, reason: "no mint" };

    // check cache
    const cached = _cache.get(mint);
    if (cached && now() - cached.ts < CACHE_TTL_MS) {
      return cached.value;
    }

    // first use heuristics
    const h = heuristicDecision(ctx);
    // If heuristics returned a strong buy/sell, we can use it right away (fast path)
    if (h.buy || h.sell) {
      const out = { buy: !!h.buy, sell: !!h.sell, protocol_hint: h.protocol_hint || "auto", reason: `heuristic:${h.reason || "fast"}` };
      _cache.set(mint, { ts: now(), value: out });
      return out;
    }

    // if no openai key, return hold
    if (!openaiKey) {
      const out = { buy: false, sell: false, reason: "no_openai_key" };
      _cache.set(mint, { ts: now(), value: out });
      return out;
    }

    // throttle and gating
    const canCall = await canCallOpenAI(openaiKey);
    if (!canCall) {
      const out = { buy: false, sell: false, reason: "openai_throttled" };
      _cache.set(mint, { ts: now(), value: out });
      return out;
    }

    // Build prompt and call OpenAI
    const prompt = buildOpenAIPrompt(ctx);
    let raw = "";
    try {
      raw = await callOpenAI(prompt, openaiKey, modelFromEnv);
    } catch (e) {
      const out = { buy: false, sell: false, reason: "openai_call_failed" };
      _cache.set(mint, { ts: now(), value: out });
      return out;
    }

    // parse JSON result strictly
    const parsed = safeParseModelJSON(raw);
    if (!parsed || !parsed.action) {
      const out = { buy: false, sell: false, reason: "openai_parse_failed", raw: short(raw, 400) };
      _cache.set(mint, { ts: now(), value: out });
      return out;
    }

    const action = String(parsed.action || "").toLowerCase();
    const confidence = Math.min(1, Math.max(0, parseFloat(parsed.confidence || 0) || 0));
    const protocol_hint = parsed.protocol_hint || parsed.protocol || "unknown";
    const explain = parsed.explain || parsed.reason || "";

    const out = {
      buy: action === "buy",
      sell: action === "sell",
      protocol_hint,
      confidence,
      reason: `openai:${explain || "n/a"}`,
      raw,
    };
    _cache.set(mint, { ts: now(), value: out });
    return out;
  } catch (e) {
    return { buy: false, sell: false, reason: "decide_error" };
  }
}
