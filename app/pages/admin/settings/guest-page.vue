<script setup lang="ts">
/** Гостьова сторінка (docs/21 Г-21.3, docs/24 guest_page_block): приветствие, кому писати, політика даних. */
import type { ContentBlock } from '../../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()
const form = reactive({ welcome: [{ id: 'b1', type: 'text', html: '<p></p>' }] as ContentBlock[], supportContact: { name: '', phone: '', email: '', telegram: '' }, policyUrl: '' })
const error = ref('')
const saved = ref(false)
onMounted(async () => {
  try {
    const g = await api<{ welcome: ContentBlock[], supportContact: Record<string, string>, policyUrl: string | null }>('/guest-blocks')
    if (g.welcome.length) form.welcome = g.welcome
    Object.assign(form.supportContact, g.supportContact); form.policyUrl = g.policyUrl ?? ''
  } catch (err) { error.value = apiErrorOf(err).message }
})
async function save() {
  error.value = ''; saved.value = false
  const sc = Object.fromEntries(Object.entries(form.supportContact).filter(([, v]) => v))
  try { await api('/guest-blocks', { method: 'PUT', body: { welcome: form.welcome, supportContact: sc, policyUrl: form.policyUrl || null } }); saved.value = true } catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <PageHeader :title="t('guest.title')" :subtitle="t('guest.hint')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('guest.title') }]">
      <template #actions><button class="btn primary" @click="save">{{ t('common.save') }}</button></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="saved" class="note teal" role="status">{{ t('common.saved') }}</p>
    <div class="grid">
      <section class="card"><p class="label">{{ t('guest.welcome') }}</p><BlockEditor v-model="form.welcome" /></section>
      <aside class="card">
        <p class="panel-title">{{ t('guest.support') }}</p>
        <label class="label" for="g-name">{{ t('guest.supportName') }}</label><input id="g-name" v-model="form.supportContact.name" class="field" maxlength="120">
        <label class="label top" for="g-phone">{{ t('guest.supportPhone') }}</label><input id="g-phone" v-model="form.supportContact.phone" class="field" maxlength="30">
        <label class="label top" for="g-email">{{ t('guest.supportEmail') }}</label><input id="g-email" v-model="form.supportContact.email" class="field" type="email" maxlength="120">
        <label class="label top" for="g-tg">{{ t('guest.supportTelegram') }}</label><input id="g-tg" v-model="form.supportContact.telegram" class="field" maxlength="60">
        <label class="label top" for="g-policy">{{ t('guest.policyUrl') }}</label><input id="g-policy" v-model="form.policyUrl" class="field" type="url" maxlength="500">
      </aside>
    </div>
  </div>
</template>
<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-4); align-items: start; }
.top { margin-top: var(--space-3); }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
