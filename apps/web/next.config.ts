import path from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// One .env at the repo root serves the scripts and the web app.
config({ path: path.resolve(process.cwd(), "../../.env"), quiet: true });

const nextConfig: NextConfig = {
  transpilePackages: ["@jenai/db", "@jenai/authz", "@jenai/engine", "@jenai/voice"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  typedRoutes: false,
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
