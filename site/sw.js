// Everything is network-first (always fresh when online) and falls back to the last cached copy
// when offline, so the installed app still opens without a connection. Bump VERSION when the shell files change.
const VERSION = "ramp-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "charts.js", "crypto.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith("/data.enc")) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put("data.enc", copy)); }
      return r;
    }).catch(() => caches.match("data.enc")));
    return;
  }
  // Network-first for the shell too: a deploy shows up on the next open (not one reload late).
  // The cache is only the offline fallback.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
