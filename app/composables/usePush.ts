/**
 * Push-уведомления PWA (docs/23 §4, докс/33 D-051): підписка/відписка браузера без бібліотек.
 * Сервер-воркер `/public/sw.js`, ключ — `NUXT_PUBLIC_VAPID_PUBLIC_KEY` (публічна частина VAPID).
 */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

export function usePush() {
  const { api } = useApi()

  const isSupported = () => import.meta.client && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

  async function currentSubscription(): Promise<PushSubscription | null> {
    if (!isSupported()) return null
    const reg = await navigator.serviceWorker.register('/sw.js')
    return reg.pushManager.getSubscription()
  }

  async function subscribe(): Promise<{ ok: true } | { ok: false, error: string }> {
    if (!isSupported()) return { ok: false, error: 'Браузер не підтримує push-сповіщення' }
    const key = useRuntimeConfig().public.vapidPublicKey as string
    if (!key) return { ok: false, error: 'Push не налаштовано на сервері' }
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return { ok: false, error: 'Дозвіл на сповіщення не надано' }
    const reg = await navigator.serviceWorker.register('/sw.js')
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource })
    const json = sub.toJSON() as { endpoint: string, keys?: { p256dh: string, auth: string } }
    if (!json.keys) return { ok: false, error: 'Підписка без ключів шифрування' }
    await api('/push/subscribe', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } })
    return { ok: true }
  }

  async function unsubscribe(): Promise<void> {
    const sub = await currentSubscription()
    if (!sub) return
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint } })
  }

  return { isSupported, currentSubscription, subscribe, unsubscribe }
}
