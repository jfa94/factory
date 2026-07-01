import { defineConfig, devices } from "@playwright/test";

/**
 * Seeded by `factory scaffold` (Decision 39) — then PROJECT-OWNED (never
 * auto-overwritten; delete + re-scaffold to pick up a template update).
 *
 * `testDir` MUST match the factory's `e2e.testDir` config (default "e2e") —
 * persistence in that directory IS the criticality signal for the run-level
 * e2e phase: nothing is tagged, so this directory boundary is load-bearing.
 *
 * TODO: replace `webServer.command` below with this repo's real dev/start
 * command, and set `e2e.startCommand` + `e2e.baseURL` via
 * `factory configure --set e2e.startCommand=<cmd> --set e2e.baseURL=<url>`
 * to the SAME values — the run-level e2e phase boots the app itself using
 * the factory config, independent of this file's `webServer` (which only
 * covers a plain local/CI `playwright test` invocation).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retries classify a fail-then-pass-on-retry spec as FLAKY, distinct from a
  // real failure — the factory's e2e phase never reopens a task on a flaky
  // spec (Decision 39), only on one that fails every attempt.
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev", // TODO: replace with this repo's real start command
    url: process.env.BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
