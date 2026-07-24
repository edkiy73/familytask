/* Семейный Хаб — service worker: оффлайн-оболочка */
const CACHE = 'family-hub-v59';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* --- есть ли открытый и активный экран чата? --- */
function readUiState() {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), 400);
    try {
      const req = indexedDB.open('family-hub', 1);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) return finish(null);
          const g = db.transaction('kv', 'readonly').objectStore('kv').get('ui');
          g.onsuccess = () => finish(g.result || null);
          g.onerror = () => finish(null);
        } catch (_) { finish(null); }
      };
      req.onerror = () => finish(null);
    } catch (_) { finish(null); }
  });
}

async function chatIsVisible() {
  const cs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const focused = cs.some(c => c.visibilityState === 'visible' && c.focused);
  if (!focused) return false;                 // приложение свёрнуто/в фоне → показываем
  const ui = await readUiState();
  if (!ui) return false;
  // экран чата открыт и состояние свежее (страница жива)
  return ui.screen === 'chat' && (Date.now() - (ui.at || 0) < 60000);
}

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: 'Семейный Хаб', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const isChat = typeof d.tag === 'string' && d.tag.indexOf('chat-') === 0;
    if (isChat && await chatIsVisible()) return;   // чат открыт на экране — не дублируем
    await self.registration.showNotification(d.title || 'Семейный Хаб', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tag = e.notification.tag || '';
  const goChat = tag.indexOf('chat-') === 0;   // сообщения и SOS ведут в чат
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
      for (const c of cs) {
        if ('focus' in c) {
          await c.focus();
          if (goChat) { try { c.postMessage({ type: 'open-screen', screen: 'chat' }); } catch (_) {} }
          return;
        }
      }
      return clients.openWindow(goChat ? './?screen=chat' : './');
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Google Fonts: cache-first с докачкой в кэш
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // HTML-навигация: network-first, чтобы обновления доезжали сразу
  if (e.request.mode === 'navigate' || url.pathname.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(h => h || caches.match('./index.html')))
    );
    return;
  }

  // Остальная статика своего origin: cache-first с фоновым обновлением
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        const net = fetch(e.request).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
