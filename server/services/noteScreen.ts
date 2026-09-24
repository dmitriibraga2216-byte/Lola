/**
 * Лексический скрин заметки о человеке (docs/v2/38-people-extensions.md §7.5, §6.1).
 *
 * Запрещено фиксировать здоровье и диагнозы, беременность, инвалидность, личную и семейную
 * жизнь, религиозные и политические убеждения, национальность, ориентацию, членство в
 * профсоюзе, судимость, финансовое положение и оценки внешности. Механизм — **мягкий**:
 * скрин не блокирует сохранение, а просит подтверждения и ставит `flagged_at` (§7.5).
 * Блокировать нельзя — «хворів, переносимо дедлайн» законная рабочая заметка, ложное
 * срабатывание неизбежно, а жёсткий запрет выталкивает переписку в мессенджер без аудита.
 *
 * Словарь — основы слов (совпадение по началу слова), три языка интерфейса. Короткие слова,
 * которые как основа ловили бы всё подряд («гей» → «гейзер»), сравниваются целиком.
 * `[гипотеза]` §7.5 говорит о «словаре тенанта»; экрана правки словаря в ТЗ нет, поэтому
 * `[решение]`: встроенный словарь по умолчанию, расширение тенантом — отдельной задачей.
 * *Чем проверяется:* появление в `docs/24` настроек словаря — тогда он дополняет этот.
 */

/** Признак чувствительного содержания — ключ подписи в интерфейсе (`personNotes.sign.*`). */
export const SENSITIVE_SIGNS = [
  'health', 'pregnancy', 'disability', 'private_life', 'religion', 'politics',
  'ethnicity', 'orientation', 'union', 'criminal', 'finance', 'appearance',
] as const
export type SensitiveSign = typeof SENSITIVE_SIGNS[number]

interface SignDictionary { stems: string[], words?: string[] }

const DICTIONARY: Record<SensitiveSign, SignDictionary> = {
  health: { stems: ['хвор', 'захвор', 'діагноз', 'диагноз', 'болезн', 'заболе', 'лікуван', 'лечени', 'лечит', 'психіатр', 'психиатр', 'депрес', 'онколог', 'діабет', 'диабет', 'епілеп', 'эпилеп', 'diagnos', 'illness', 'disease', 'sick'] },
  pregnancy: { stems: ['вагітн', 'беремен', 'pregnan'] },
  disability: { stems: ['інвалідн', 'инвалидн', 'disabilit', 'handicap'] },
  private_life: { stems: ['розлуч', 'развод', 'разведен', 'divorc', 'коханц', 'коханк', 'любовниц', 'любовник', 'інтимн', 'интимн', 'intimat'] },
  religion: { stems: ['релігі', 'религи', 'religio', 'віруюч', 'верующ', 'церкв', 'церков', 'мечет', 'синагог', 'атеїст', 'атеист', 'atheis', 'мусульман', 'muslim', 'християн', 'христиан', 'christian'] },
  // Без «партія»: в общепите это чаще «партія товару», чем политическая партия
  politics: { stems: ['політич', 'политич', 'politic'] },
  ethnicity: { stems: ['етніч', 'этнич', 'ethnic', 'національніст', 'национальност', 'nationalit', 'расов', 'racial'] },
  orientation: { stems: ['сексуальн', 'sexual', 'гомосексу', 'homosexu', 'лесбі', 'лесби', 'lesbian', 'бісексу', 'бисексу', 'bisexu', 'трансгендер', 'transgender'], words: ['гей', 'gay'] },
  union: { stems: ['профспілк', 'профсоюз'] },
  criminal: { stems: ['судим', 'засуджен', 'осужден', 'criminal', 'convict', 'вязниц', 'тюрьм', 'prison'] },
  // Без «борг» и «кредит»: у кассира это служебные данные («розрахувався кредитною карткою»)
  finance: { stems: ['аліменти', 'алимент', 'alimony', 'банкрут', 'bankrupt', 'колектор', 'коллектор', 'мікрокредит', 'микрокредит', 'debt'] },
  appearance: { stems: ['зовнішніст', 'внешност', 'некрасив', 'негарн', 'огрядн', 'ugly'], words: ['fat'] },
}

export interface ScreenResult {
  /** Признаки в порядке словаря, без повторов. Пусто — скрин не сработал. */
  signs: SensitiveSign[]
  /** Совпавшие слова текста — в `user_notes.flagged_terms`; не больше 20. */
  terms: string[]
}

/** Слова текста в нижнем регистре; апостроф внутри слова — часть слова («в'язниця»). */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[’ʼ`]/g, '\'').split(/[^\p{L}\p{N}']+/u).map(w => w.replace(/'/g, '')).filter(Boolean)
}

export function screenNoteText(text: string): ScreenResult {
  const signs: SensitiveSign[] = []
  const terms = new Set<string>()
  const words = tokens(text)
  for (const sign of SENSITIVE_SIGNS) {
    const dict = DICTIONARY[sign]
    let hit = false
    for (const w of words) {
      if (dict.stems.some(s => w.startsWith(s)) || dict.words?.includes(w)) {
        hit = true
        if (terms.size < 20) terms.add(w)
      }
    }
    if (hit) signs.push(sign)
  }
  return { signs, terms: [...terms] }
}
