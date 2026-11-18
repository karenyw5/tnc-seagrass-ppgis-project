/* Service worker: keeps a copy of every app file on the device so the survey
   opens with no internet. Map tiles from openstreetmap.org are NOT cached
   (OSM's tile policy forbids bulk caching); offline, the bundled coastline shows. */

// Bump together with APP_VERSION in js/config.js whenever any file in docs/ changes.
const CACHE_VERSION = "1.0.0";
const CACHE_NAME = `seagrass-survey-${CACHE_VERSION}`;
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "js/config.js",
  "js/db.js",
  "js/export.js",
  "js/map.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "data/hexes.geojson",
  "data/coastline.geojson",
  "photos/seagrass-wakatobi.jpg",
  "photos/seagrass-west-java.jpg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // "reload" skips the browser's HTTP cache so a new version gets fresh files.
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("seagrass-survey-") && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      if (request.mode === "navigate") {
        const page = await cache.match("index.html");
        if (page) return page;
      }
      throw error;
    }
  })());
});
