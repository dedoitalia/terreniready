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

export const metadata: Metadata = {
  title: "TerreniReady",
  description:
    "SaaS territoriale per la ricerca di particelle e terreni prossimi a fonti emissive.",
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
