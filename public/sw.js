// Service worker PWA (докс/33 D-051, docs/23 §4) — мінімальний, без бібліотек.
// Пуш іде без зашифрованої полезної нагрузки [решение, server/services/push.ts]: подія `push`
// приходить без `event.data`, тому сповіщення завжди загальне — справжній текст лежить
// у дзвіночку (`/learn/notifications`), куди веде клік.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  const title = 'Lola'
  const options = {
    body: 'У вас нове сповіщення',
    icon: '/favicon.ico',
    tag: 'lola-push',
    renotify: true,
    data: { url: '/learn/notifications' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/learn/notifications'
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of clientsList) {
      if ('focus' in c) { await c.focus(); if ('navigate' in c) c.navigate(url); return }
    }
    await self.clients.openWindow(url)
  })())
})
