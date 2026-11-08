// rooru.invest 서비스워커: 앱 껍데기(index.html·manifest·아이콘)만 저장해서 오프라인에도 열리게.
// 자료(GitHub API·시세 중계)는 절대 저장하지 않음 (늘 최신). 새 버전은 index.html의 app-version 확인 → 앱이 스스로 새로고침.
const C = "rooru-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;   // GitHub·시세·글꼴은 건드리지 않음
  // 화면 파일: 네트워크 먼저(새 버전), 안 되면 저장본
  e.respondWith(fetch(e.request).then(r => { if (r.ok && !/[?&]v=/.test(u.search)) caches.open(C).then(c => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request, {ignoreSearch: true}).then(r => r || caches.match("./index.html"))));
});
