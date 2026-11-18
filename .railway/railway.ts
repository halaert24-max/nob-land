import { defineConfig } from "@railway/config";

export default defineConfig({
  build: {
    builder: "NIXPACKS"
  },
  deploy: {
    startCommand: "node server.js",
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 10
  }
});
