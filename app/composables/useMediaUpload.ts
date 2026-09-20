/** Загрузка файла через presigned PUT (docs/06 §6.1): upload-url → PUT → complete. Возвращает mediaId. */
export function useMediaUpload() {
  const { api } = useApi()
  async function upload(file: Blob, filename: string, resourceId?: string): Promise<string> {
    // resourceId — для лимита «на ресурс разом ≤ 1 ГБ» (docs/11 Г-11.4); отказ приходит до начала передачи
    const { mediaId, uploadUrl } = await api<{ mediaId: string, uploadUrl: string }>('/media/upload-url', { method: 'POST', body: { filename, mime: file.type, bytes: file.size, ...(resourceId ? { resourceId } : {}) } })
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
    if (!put.ok) throw new Error('upload failed')
    await api(`/media/${mediaId}/complete`, { method: 'POST' })
    return mediaId
  }
  /** Сжатие фото с камеры до ~1280px в JPEG — для офлайн-хранения и быстрой отправки. */
  async function compressImage(file: File, max = 1280): Promise<Blob> {
    if (!file.type.startsWith('image/') || typeof createImageBitmap === 'undefined') return file
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * k)
    canvas.height = Math.round(bmp.height * k)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return new Promise(resolve => canvas.toBlob(b => resolve(b ?? file), 'image/jpeg', 0.82))
  }
  return { upload, compressImage }
}
