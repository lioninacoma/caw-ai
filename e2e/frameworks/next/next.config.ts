import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  productionBrowserSourceMaps: true,
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:3999/api/:path*" }];
  },
};

export default nextConfig;
