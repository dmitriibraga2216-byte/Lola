/**
 * Офлайн-режим прогона чек-листа (docs/20 §5.4, §12): черновик живёт в localStorage,
 * фото — как data URL до отправки; при появлении сети очередь отправляется с фактическим временем.
 */
export interface OfflinePhoto { dataUrl: string, mediaId?: string }
export interface OfflineRun {
  key: string // локальный id
  runId: string | null // серверный id, если уже создан
  checklistId: string
  locationId?: string
  subjectUserId?: string
  startedAt: string
  finishedAt?: string
  answers: Record<string, { value: number | null, comment: string, isNa: boolean, photos: OfflinePhoto[] }>
  signature?: OfflinePhoto | null // подпись проверяемого (Б.1), догружается как фото
  actionPlan: { id: string, text: string, responsibleId: string, dueAt: string, status: 'open' }[]
  pendingFinish: boolean
}
const STORAGE = 'lola.checklistRuns'

function readAll(): Record<string, OfflineRun> {
  try { return JSON.parse(localStorage.getItem(STORAGE) || '{}') } catch { return {} }
}
function writeAll(all: Record<string, OfflineRun>) {
  try { localStorage.setItem(STORAGE, JSON.stringify(all)) } catch { /* переполнение хранилища — фото слишком большие */ }
}

export function useOfflineRuns() {
  const { api } = useApi()
  const { upload } = useMediaUpload()
  const online = ref(true)
  const syncing = ref(false)

  function save(run: OfflineRun) { const all = readAll(); all[run.key] = run; writeAll(all) }
  function load(key: string): OfflineRun | null { return readAll()[key] ?? null }
  function remove(key: string) { const all = readAll(); writeAll(Object.fromEntries(Object.entries(all).filter(([k]) => k !== key))) }
  function pending(): OfflineRun[] { return Object.values(readAll()).filter(r => r.pendingFinish) }

  async function dataUrlToBlob(dataUrl: string): Promise<Blob> { return (await fetch(dataUrl)).blob() }

  /** Отправка одного прогона: создать на сервере (если нет), догрузить фото, PUT ответов, finish. */
  async function push(run: OfflineRun): Promise<{ ok: true } | { ok: false, code: string, message: string, itemIds?: string[] }> {
    if (!run.runId) {
      const r = await api<{ id: string }>(`/checklists/${run.checklistId}/runs`, { method: 'POST', body: { locationId: run.locationId, subjectUserId: run.subjectUserId, startedAt: run.startedAt, device: navigator.userAgent.slice(0, 200) } })
      run.runId = r.id
      save(run)
    }
    for (const a of Object.values(run.answers)) {
      for (const p of a.photos) {
        if (!p.mediaId) { p.mediaId = await upload(await dataUrlToBlob(p.dataUrl), 'photo.jpg', 'checklist_photo', { sourceEntity: 'checklist_runs', sourceId: run.runId }); save(run) }
      }
    }
    if (run.signature && !run.signature.mediaId) { run.signature.mediaId = await upload(await dataUrlToBlob(run.signature.dataUrl), 'signature.png', 'checklist_photo', { sourceEntity: 'checklist_runs', sourceId: run.runId }); save(run) }
    const answers = Object.entries(run.answers).map(([itemId, a]) => ({ itemId, value: a.value, comment: a.comment || null, isNa: a.isNa, photoMediaIds: a.photos.map(p => p.mediaId!).filter(Boolean) }))
    if (!run.pendingFinish) {
      await api(`/checklist-runs/${run.runId}`, { method: 'PUT', body: { answers, startedAt: run.startedAt, actionPlan: run.actionPlan } })
      return { ok: true }
    }
    try {
      await api(`/checklist-runs/${run.runId}/finish`, { method: 'POST', body: { answers, actionPlan: run.actionPlan, startedAt: run.startedAt, finishedAt: run.finishedAt ?? new Date().toISOString(), signatureMediaId: run.signature?.mediaId } })
      remove(run.key)
      return { ok: true }
    } catch (err) {
      const e = apiErrorOf(err)
      if (e.code.startsWith('checklist.')) { run.pendingFinish = false; save(run) } // ошибка валидации — вернуть в черновик
      return { ok: false, code: e.code, message: e.message, itemIds: e.details?.itemIds as string[] | undefined }
    }
  }

  async function syncPending() {
    if (syncing.value || !online.value) return
    syncing.value = true
    try { for (const r of pending()) { try { await push(r) } catch { /* сеть пропала — попробуем позже */ } } }
    finally { syncing.value = false }
  }

  onMounted(() => {
    online.value = navigator.onLine
    window.addEventListener('online', () => { online.value = true; syncPending() })
    window.addEventListener('offline', () => { online.value = false })
    syncPending()
  })

  return { online, syncing, save, load, remove, pending, push, syncPending }
}
