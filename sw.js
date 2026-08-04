/* FamilyHub — service worker: оффлайн-оболочка */
const CACHE = 'family-hub-v90';
const SHARE_CACHE = 'fh-share';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './notif-icon.png',
  './icon-512.png',
  './maskable-512.png',
  './badge-96.png',
  './sc-task.png',
  './sc-note.png',
  './sc-chat.png',
];


self.addEventListener('install', e => {
  // складываем файлы по одному: если какой-то не залит на хостинг,
  // установка всё равно проходит — иначе приложение вообще не поставится
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // SHARE_CACHE не трогаем: в нём лежит только что переданное из другого приложения
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Отдельная база только для передачи: страница её не открывает,
// поэтому заблокировать открытие некому.
const SDB = 'fh-share-db';
function shareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SDB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error('idb open'));
    req.onblocked = () => reject(new Error('idb blocked'));
  });
}
function sdbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    tx.objectStore('items').put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror    = () => reject(tx.error || new Error('idb put'));
    tx.onabort    = () => reject(tx.error || new Error('idb abort'));
  });
}

// раскладываем переданное и сообщаем результат
async function storeShared(request) {
  const form = await request.formData();
  const files = [...form.getAll('sfiles'), ...form.getAll('sdocs')]
    .filter(f => f && typeof f === 'object' && f.size);

  const db = await shareDB();
  const list = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const key = 'f' + Date.now() + '-' + i;
      // кладём как Blob: File напрямую часть движков хранить отказывается
      const buf  = await files[i].arrayBuffer();
      const blob = new Blob([buf], { type: files[i].type || 'application/octet-stream' });
      await sdbPut(db, key, blob);
      list.push({ key, name: files[i].name || ('file-' + i), type: files[i].type || '' });
    }
    await sdbPut(db, 'meta', {
      title: form.get('stitle') || '',
      text:  form.get('stext')  || '',
      url:   form.get('surl')   || '',
      files: list, at: Date.now(),
    });
  } finally { try { db.close(); } catch (_) {} }

  try {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: 'shared-ready' }));
  } catch (_) {}
  return 'ok';
}

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
  try { d = e.data.json(); } catch (_) { d = { title: 'FamilyHub', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const isChat = typeof d.tag === 'string' && d.tag.indexOf('chat-') === 0;
    if (isChat && await chatIsVisible()) return;   // чат открыт на экране — не дублируем
    await self.registration.showNotification(d.title || 'FamilyHub', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: new URL('notif-icon.png', self.registration.scope).href,
      badge: new URL('badge-96.png', self.registration.scope).href,
    });
  })());
});

// определяем, к чему ведёт уведомление, по его тегу
function routeForTag(tag) {
  tag = tag || '';
  if (tag.indexOf('chat-') === 0) return { screen: 'chat' };
  if (tag.indexOf('call-') === 0) return { screen: 'chat' };   // звонок уже закончился к моменту клика
  // дело/заметка: вытаскиваем числовой id из разных форматов тега
  const patterns = [
    /^evt-new-(\d+)/, /^evt-asg-(\d+)-/, /^evt-done-(\d+)-/, /^evt-acc-(\d+)-/,
    /^ping-(\d+)-/, /^s(\d+)\|/, /^d(\d+)\|/,
  ];
  for (const re of patterns) {
    const m = tag.match(re);
    if (m) return { taskId: m[1] };
  }
  if (tag.indexOf('od|') === 0) return { screen: 'main' };     // сводка просроченных — список дел
  return {};
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const route = routeForTag(e.notification.tag);
  const qs = route.taskId ? ('?task=' + route.taskId)
           : route.screen ? ('?screen=' + route.screen)
           : '';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
      for (const c of cs) {
        if ('focus' in c) {
          await c.focus();
          try {
            if (route.taskId) c.postMessage({ type: 'open-task', taskId: route.taskId });
            else if (route.screen) c.postMessage({ type: 'open-screen', screen: route.screen });
          } catch (_) {}
          return;
        }
      }
      return clients.openWindow('./' + qs);
    })
  );
});

// приём того, чем поделились: файлы кладём во временное хранилище,
// затем открываем приложение — оно их заберёт
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    // ответ обязан вернуться в любом случае: если обработчик зависнет,
    // браузер покажет «Failed to fetch» вместо приложения
    const done = (st, why) => Response.redirect(new URL(
      './index.html?shared=' + st + (why ? '&why=' + encodeURIComponent(String(why).slice(0, 140)) : ''),
      self.registration.scope).href, 303);
    e.respondWith((async () => {
      try {
        const st = await Promise.race([
          storeShared(e.request),
          new Promise(r => setTimeout(() => r('timeout'), 8000)),
        ]);
        return done(st);
      } catch (err) {
        return done('error', (err && (err.message || err.name)) || err);
      }
    })());
    return;
  }

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
        // адреса с параметрами (ярлыки, «поделиться») в кэш не кладём —
        // иначе он засоряется, а отдавать всё равно нужно базовую страницу
        if (res && res.ok && !url.search) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html').then(h => h || caches.match(e.request)))
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
