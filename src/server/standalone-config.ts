import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * In the Docker image the app is Next's standalone output: there is no
 * next.config.ts, and loading one would need the compiler, which isn't
 * shipped. Next's own standalone server hands it the config saved at build
 * time through this variable; the Methyl server does the same. Imported
 * first by main.ts, before Next loads. Elsewhere (a checkout, where
 * next.config.ts exists) Next reads its config as usual.
 */
const appDir = process.env.METHYL_APP_DIR ?? join(__dirname, "..");
const saved = join(appDir, ".next", "required-server-files.json");
const hasConfigFile = ["next.config.ts", "next.config.js", "next.config.mjs"].some((f) => existsSync(join(appDir, f)));
if (!process.env.__NEXT_PRIVATE_STANDALONE_CONFIG && !hasConfigFile && existsSync(saved)) {
  const { config } = JSON.parse(readFileSync(saved, "utf8")) as { config: unknown };
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
}
