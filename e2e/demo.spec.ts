import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The demonstration recording: one whole call, in a real browser, against the
 * live platform, with the caller played from a file.
 *
 * This is not part of the test gate. It opens a real session and spends credit,
 * and it takes about four minutes, so it is kept behind a tag and run on
 * purpose. What it produces is a video of the product doing the thing it
 * claims: a call, the conversation appearing, the slip filling in, and the
 * graded chart at the end.
 *
 * Build the caller first:  node scripts/demo-audio.mjs demo/caller.wav
 * Then:                    npm run demo:record
 */

const CALLER = resolve("demo/caller.wav");

test.use({
  video: { mode: "on", size: { width: 1280, height: 900 } },
  viewport: { width: 1280, height: 900 },
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${CALLER}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

test("@live a whole call, recorded, ending in the chart the clinic receives", async ({ page }) => {
  // The caller's track is over three minutes, and the chart follows the recording.
  test.setTimeout(9 * 60_000);
  expect(
    existsSync(CALLER),
    "build the caller audio first: node scripts/demo-audio.mjs demo/caller.wav",
  ).toBe(true);

  await page.goto("/call");
  await page.getByRole("button", { name: "Call the clinic" }).click();
  await expect(page.getByText("Connected. Speak normally.")).toBeVisible({ timeout: 30_000 });

  // The caller's audio is a fixed track, so the call takes as long as the track.
  const slip = page.getByRole("region", { name: "Intake slip" });
  await expect(slip).toContainText("Arjun Mehta", { timeout: 90_000 });
  await expect(slip).toContainText("Date of birth", { timeout: 120_000 });
  await expect(slip).toContainText("Allergies", { timeout: 180_000 });

  await page.waitForTimeout(20_000);
  await page.getByRole("button", { name: "End the call" }).click();
  await expect(page.getByText("Call ended.")).toBeVisible();

  // The recording is heard again before the chart can be graded, which takes a moment.
  const chart = page.getByRole("region", { name: "Your chart" });
  await expect(chart).toBeVisible({ timeout: 180_000 });
  await expect(chart).toContainText("verified");

  // Hold on the chart, then on the line that did not come out green, because that
  // line is the whole point and it sits below the fold.
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(5000);
  await page.getByText("Current medications").scrollIntoViewIfNeeded();
  await page.waitForTimeout(14_000);

  const counts = await chart.textContent();
  console.warn("chart:", counts?.slice(0, 400));
});
