import type { NextConfig } from "next";

// Questa config vive su Render free: l'obiettivo e spedire meno JS/CSS
// possibile al client, evitare lavoro inutile in build e tenere caching
// aggressivo sugli asset immutabili. Le opzioni seguite sono documentate
// in node_modules/next/dist/docs/01-app/03-api-reference/05-config/.

const nextConfig: NextConfig = {
  // Evita di annunciare lo stack (X-Powered-By).
  poweredByHeader: false,
  // Su Render free la banda conta: compress esplicito garantisce gzip
  // anche quando il proxy upstream non lo applica.
  compress: true,
  // Source map di produzione aumentano solo il tempo di deploy e la
  // dimensione dello slug senza utilita per gli utenti finali.
  productionBrowserSourceMaps: false,
  // Next 16 puo rimuovere automaticamente i console.* in prod (tranne
  // error/warn): zero rumore, meno byte, meno lavoro JIT lato client.
  compiler: {
    removeConsole: {
      exclude: ["error", "warn"],
    },
  },
  experimental: {
    // Tree-shake aggressivo per le librerie con molti named export. @turf
    // e leaflet sono usati in codice sia server sia client: importare solo
    // i submodule effettivamente referenziati taglia parecchio bundle.
    optimizePackageImports: [
      "@turf/turf",
      "leaflet",
      "react-leaflet",
    ],
  },
  async headers() {
    // Nota: Next.js imposta gia automaticamente Cache-Control immutable
    // su /_next/static/*. Non lo sovrascriviamo: eviterebbe hot-reload
    // in dev (lo avverte anche il warning di next build) e non aggiunge
    // nulla in prod.
    return [
      {
        // Immagini/font in /public: cache lungo con revalidation.
        source: "/:file((?:.+)\\.(?:ico|png|jpg|jpeg|webp|avif|svg|woff|woff2|ttf|otf|eot))",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // L'endpoint di scan non deve essere cacheato lungo il percorso
        // (Render edge, proxy utente, service worker eventuali).
        source: "/api/scan/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
