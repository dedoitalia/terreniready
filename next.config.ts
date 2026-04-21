import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Evita di annunciare lo stack (X-Powered-By).
  poweredByHeader: false,
  // Su Render free la banda conta, attivo compress esplicitamente.
  compress: true,
};

export default nextConfig;
