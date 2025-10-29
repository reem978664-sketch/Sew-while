// telegram.js
// Compatibility wrapper: expose telegramNotify globally (for older code paths)
// Uses the professional utils/notify.js implementation.

import { telegramNotify, notify } from "./utils/notify.js";

// expose a global-friendly function name used in index.js
export { telegramNotify };

// Also allow default export of notify helpers if needed
export default notify;

// optional: send startup ping automatically when module loads (non-blocking)
(async () => {
  try {
    // check env and send a short startup heartbeat
    await telegramNotify("🐋 SeaWhale Telegram module loaded (heartbeat)", "info");
  } catch (e) {
    // swallow errors — module should not crash
    console.warn("telegram wrapper init err:", e?.message || e);
  }
})();
