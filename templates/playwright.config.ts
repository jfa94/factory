import { defineConfig, devices } from "@playwright/test";

/**
 * Seeded by `factory scaffold` (Decision 39) — then PROJECT-OWNED (never
 * auto-overwritten; delete + re-scaffold to pick up a template update).
 *
 * `testDir` MUST match the factory's `e2e.testDir` config (default "e2e") —
 * persistence in that directory IS the criticality signal for the run-level
 * e2e phase: nothing is tagged, so this directory boundary is load-bearing.
 *
 * TODO: replace the `webServer.command` fallback below with this repo's real
 * dev/start command, and set `e2e.startCommand` + `e2e.baseURL` via
 * `factory configure --set e2e.startCommand=<cmd> --set e2e.baseURL=<url>`
 * to the SAME values — the run-level e2e phase passes `FACTORY_E2E_*` env
 * vars into every Playwright invocation, and `webServer` below reads them,
 * so both the factory's mechanical runs AND a plain local/CI
 * `playwright test` boot the app the same way.
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
    command: process.env.FACTORY_E2E_START_COMMAND ?? "npm run dev", // TODO: replace fallback
    url: process.env.BASE_URL ?? "http://localhost:3000",
    // FACTORY_E2E=1 marks a factory-driven run (fail-first proof, mechanical
    // suite) — always boot fresh there; a plain local/CI run may reuse.
    reuseExistingServer: process.env.FACTORY_E2E ? false : !process.env.CI,
    timeout: Number(process.env.FACTORY_E2E_READY_TIMEOUT_MS) || 30_000,
  },
});
