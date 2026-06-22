/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static HTML export — consumed by Capacitor's native WebView (webDir: 'out').
  // Server Components, Server Actions, and API routes continue to run on Vercel;
  // the native shell loads them via the deployed URL configured in capacitor.config.ts.
  output: 'export',

  // Trailing slashes produce /route/index.html instead of /route.html, which is
  // required for correct file:// resolution inside the iOS and Android WebView.
  trailingSlash: true,

  images: {
    // next/image optimisation requires a running Node server.
    // Static export has no server, so we disable it here and rely on
    // Supabase's own CDN transforms for any image resizing needs.
    unoptimized: true,
  },
};

export default nextConfig;
