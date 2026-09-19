import { defineConfig } from "vitest/config";
// Tests talk to a fake engine on 127.0.0.1, which the SSRF guard refuses by default.
export default defineConfig({ test: { testTimeout: 20000, fileParallelism: false, env: { JENAI_ALLOW_PRIVATE_ENGINE: "true" } } });
