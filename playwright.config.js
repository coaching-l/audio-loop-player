import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// CI uses the Chromium that Playwright installs; locally a system Chromium is reused if present.
const chromium = {
  launchOptions: {
    executablePath:
      process.env.CHROMIUM_PATH ||
      (!process.env.CI && existsSync("/usr/bin/chromium")
        ? "/usr/bin/chromium"
        : undefined),
    // A fake microphone that is allowed without a prompt, for the recording tests.
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
};
export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...chromium } },
    { name: "android-chrome", use: { ...devices["Pixel 7"], ...chromium } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
