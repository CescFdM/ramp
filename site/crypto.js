// Client side unlock. Mirrors scripts/crypt.mjs (keep the two in sync).
// Key = PBKDF2-SHA256(username.trim().toLowerCase() + "\n" + password, salt, iter) -> AES-256-GCM.
// The derived key is kept as a NON-extractable CryptoKey in IndexedDB so the installed app opens
// without asking again; the password itself is never stored.

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(username, password, saltB64, iter) {
  const raw = new TextEncoder().encode(username.trim().toLowerCase() + "\n" + password);
  const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, base,
    { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

export async function decryptFile(file, key) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, unb64(file.ct));
  const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("ramp-auth", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", mode);
    const out = fn(tx.objectStore("kv"));
    tx.oncomplete = () => res(out && out.result);
    tx.onerror = () => rej(tx.error);
  });
}
export const saveKey = (key, salt) => kv("readwrite", (s) => s.put({ key, salt }, "k")).catch(() => {});
export const loadKey = () => kv("readonly", (s) => s.get("k")).catch(() => null);
export const clearKey = () => kv("readwrite", (s) => s.delete("k")).catch(() => {});
