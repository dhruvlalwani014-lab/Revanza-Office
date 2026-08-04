/** @type {import('next').NextConfig} */

/**
 * Kept as small as possible on purpose.
 *
 * The experimental block that used to live here (serverComponentsExternalPackages,
 * outputFileTracingIncludes) is gone. It is no longer needed: the Postgres driver
 * is imported lazily inside a try/catch, and there is a dependency-free HTTP
 * fallback if it cannot be loaded. Every option in a config file is something
 * that can go wrong on a platform you cannot inspect, so what remains is only
 * what earns its place.
 */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' }
        ]
      }
    ];
  }
};

export default nextConfig;
