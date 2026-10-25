import { defineConfig } from "vite";
import { DEV_PORT } from "./dev.config.ts";

export default defineConfig({
  server: {
    // The app loads this address during `mygo dev` (devUrl in mygo.config.ts,
    // from the same constant).
    port: DEV_PORT,
    strictPort: true,
    // The development app and the packaged builds are not the page's.
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
});
