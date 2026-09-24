import type { MediaOrigin } from '../../shared/enums'

/**
 * Отложенные загрузки на устройстве (docs/v2/34 §7.5, §13 к. 1): квота компании исчерпана —
 * запись сотрудника **не теряется**, а ждёт здесь, в IndexedDB, под `clientRef`, и досылается
 * тем же единственным входом `POST /media/upload-url` (решение В-17), как только сервер выдаст
 * место (`storage.pending_upload_retry`, каждые 15 минут и при освобождении места).
 *
 * Хранилище — IndexedDB: видео не помещается в localStorage (там живёт офлайн-очередь
 * чек-листов, `useOfflineRuns`), а OPFS доступен не во всех браузерах телефонов. Сервер ничего
 * не решает по содержимому этого хранилища — оно только держит файл до досылки.
 */
export interface LocalPendingUpload {
  clientRef: string
  blob: Blob
  filename: string
  mime: string
  bytes: number
  origin: MediaOrigin
  sourceEntity?: string
  sourceId?: string
  enrollmentId?: string
  pendingId?: string
  savedAt: string
}

const DB_NAME = 'lola-pending-uploads'
const STORE = 'files'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'clientRef' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  finally { db.close() }
}

/** Ключ записи на устройстве — уникален в пределах человека (`storage_pending_uploads.client_ref`). */
export function newClientRef(): string {
  return `dev:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`
}

let syncing = false

export function usePendingUploads() {
  const { api } = useApi()

  async function saveLocal(item: LocalPendingUpload): Promise<void> {
    await tx('readwrite', s => s.put(item))
  }
  async function removeLocal(clientRef: string): Promise<void> {
    await tx('readwrite', s => s.delete(clientRef))
  }
  async function listLocal(): Promise<LocalPendingUpload[]> {
    if (typeof indexedDB === 'undefined') return []
    return tx('readonly', s => s.getAll() as IDBRequest<LocalPendingUpload[]>)
  }

  /**
   * Дослать всё, что ждёт на устройстве. Сервер отвечает ссылкой — файл уходит в S3 и
   * подтверждается (сдача получает файл и попадает к ментору); отвечает «ещё ждём» — запись
   * остаётся; «уже дослан» или «срок истёк» — локальная копия больше не нужна.
   */
  async function syncPending(): Promise<number> {
    if (syncing || typeof navigator === 'undefined' || !navigator.onLine) return 0
    syncing = true
    let sent = 0
    try {
      for (const item of await listLocal().catch(() => [])) {
        try {
          const res = await api<{ mediaId?: string, uploadUrl?: string, deferred?: boolean }>('/media/upload-url', {
            method: 'POST',
            body: {
              filename: item.filename, mime: item.mime, bytes: item.bytes, origin: item.origin, clientRef: item.clientRef,
              ...(item.sourceEntity ? { sourceEntity: item.sourceEntity } : {}),
              ...(item.sourceId ? { sourceId: item.sourceId } : {}),
              ...(item.enrollmentId ? { enrollmentId: item.enrollmentId } : {}),
            },
          })
          if (res.deferred || !res.uploadUrl || !res.mediaId) continue
          const put = await fetch(res.uploadUrl, { method: 'PUT', body: item.blob, headers: { 'Content-Type': item.mime } })
          if (!put.ok) continue
          await api(`/media/${res.mediaId}/complete`, { method: 'POST' })
          await removeLocal(item.clientRef)
          sent++
        }
        catch (err) {
          const code = apiErrorOf(err).code
          if (code === 'pending_upload_done' || code === 'pending_upload_abandoned') await removeLocal(item.clientRef).catch(() => null)
          // сеть пропала или сервер недоступен — попробуем при следующей синхронизации
        }
      }
    }
    finally { syncing = false }
    return sent
  }

  return { saveLocal, removeLocal, listLocal, syncPending }
}
