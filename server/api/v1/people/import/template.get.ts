import { requireScope } from '../../../../services/access'
import { buildImportTemplate } from '../../../../services/importPeople'

export default defineEventHandler(async (event) => {
  await requireScope(event, 'people.import')
  const buffer = await buildImportTemplate()
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-import-template.xlsx"')
  return buffer
})
