import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Build MUST fail on type errors — silently compiling them hides real defects.
  typescript: {
    ignoreBuildErrors: false,
  },
  // Strict Mode surfaces double-render/desync bugs; fix root causes, don't mask them.
  reactStrictMode: true,
};

export default nextConfig;
