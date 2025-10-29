import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();
console.log("PRIVATE_KEY_BASE58:", bs58.encode(kp.secretKey));
console.log("PRIVATE_KEY_ARRAY:", Array.from(kp.secretKey));
