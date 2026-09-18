/** Liveness: процесс жив. Версия и коммит — чтобы понимать, что развёрнуто (docs/26 §26.8). */
export default defineEventHandler(() => ({
  status: 'ok',
  version: process.env.APP_VERSION || 'dev',
  commit: process.env.APP_COMMIT || 'local',
}))
