<script setup lang="ts">
/**
 * Форма подарунка (docs/21 Г-21.1 `[решение]`): назва, опис, зображення, категорія, вартість у
 * бонусах, залишок (або «без обмеження» — вихідний, знижка, послуга в закладі), точка видачі (або
 * «будь-яка»), ліміт на людину (за замовчуванням без ліміту), «Опубліковано». `/admin/shop/items/new` —
 * новий подарунок. Перевірки — на сервері (zod + довідники тенанта), помилки пояснюють, що робити.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'shop.manage' })

const { t } = useI18n()
const { api } = useApi()
const { upload } = useMediaUpload()
const route = useRoute()
const id = computed(() => String(route.params.id))
const isNew = computed(() => id.value === 'new')

interface ItemRow { id: string, title: string, description: string | null, imageKey: string | null, categoryId: string | null, priceBonuses: number, stock: number | null, locationId: string | null, limitPerUser: number | null, isActive: boolean }
interface Ref { id: string, name: string }

const form = reactive({ title: '', description: '', imageKey: null as string | null, categoryId: '', priceBonuses: 10, stock: 10, stockUnlimited: false, locationId: '', limitPerUser: 1, noLimit: true, isActive: true })
const categories = ref<Ref[]>([])
const locations = ref<Ref[]>([])
const error = ref('')
const busy = ref(false)
const uploading = ref(false)

onMounted(async () => {
  try {
    const [cats, locs, items] = await Promise.all([
      api<Ref[]>('/gift-store/categories'),
      api<Ref[]>('/refs/locations').catch(() => [] as Ref[]),
      isNew.value ? Promise.resolve([] as ItemRow[]) : api<ItemRow[]>('/gift-store/items'),
    ])
    categories.value = cats
    locations.value = locs
    if (!isNew.value) {
      const it = items.find(i => i.id === id.value)
      if (!it) { await navigateTo('/admin/shop'); return }
      Object.assign(form, {
        title: it.title, description: it.description ?? '', imageKey: it.imageKey, categoryId: it.categoryId ?? '', priceBonuses: it.priceBonuses,
        stock: it.stock ?? 0, stockUnlimited: it.stock === null, locationId: it.locationId ?? '',
        limitPerUser: it.limitPerUser ?? 1, noLimit: it.limitPerUser === null, isActive: it.isActive,
      })
    }
  }
  catch (err) { error.value = apiErrorOf(err).message }
})

async function onImage(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  error.value = ''
  // Зображення подарунка — обкладинка картки каталогу: origin `content_cover` (docs/v2/40 §4.1), нового значення не заводимо
  try { form.imageKey = await upload(file, file.name, 'content_cover', { sourceEntity: 'shop_items', sourceId: isNew.value ? undefined : id.value }) }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { uploading.value = false; input.value = '' }
}

async function save() {
  busy.value = true
  error.value = ''
  const body = {
    title: form.title.trim(),
    description: form.description.trim() || null,
    imageKey: form.imageKey,
    categoryId: form.categoryId || null,
    priceBonuses: Number(form.priceBonuses),
    stock: form.stockUnlimited ? null : Number(form.stock),
    locationId: form.locationId || null,
    limitPerUser: form.noLimit ? null : Number(form.limitPerUser),
    isActive: form.isActive,
  }
  try {
    if (isNew.value) await api('/gift-store/items', { method: 'POST', body })
    else await api(`/gift-store/items/${id.value}`, { method: 'PATCH', body })
    await navigateTo('/admin/shop')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function remove() {
  if (!confirm(t('shop.form.deleteConfirm', { title: form.title }))) return
  try {
    await api(`/gift-store/items/${id.value}`, { method: 'DELETE' })
    await navigateTo('/admin/shop')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="isNew ? t('shop.form.newTitle') : t('shop.form.editTitle')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('shop.crumb') }, { label: t('shop.title'), to: '/admin/shop' }]">
      <template #actions>
        <NuxtLink to="/admin/shop" class="btn ghost">{{ t('common.cancel') }}</NuxtLink>
        <button type="submit" form="shop-item" class="btn primary" :disabled="busy || uploading">{{ t('common.save') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <form id="shop-item" class="form" @submit.prevent="save">
      <label class="block">
        <span class="label">{{ t('shop.form.title') }} *</span>
        <input v-model="form.title" class="field" required minlength="2" maxlength="120">
      </label>
      <label class="block">
        <span class="label">{{ t('shop.form.description') }}</span>
        <textarea v-model="form.description" class="field" rows="3" maxlength="2000" />
      </label>

      <div class="block">
        <span class="label">{{ t('shop.form.image') }}</span>
        <div class="image-row">
          <img v-if="form.imageKey" :src="`/api/v1/media/${form.imageKey}?redirect=1&variant=320`" alt="" class="preview">
          <input type="file" class="field" accept="image/jpeg,image/png,image/webp" :aria-label="t('shop.form.image')" :disabled="uploading" @change="onImage">
          <button v-if="form.imageKey" type="button" class="btn ghost small" @click="form.imageKey = null">{{ t('shop.form.removeImage') }}</button>
        </div>
        <span class="help">{{ t('shop.form.imageHint') }}</span>
      </div>

      <div class="grid2">
        <label class="block">
          <span class="label">{{ t('shop.form.category') }}</span>
          <select v-model="form.categoryId" class="field">
            <option value="">{{ t('shop.form.noCategory') }}</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label class="block">
          <span class="label">{{ t('shop.form.price') }} *</span>
          <input v-model.number="form.priceBonuses" class="field" type="number" min="1" max="10000" step="1" required>
        </label>
      </div>

      <div class="grid2">
        <div class="block">
          <span class="label">{{ t('shop.form.stock') }}</span>
          <input v-if="!form.stockUnlimited" v-model.number="form.stock" class="field" type="number" min="0" max="100000" step="1" :aria-label="t('shop.form.stock')">
          <label class="toggle"><input v-model="form.stockUnlimited" type="checkbox"><span>{{ t('shop.form.stockUnlimited') }}</span></label>
        </div>
        <div class="block">
          <span class="label">{{ t('shop.form.limit') }}</span>
          <input v-if="!form.noLimit" v-model.number="form.limitPerUser" class="field" type="number" min="1" max="1000" step="1" :aria-label="t('shop.form.limit')">
          <label class="toggle"><input v-model="form.noLimit" type="checkbox"><span>{{ t('shop.form.noLimit') }}</span></label>
        </div>
      </div>

      <label class="block">
        <span class="label">{{ t('shop.form.location') }}</span>
        <select v-model="form.locationId" class="field">
          <option value="">{{ t('shop.anyPoint') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>

      <label class="toggle">
        <input v-model="form.isActive" type="checkbox">
        <span>{{ t('shop.form.published') }}<span class="hint">{{ t('shop.form.publishedHint') }}</span></span>
      </label>

      <div v-if="!isNew" class="danger-zone">
        <button type="button" class="btn ghost" @click="remove">{{ t('shop.form.delete') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); max-width: 720px; }
.block { display: grid; gap: var(--space-2); }
.grid2 { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.image-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.image-row .field { flex: 1 1 220px; }
.preview { width: 96px; height: 64px; object-fit: cover; border-radius: var(--radius-s); }
.danger-zone { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-4); }
</style>
