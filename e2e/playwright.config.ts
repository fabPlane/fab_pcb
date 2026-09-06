import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Smoke tests against apps/web running on its mock services (no bridge, no KiCad).
 *
 *   E2E_SERVER=dev      (default) `vite` dev server from apps/web
 *   E2E_SERVER=preview  `vite build` then `vite preview` of the built dist (what CI runs)
 *   E2E_BASE_URL=...    skip webServer and test an already running instance
 */
const PORT = Number(process.env.E2E_PORT ?? 5173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const APP_DIR = resolve(import.meta.dirname, "..", "apps", "web");
const mode = process.env.E2E_SERVER ?? (process.env.CI ? "preview" : "dev");
const serverCommand =
  mode === "preview"
    ? `bunx vite build && bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`
    : `bunx vite --host 127.0.0.1 --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./output/results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "output/report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "output/report", open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    colorScheme: "light",
    viewport: { width: 1400, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: serverCommand,
        cwd: APP_DIR,
        // Pin the app to its in-memory mock services whatever apps/web's default is (main.tsx
        // also honours ?mock=1 / VITE_BRIDGE_URL, neither of which the smoke tests want).
        env: { ...process.env, VITE_SERVICES: "mock" },
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
