<script setup lang="ts">
const { t } = useI18n()
const { me, hasScope, logout } = useAuth()

const nav = computed(() => [
  { to: '/admin/courses', label: t('admin.nav.courses'), show: hasScope('course.view') },
  { to: '/admin/quizzes', label: t('admin.nav.quizzes'), show: hasScope('course.view') },
  { to: '/admin/workshops', label: t('admin.nav.workshops'), show: hasScope('course.view') },
  { to: '/admin/review', label: t('admin.nav.review'), show: hasScope('review.queue') },
  { to: '/admin/review-workshops', label: t('admin.nav.reviewWorkshops'), show: hasScope('review.queue') },
  { to: '/admin/knowledge', label: t('admin.nav.knowledge'), show: hasScope('knowledge.manage') },
  { to: '/admin/news', label: t('admin.nav.news'), show: hasScope('knowledge.manage') },
  { to: '/admin/surveys', label: t('admin.nav.surveys'), show: hasScope('survey.manage') },
  { to: '/admin/assignments', label: t('admin.nav.assignments'), show: hasScope('assignment.create') },
  { to: '/admin/profiles', label: t('admin.nav.profiles'), show: hasScope('assignment.create') },
  { to: '/admin/reports', label: t('admin.nav.reports'), show: hasScope('report.team') },
  { to: '/admin/people', label: t('admin.nav.people'), show: hasScope('people.view') },
  { to: '/admin/import', label: t('admin.nav.import'), show: hasScope('people.import') },
  { to: '/admin/refs', label: t('admin.nav.refs'), show: hasScope('people.view') },
  { to: '/admin/journals', label: t('admin.nav.journals'), show: hasScope('audit.view') },
].filter(i => i.show))
</script>

<template>
  <div class="admin">
    <aside class="side">
      <NuxtLink to="/" class="brand">{{ t('app.name') }}</NuxtLink>
      <nav>
        <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" class="nav-item">
          {{ item.label }}
        </NuxtLink>
      </nav>
      <div class="side-footer">
        <span class="who">{{ me?.user.fullName }}</span>
        <button class="ghost" @click="logout">{{ t('home.logout') }}</button>
      </div>
    </aside>
    <main class="content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.admin {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 220px 1fr;
  background: var(--color-bg);
  font-family: var(--font-family);
  color: var(--color-ink);
}

.side {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-4);
  border-right: 1px solid var(--color-bg-line);
}

.brand {
  font-weight: 900;
  font-size: var(--font-size-title-l);
  color: var(--color-ink);
  text-decoration: none;
}

nav {
  display: grid;
  gap: var(--space-1);
}

.nav-item {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-s);
  color: var(--color-ink-muted);
  text-decoration: none;
  font-weight: 700;
}

.nav-item.router-link-active {
  background: var(--color-bg-soft);
  color: var(--color-ink);
}

.side-footer {
  margin-top: auto;
  display: grid;
  gap: var(--space-2);
}

.who {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.ghost {
  font: inherit;
  font-weight: 700;
  background: none;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
  color: var(--color-ink);
  justify-self: start;
}

.content {
  padding: var(--space-6);
  min-width: 0;
}

@media (max-width: 720px) {
  .admin {
    grid-template-columns: 1fr;
  }

  .side {
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid var(--color-bg-line);
    overflow-x: auto;
  }

  .side-footer {
    margin-top: 0;
    margin-left: auto;
  }

  nav {
    display: flex;
    gap: var(--space-2);
  }

  .content {
    padding: var(--space-4);
  }
}
</style>
