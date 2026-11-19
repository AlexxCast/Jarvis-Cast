// Prima la rete (così ogni aggiornamento pubblicato arriva subito), la copia locale se si è offline
// o se il server non risponde entro pochi secondi: l'app si apre sempre, anche col server bloccato.
const CACHE = 'kestra-shell-v58';
const SHELL = ['/', '/style.css', '/app.js', '/orb.js', '/visual.js', '/offline.js', '/net2d.js', '/overlay.html', '/overlay.js', '/logo.png', '/manifest.webmanifest'];
const WAIT_MS = 4000;

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k.startsWith('kestra-shell-')).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/')) return;
  const fromCache = () => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('/') : undefined));
  const net = fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  });
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    // Rete lenta o server bloccato: dopo WAIT_MS si usa la copia (la rete intanto aggiorna la copia per la prossima volta).
    const t = setTimeout(() => fromCache().then(finish), WAIT_MS);
    net.then(res => { clearTimeout(t); if (res.ok || done) return finish(res); return fromCache().then(hit => finish(hit || res)); })
      .catch(() => { clearTimeout(t); fromCache().then(hit => finish(hit || Response.error())); });
  }));
});
