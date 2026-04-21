import type { MetadataRoute } from "next";

// TerreniReady ha una pagina pubblica sola (la dashboard stessa). Il
// sitemap sembra sottodimensionato perche' lo e': lo scopo qui e' dare
// ai crawler un lastmod stabile e la homepage con priorita 1. Quando
// aggiungeremo pagine /about /docs /pricing le elenchiamo qui.
export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = "https://terreniready.onrender.com";
  const lastModified = new Date();

  return [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
