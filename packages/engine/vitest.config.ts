import { defineConfig } from "vitest/config";
// Tests talk to a fake voice engine and a fake client CRM on 127.0.0.1, which the
// SSRF guards refuse by default. Both switches are for tests only.
export default defineConfig({
  test: { testTimeout: 20000, fileParallelism: false, env: { JENAI_ALLOW_PRIVATE_ENGINE: "true", JENAI_ALLOW_PRIVATE_WEBHOOKS: "true" } },
});
