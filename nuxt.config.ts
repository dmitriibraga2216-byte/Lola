export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  future: { compatibilityVersion: 4 },
  devtools: { enabled: false },
  modules: ['@nuxtjs/i18n', '@nuxt/eslint'],

  css: ['~/assets/tokens.css'],

  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'uk',
    locales: [
      { code: 'uk', language: 'uk-UA', name: 'Українська', file: 'uk.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
  },

  nitro: {
    errorHandler: '~~/server/error',
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
    },
  },

  typescript: {
    strict: true,
  },
})
