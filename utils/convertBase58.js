// utils/convertBase58.js
import bs58 from "bs58";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npm run convert-key <BASE58_PRIVATE_KEY>");
  process.exit(1);
}
const base58Key = args[0];
try {
  const decoded = bs58.decode(base58Key);
  console.log(JSON.stringify(Array.from(decoded)));
} catch (err) {
  console.error("Error converting key:", err.message || err);
  process.exit(1);
}
