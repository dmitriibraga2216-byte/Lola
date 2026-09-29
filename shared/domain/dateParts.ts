/**
 * Дата из трёх списков — день, месяц, год (замечание администратора 27.09: в iPad Safari
 * у `<input type="date">` в карточке человека выбирались только месяц и год). Значение —
 * ISO `YYYY-MM-DD`, как у `input[type=date]`; пока выбраны не все три части — пустая строка.
 */
export interface DateParts { y: string, m: string, d: string }

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function splitIsoDate(iso: string | null | undefined): DateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? { y: m[1]!, m: String(Number(m[2])), d: String(Number(m[3])) } : { y: '', m: '', d: '' }
}

/** Все три части → ISO; день обрезается до длины месяца (31 → 28/29 для лютого). */
export function joinDateParts(p: DateParts): string {
  if (!p.y || !p.m || !p.d) return ''
  const y = Number(p.y)
  const m = Number(p.m)
  const d = Math.min(Number(p.d), daysInMonth(y, m))
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Годы списка — от новых к старым: для даты рождения нужный год ближе к началу. */
export function yearRange(minYear: number, maxYear: number): number[] {
  const out: number[] = []
  for (let y = maxYear; y >= minYear; y--) out.push(y)
  return out
}
