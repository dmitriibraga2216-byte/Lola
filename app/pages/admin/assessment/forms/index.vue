<script setup lang="ts">
/** Анкети оцінки — список за мокапом Assessments: назва · тип · критеріїв · шкала · дата зміни · опубліковано. */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assessment.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Row { id: string, title: string, kind: string, is_active: boolean, is_locked: boolean, tags: string[], updated_at: string, scale_name: string, criteria_count: number, cycles_count: number }
const items = ref<Row[]>([])
const error = ref('')
onMounted(async () => { try { items.value = await api<Row[]>('/assessment/forms') } catch (err) { error.value = apiErrorOf(err).message } })
const fmt = (d: string) => formatShortDate(new Date(d))
</script>
<template>
  <div>
    <PageHeader :title="t('assess.forms')" :crumbs="[{ label: t('assess.sectionTitle') }]">
      <template #actions><NuxtLink to="/admin/assessment/forms/new" class="btn primary">{{ t('assess.createForm') }}</NuxtLink></template>
    </PageHeader>
    <p v-if="error" class="note coral">{{ error }}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('assess.col.title') }}</th><th>{{ t('assess.col.kind') }}</th><th class="num">{{ t('assess.col.criteria') }}</th><th>{{ t('assess.col.scale') }}</th><th>{{ t('assess.col.updated') }}</th><th>{{ t('assess.col.published') }}</th></tr></thead>
        <tbody>
          <tr v-for="f in items" :key="f.id">
            <td><NuxtLink :to="`/admin/assessment/forms/${f.id}`" class="link">{{ f.title }}</NuxtLink><span v-if="f.is_locked" class="sub">{{ t('assess.lockedShort') }}</span></td>
            <td>{{ t(`assess.formKind.${f.kind}`) }}</td>
            <td class="num">{{ f.criteria_count }}</td>
            <td>{{ f.scale_name }}</td>
            <td>{{ fmt(f.updated_at) }}</td>
            <td><span :class="['badge', f.is_active ? 'teal' : 'muted']">{{ f.is_active ? t('common.yes') : t('common.no') }}</span></td>
          </tr>
          <tr v-if="!items.length"><td colspan="6" class="sub">{{ t('assess.noForms') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<style scoped>
.link { color: var(--color-ink); font-weight: 800; text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
