import type { NextConfig } from "next";
import { apiRewrite } from "./lib/api/proxy";

const nextConfig: NextConfig = {
  rewrites() {
    return [apiRewrite(process.env.FORCARE_BACKEND_ORIGIN)];
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
