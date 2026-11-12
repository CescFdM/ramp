// Encrypt / decrypt files with a key derived from SITE_USERNAME + SITE_PASSWORD.
//   node scripts/crypt.mjs encrypt <in> <out>
//   node scripts/crypt.mjs decrypt <in> <out>
//
// Format (JSON): { v:1, iter, salt, iv, ct }  (base64). Plaintext is gzipped, then AES-256-GCM.
// Key = PBKDF2-SHA256(username.trim().toLowerCase() + "\n" + password, salt, iter).
// The salt is fixed per deployment (config/salt.txt) so a phone can cache the derived key.
// The browser implements the same thing in site/crypto.js. Keep both in sync.
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ITER = 600000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const saltFile = resolve(root, "config", "salt.txt");

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

function salt() {
  if (!existsSync(saltFile)) {
    writeFileSync(saltFile, b64(crypto.getRandomValues(new Uint8Array(16))) + "\n");
    console.error("[crypt] created config/salt.txt (commit it)");
  }
  return unb64(readFileSync(saltFile, "utf8").trim());
}

async function deriveKey(saltBytes, iter) {
  const user = (process.env.SITE_USERNAME || "").trim().toLowerCase();
  const pass = process.env.SITE_PASSWORD || "";
  if (!user || !pass) throw new Error("SITE_USERNAME and SITE_PASSWORD must be set");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(user + "\n" + pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: iter }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const [cmd, inp, out] = process.argv.slice(2);
if (!["encrypt", "decrypt"].includes(cmd) || !inp || !out) {
  console.error("usage: crypt.mjs encrypt|decrypt <in> <out>");
  process.exit(2);
}
mkdirSync(dirname(resolve(out)), { recursive: true });

if (cmd === "encrypt") {
  const s = salt();
  const key = await deriveKey(s, ITER);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gzipSync(readFileSync(inp), { level: 9 }));
  writeFileSync(out, JSON.stringify({ v: 1, iter: ITER, salt: b64(s), iv: b64(iv), ct: b64(new Uint8Array(ct)) }));
} else {
  const f = JSON.parse(readFileSync(inp, "utf8"));
  const key = await deriveKey(unb64(f.salt), f.iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.iv) }, key, unb64(f.ct));
  writeFileSync(out, gunzipSync(Buffer.from(pt)));
}
