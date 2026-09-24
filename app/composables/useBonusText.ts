/**
 * «N бонусів» з правильною формою множини під активну мову (`shop.bonusesCount.*`,
 * категорія — `useFormat().plural`): «1 бонус», «3 бонуси», «5 бонусів»; число — з розділювачами.
 */
export function useBonusText() {
  const { t } = useI18n()
  const { plural, formatNumber } = useFormat()
  return (n: number) => t(`shop.bonusesCount.${plural(Math.abs(n))}`, { n: formatNumber(n) })
}
