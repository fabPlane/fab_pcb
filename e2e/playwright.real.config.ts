import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Real-server suite (`e2e/real/`): apps/web against the bridge and a `kicad-cli api-server`.
 * Skipped entirely unless `KICAD_CLI` is set (see e2e/real/fixtures.ts).
 *
 *   KICAD_CLI=/path/to/kicad-cli bun run --filter @fp-pcb/e2e test:real
 *
 * The bridge is started by the global setup when nothing answers on BRIDGE_URL
 * (default http://127.0.0.1:4020); the app is served by the usual webServer (vite dev) with
 * VITE_BRIDGE_URL pointing at the bridge. Set E2E_BASE_URL to reuse a running app. A server
 * already listening on the port is NOT reused unless E2E_REUSE=1: a stale dev server in mock
 * mode would otherwise be tested silently (`--strictPort` makes the clash fail loudly instead).
 */
const PORT = Number(process.env.E2E_PORT ?? 5174);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:4020";
const APP_DIR = resolve(import.meta.dirname, "..", "apps", "web");

export default defineConfig({
  testDir: "./real",
  outputDir: "./output/real-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "output/real-report", open: "never" }]],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalSetup: resolve(import.meta.dirname, "real", "global-setup.ts"),
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    colorScheme: "dark",
    viewport: { width: 1400, height: 900 },
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  projects: [{ name: "chromium-real", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bunx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
        cwd: APP_DIR,
        url: BASE_URL,
        reuseExistingServer: !!process.env.E2E_REUSE,
        timeout: 120_000,
        env: { VITE_BRIDGE_URL: BRIDGE_URL },
        stdout: "ignore",
        stderr: "pipe",
      },
});
