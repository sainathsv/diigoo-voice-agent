import path from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// One .env at the repo root serves the scripts and the web app.
config({ path: path.resolve(process.cwd(), "../../.env"), quiet: true });

const nextConfig: NextConfig = {
  // A self-contained server for the production box: node .next/standalone/apps/web/server.js
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: ["@jenai/reports", "@jenai/db", "@jenai/authz", "@jenai/engine", "@jenai/voice"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  typedRoutes: false,
  // A clinic's visit list is uploaded through a server action and may be up to 5 MB (the
  // action refuses more); the default 1 MB would cut it off before the action could say why.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
