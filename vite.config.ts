import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // The app is served from /tasks. Emitting assets under tasks/ makes their file
  // paths match their URLs, so the asset layer serves them without the Worker.
  build: { assetsDir: "tasks/assets" },
  plugins: [
    agents(),
    react(),
    // LOCAL_ONLY=1 skips remote bindings (Workers AI), so the board and login
    // run without a Cloudflare login. The assistant errors in that mode.
    cloudflare({ remoteBindings: process.env.LOCAL_ONLY !== "1" }),
  ],
});
