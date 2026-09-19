<script setup lang="ts">
const { t } = useI18n()
const { me, logout, hasScope } = useAuth()
const { api } = useApi()
const tgLink = ref<{ url: string | null, token: string } | null>(null)

async function linkTelegram() {
  tgLink.value = await api('/telegram/link', { method: 'POST' })
}
</script>

<template>
  <main class="landing">
    <h1>{{ t('app.name') }}</h1>
    <p>{{ t('app.tagline') }}</p>
    <template v-if="me">
      <p class="who">{{ t('home.signedInAs', { name: me.user.fullName }) }}</p>
      <p class="who muted">{{ t('home.space', { name: me.tenant.name }) }}</p>
      <NuxtLink to="/learn" class="admin-link">{{ t('home.learnLink') }}</NuxtLink>
      <div class="links-row">
        <NuxtLink to="/learn/certificates" class="small-link">{{ t('learner.certificates') }}</NuxtLink>
        <NuxtLink to="/learn/surveys" class="small-link">{{ t('survey.title') }}</NuxtLink>
        <NuxtLink to="/learn/notifications" class="small-link">{{ t('notif.title') }}</NuxtLink>
      </div>
      <button class="admin-link ghost tg" @click="linkTelegram">{{ t('home.linkTelegram') }}</button>
      <p v-if="tgLink" class="tg-hint">
        <a v-if="tgLink.url" :href="tgLink.url" target="_blank" rel="noopener">{{ t('home.openTelegram') }}</a>
        <span v-else>{{ t('home.tgToken', { token: tgLink.token }) }}</span>
      </p>
      <NuxtLink v-if="hasScope('people.view') || hasScope('course.view')" :to="hasScope('course.view') ? '/admin/courses' : '/admin/people'" class="admin-link ghost">
        {{ t('home.adminLink') }}
      </NuxtLink>
      <button class="logout" @click="logout">{{ t('home.logout') }}</button>
    </template>
  </main>
</template>

<style scoped>
.landing {
  min-height: 100dvh;
  display: grid;
  place-content: center;
  text-align: center;
  gap: var(--space-2);
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: var(--font-family);
}

h1 {
  font-weight: 900;
  font-size: var(--font-size-display);
  margin: 0;
}

p {
  margin: 0;
  color: var(--color-ink-muted);
}

.who {
  color: var(--color-ink);
}

.muted {
  color: var(--color-ink-faint);
}

.admin-link {
  margin-top: var(--space-3);
  font-weight: 800;
  color: var(--color-ink);
  background: var(--color-sun);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-5);
  text-decoration: none;
  justify-self: center;
}

.links-row {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
}

.small-link {
  color: var(--color-teal-ink);
  font-weight: 700;
  font-size: var(--font-size-body-s);
}

.tg {
  font: inherit;
  cursor: pointer;
}

.tg-hint {
  font-size: var(--font-size-body-s);
  color: var(--color-teal-ink);
  word-break: break-all;
  max-width: 320px;
}

.tg-hint a {
  color: inherit;
  font-weight: 700;
}

.admin-link.ghost {
  background: transparent;
  border: 1px solid var(--color-bg-line);
  margin-top: var(--space-2);
}

.logout {
  margin-top: var(--space-4);
  justify-self: center;
  font: inherit;
  font-weight: 800;
  border: 1px solid var(--color-bg-line);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
}
</style>
