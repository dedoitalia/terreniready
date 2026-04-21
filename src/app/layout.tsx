import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Newsreader, Space_Grotesk } from "next/font/google";

import "./globals.css";

// `display: swap` evita il FOIT (flash of invisible text) e consente a
// Lighthouse di misurare LCP senza attendere il font. `preload` selettivo
// preferisce il solo Space Grotesk perche' e` la family usata sul body.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  // 400+500 coprono tutti gli usi mono (caption, kpi). 500 gia copre i
  // numeri semibold, evitiamo il download di weight extra.
  weight: ["400", "500"],
  display: "swap",
  preload: false,
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  // Il display title usa solo 600; 400 tiene il fallback per paragrafi.
  // Portiamo da 4 weight a 2 pesi per halved font payload.
  weight: ["400", "600"],
  display: "swap",
  preload: false,
});

// Metadata completi per SEO + social: title e description vanno in
// cima ai risultati, openGraph/twitter alimentano la card quando il
// link viene condiviso. metadataBase permette a Next di risolvere le
// URL relative di og:image a path assoluti. robots segue robots.ts.
export const metadata: Metadata = {
  metadataBase: new URL("https://terreniready.onrender.com"),
  title: {
    default: "TerreniReady — Mappa dei terreni agricoli in prossimità di fonti emissive",
    template: "%s · TerreniReady",
  },
  description:
    "Strumento open source per individuare particelle catastali e terreni agricoli entro 350 metri da fonti emissive autorizzate (impianti AIA, distributori, officine, centrali, discariche) nelle dieci province toscane. Dati ufficiali ARPAT, MIMIT, OpenStreetMap, Agenzia delle Entrate.",
  keywords: [
    "terreni agricoli Toscana",
    "particelle catastali",
    "fonti emissive",
    "AIA Toscana",
    "AUA Toscana",
    "Autorizzazione Integrata Ambientale",
    "prossimita ambientale",
    "ARPAT",
    "catasto Agenzia Entrate",
    "GIS open data",
  ],
  authors: [{ name: "Diego Santini" }],
  category: "environment",
  openGraph: {
    type: "website",
    locale: "it_IT",
    url: "https://terreniready.onrender.com",
    siteName: "TerreniReady",
    title: "TerreniReady — Terreni agricoli e fonti emissive in Toscana",
    description:
      "Scansione open di particelle catastali toscane entro 350 m da impianti AIA, distributori, officine, centrali e discariche. Dati ufficiali, uso gratuito.",
  },
  twitter: {
    card: "summary_large_image",
    title: "TerreniReady — Terreni agricoli in prossimità di fonti emissive",
    description:
      "Mappa open di particelle catastali toscane vicine a impianti autorizzati, con dati ARPAT, MIMIT, OSM e catasto.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
  alternates: {
    canonical: "/",
  },
};

export const viewport: Viewport = {
  themeColor: "#18231b",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="it"
      className={`${spaceGrotesk.variable} ${ibmPlexMono.variable} ${newsreader.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
