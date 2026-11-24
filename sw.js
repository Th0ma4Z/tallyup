// Keeps a copy of TallyUp's own files on the phone so it opens without internet,
// for example at a card table with no signal. It always tries the internet
// first, so a new version shows up as soon as it's published; the saved copy is
// used only when the internet fails or takes too long. Records are not here:
// they live in localStorage. Exchange rates are cached by app.js.

const CACHE = "tallyup-files";
const NETWORK_WAIT_MS = 3000;
// Every file the app needs to open (a test checks that none is missing).
const APP_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "ledger.js",
  "i18n.js",
  "lang/zh.js",
  "lang/zh-Hant.js",
  "lang/en.js",
  "lang/es.js",
  "lang/ja.js",
  "lang/ko.js",
  "lang/fr.js",
  "lang/de.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];
const APP_URLS = new Set(APP_FILES.map((file) => new URL(file, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((file) => new Request(file, { cache: "no-cache" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  url.search = "";
  // Only TallyUp's own files; everything else (like exchange rates) goes
  // straight to the internet as usual.
  if (event.request.method !== "GET" || !APP_URLS.has(url.href)) {
    return;
  }
  event.respondWith(networkFirst(url.href));
});

async function networkFirst(url) {
  const cache = await caches.open(CACHE);
  // "no-cache" asks the server whether the file changed, so an update isn't
  // hidden behind the browser's own short-term copy.
  const fromNetwork = fetch(url, { cache: "no-cache" }).then((response) => {
    if (response.ok) {
      cache.put(url, response.clone());
    }
    return response;
  });
  // A late failure, after the saved copy was already used, is expected offline.
  fromNetwork.catch(() => {});
  const tooSlow = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS));
  let first = null;
  try {
    first = await Promise.race([fromNetwork, tooSlow]);
  } catch {
    // No internet: use the saved copy below.
  }
  if (first?.ok) {
    return first;
  }
  const saved = await cache.match(url);
  // With no saved copy, return the server's answer, or wait for it after all.
  return saved ?? first ?? fromNetwork;
}
