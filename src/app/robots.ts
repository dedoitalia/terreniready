import type { MetadataRoute } from "next";

// robots.txt "vivo" servito da Next 16: la route handler si aggiorna
// automaticamente al redeploy. Esponiamo tutto il sito (il tool e'
// pubblico), disabilitiamo solo gli endpoint API per evitare che i
// crawler tentino scan infiniti contro /api/scan/stream.
export default function robots(): MetadataRoute.Robots {
  const siteUrl = "https://terreniready.onrender.com";

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: "/api/",
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
