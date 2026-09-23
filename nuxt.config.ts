export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  future: { compatibilityVersion: 4 },
  devtools: { enabled: false },
  modules: ['@nuxtjs/i18n', '@nuxt/eslint'],

  css: ['~/assets/tokens.css', '~/assets/ui.css'],

  app: {
    head: {
      htmlAttrs: { lang: 'uk' },
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        // Бренд-бук: Nunito, заголовки 900
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap' },
        { rel: 'manifest', href: '/manifest.webmanifest' }, // PWA (докс/33 D-051)
      ],
    },
  },

  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'uk',
    locales: [
      { code: 'uk', language: 'uk-UA', name: 'Українська', file: 'uk.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
      { code: 'ru', language: 'ru-RU', name: 'Русский', file: 'ru.json' },
    ],
  },

  nitro: {
    errorHandler: '~~/server/error',
    experimental: { asyncContext: true }, // useEvent() в сервисах → request_context без протаскивания event (CLAUDE.md п. 14)
  },

  runtimeConfig: {
    databaseUrl: '',        // NUXT_DATABASE_URL ← .env DATABASE_URL
    sessionSecret: '',
    otpPepper: '',
    s3: {
      endpoint: '',
      region: 'us-east-1',
      bucket: 'lola-media',
      accessKey: '',
      secretKey: '',
    },
    public: {
      defaultTenant: 'kappi', // NUXT_PUBLIC_DEFAULT_TENANT — простір для входу через Google без ?tenant=
      supportContact: '', // NUXT_PUBLIC_SUPPORT_CONTACT — e-mail поддержки в подвале входа (до настроек тенанта, docs/24 §3.1)
      vapidPublicKey: '', // NUXT_PUBLIC_VAPID_PUBLIC_KEY — публічний VAPID-ключ для PushManager.subscribe() (докс/33 D-051)
    },
  },

  typescript: {
    strict: true,
  },
})
