import { defineConfig } from "mygo-cli";
import { DEV_URL } from "./dev.config.ts";

export default defineConfig({
  name: "Notefloat",
  identifier: "dev.tony.notefloat",
  version: "0.1.2",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: DEV_URL,
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  macos: {
    // The panel is summoned by a global shortcut and lives in the menu bar,
    // so the app stays out of the Dock and the app switcher.
    infoPlist: { LSUIElement: true },
    minimumSystemVersion: "12.0",
  },
});
