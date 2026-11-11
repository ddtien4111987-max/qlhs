// Lưu sẵn phần giao diện để app mở nhanh và mở được khi mạng yếu. Dữ liệu dự án luôn lấy trực tiếp từ Google Drive.
const CACHE = "qlhs-v1.1.0";
const SHELL = ["./", "index.html", "config.js", "manifest.webmanifest", "js/app.js", "js/core.js", "js/store.js", "js/drive.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Google API: không đụng tới
  // mạng trước (để nhận bản mới), mất mạng thì dùng bản đã lưu
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});
