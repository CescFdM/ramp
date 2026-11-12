// Client side unlock. Mirrors scripts/crypt.mjs (keep the two in sync).
// Key = PBKDF2-SHA256(username.trim().toLowerCase() + "\n" + password, salt, iter) -> AES-256-GCM.
// The derived key is kept as a NON-extractable CryptoKey in IndexedDB so the installed app opens
// without asking again; the password itself is never stored.

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(username, password, saltB64, iter) {
  const raw = new TextEncoder().encode(username.trim().toLowerCase() + "\n" + password);
  const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function decryptFile(file, key) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, unb64(file.ct));
  const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

// Same container format as decryptFile / scripts/crypt.mjs: gzip -> AES-GCM -> {v,iter,salt,iv,ct}.
// Used to send requests through the (public) workflow inputs without exposing their content.
export async function encryptJson(obj, key, saltB64, iter) {
  const gz = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  const plain = await new Response(gz).arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return JSON.stringify({ v: 1, iter, salt: saltB64, iv: b64(iv), ct: b64(ct) });
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

// GitHub token (Actions only) lives next to the key, on this device only.
export const saveToken = (t) => kv("readwrite", (s) => s.put(t, "gh")).catch(() => {});
export const loadToken = () => kv("readonly", (s) => s.get("gh")).catch(() => null);
export const clearToken = () => kv("readwrite", (s) => s.delete("gh")).catch(() => {});
export const saveJob = (j) => kv("readwrite", (s) => (j ? s.put(j, "job") : s.delete("job"))).catch(() => {});
export const loadJob = () => kv("readonly", (s) => s.get("job")).catch(() => null);
