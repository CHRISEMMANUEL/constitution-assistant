import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg', 'robots.txt'],
      manifest: {
        name: "Constitution Assistant — The World's Constitutions",
        short_name: 'Constitution',
        description:
          "Browse, listen to, and ask AI about every country's constitution. Cited primary sources, free, works offline.",
        theme_color: '#24772D',
        background_color: '#F7F4ED',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'en',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/assets/sdk-*.js'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/restcountries\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'rest-countries-v1',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'supabase-reads-v1',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
      },
      devOptions: { enabled: false },
    }),
  ],
})
