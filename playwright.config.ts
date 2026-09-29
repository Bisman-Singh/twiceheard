import { defineConfig, devices } from "@playwright/test";

/**
 * The browser call, in a real browser.
 *
 * Chromium is given a synthetic microphone so a call can be made with no
 * hardware and no person, and the voice platform's socket is answered by the
 * test itself. Everything between the two, the audio worklet, the tool relay,
 * the server's own endpoints and the chart, is the real thing.
 */
export default defineConfig({
  testDir: "./e2e",
  // The demonstration recording opens a real session and spends credit, so it is run on purpose.
  grepInvert: process.env.DEMO ? undefined : /@live/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start -- --port 3100",
    // The home page, not /api/health. Health answers 503 when a production build
    // has no shared stores, which is exactly right and exactly wrong to wait on:
    // this is asking whether the server is up, not whether it is fully configured.
    url: "http://127.0.0.1:3100/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
