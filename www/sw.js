/* Patrika Vitran Suite â€” offline cache */
const CACHE = "patrika-vitran-v247";
const ASSETS = [
  "./", "./index.html", "./css/app.css?v=15", "./js/data.js?v=21", "./js/app.js?v=247",
  "./manifest.webmanifest", "./assets/patrika-logo.png", "./assets/icon-192.png", "./assets/icon-512.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Only cache same-origin static assets. API calls (/api/*) must always go straight to
  // the network — never intercepted or cached by the SW (dynamic data; SW fallback would
  // serve index.html instead of JSON, silently breaking every fetch in the app).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(m => m || caches.match("./index.html")))
  );
});
