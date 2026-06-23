/** @type {import('next').NextConfig} */
const isMobileBuild = process.env.NEXT_OUTPUT === 'export';

const nextConfig = {
  // Only set output:'export' when building the Capacitor native shell.
  // Vercel deployments must NOT set this — it disables SSR and API routes.
  ...(isMobileBuild && {
    output: 'export',
    trailingSlash: true,
  }),

  images: isMobileBuild
    ? { unoptimized: true }
    : { remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }] },
};

export default nextConfig;
