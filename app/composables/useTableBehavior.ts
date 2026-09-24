/**
 * «Поведінка таблиць» (docs/v2/39 П-24.1, снято со второго эталона: «Автоматично завантажувати
 * дані після прокручування таблиці вниз»): настройка **этого браузера**, а не аккаунта и не
 * пространства — на рабочем компьютере точки один человек листает длинные таблицы, на телефоне
 * руководителя тот же человек хочет кнопку. Живёт в `localStorage`, на сервер не уходит.
 */
const KEY = 'lola.tables.autoLoad'

export function useTableBehavior() {
  const autoLoad = useState<boolean>('tables:autoLoad', () => false)
  const loaded = useState<boolean>('tables:autoLoadRead', () => false)

  /** Прочитать выбор браузера — только на клиенте (при SSR `localStorage` нет). */
  function readPreference(): void {
    if (loaded.value || typeof window === 'undefined') return
    loaded.value = true
    try { autoLoad.value = window.localStorage.getItem(KEY) === '1' }
    catch { autoLoad.value = false } // приватный режим без хранилища — остаётся кнопка
  }

  function setAutoLoad(on: boolean): void {
    autoLoad.value = on
    try { window.localStorage.setItem(KEY, on ? '1' : '0') }
    catch { /* хранилище недоступно — выбор живёт до перезагрузки вкладки */ }
  }

  return { autoLoad, readPreference, setAutoLoad }
}
