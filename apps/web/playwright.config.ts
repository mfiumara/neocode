import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${process.env.NEOCODE_E2E_WEB_PORT || 14317}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
