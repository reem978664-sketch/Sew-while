// utils/generateWallet.js
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALLET_FILE = path.join(__dirname, "..", "wallet.json");

/**
 * Try load wallet from:
 * 1) process.env.PRIVATE_KEY (JSON array string) OR process.env.PRIVATE_KEY_BASE58
 * 2) ./wallet.json file (either array or object with secretKey array)
 * 3) generate new and save to ./wallet.json (only when explicitly allowed)
 */
export async function generateOrLoadWallet({ persist = true } = {}) {
  // 1. from env JSON array
  const envJson = process.env.PRIVATE_KEY;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (Array.isArray(parsed)) {
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
    } catch (e) {
      // not JSON -> ignore
    }
  }

  // 1b. from env base58
  const envBase58 = process.env.PRIVATE_KEY_BASE58;
  if (envBase58) {
    try {
      const decoded = bs58.decode(envBase58);
      return Keypair.fromSecretKey(Uint8Array.from(decoded));
    } catch (e) {
      console.warn("PRIVATE_KEY_BASE58 decode failed:", e?.message || e);
    }
  }

  // 2. from wallet.json file
  try {
    const raw = fs.readFileSync(WALLET_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    if (parsed?.secretKey && Array.isArray(parsed.secretKey)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey));
    }
    if (typeof parsed === "string") {
      // maybe base58 stored as string
      try {
        const decoded = bs58.decode(parsed);
        return Keypair.fromSecretKey(Uint8Array.from(decoded));
      } catch {}
    }
  } catch (e) {
    // file not found or failed parse -> continue to generate
  }

  // 3. generate new
  const kp = Keypair.generate();
  if (persist) {
    try {
      fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)), {
        encoding: "utf8",
        flag: "w",
      });
      console.log(`📝 New wallet generated and saved to ${WALLET_FILE}`);
    } catch (e) {
      console.warn("Failed to persist wallet.json:", e?.message || e);
    }
  } else {
    console.log("Generated new wallet (not saved).");
  }
  return kp;
}

// default export for convenience
export default generateOrLoadWallet;

// If user runs this file directly, print out keys and usage
if (process.argv[1] && process.argv[1].endsWith("generateWallet.js")) {
  (async () => {
    try {
      const kp = await generateOrLoadWallet({ persist: true });
      const bs = bs58.encode(kp.secretKey);
      console.log("\n✨ SeaWhale — Wallet info\n");
      console.log("PublicKey:", kp.publicKey.toBase58());
      console.log("PrivateKey (base58):", bs);
      console.log("PrivateKey (JSON array):", JSON.stringify(Array.from(kp.secretKey)));
      console.log("\n⚠️  Save these securely. Add to your env or wallet.json as needed.");
    } catch (e) {
      console.error("Error generating/loading wallet:", e);
      process.exit(1);
    }
  })();
}
