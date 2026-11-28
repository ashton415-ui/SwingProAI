/** @type {import('next').NextConfig} */
const nextConfig = {
  // AG-WEB-READY-10-P4: the protected browser path (lib/protected-web-requests.ts) is a build-time decision. Stated here,
  // Next.js inlines the value into the browser and the server bundles alike: "1" only when the build is given exactly
  // "1", otherwise "0". So one build gives one answer, and a build without the opt-in cannot be switched on at runtime.
  env: {
    NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS:
      process.env.NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS === "1" ? "1" : "0",
  },
};

export default nextConfig;
