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
 * Build the callers first:
 *   node scripts/demo-audio.mjs demo/caller-clean.wav --voice <voice.mp3> --variant clean
 *   node scripts/demo-audio.mjs demo/caller-unanswered.wav --voice <voice.mp3> --variant unanswered
 * Then, one recording per caller:
 *   DEMO_CALLER=demo/caller-clean.wav npm run demo:record
 *   DEMO_CALLER=demo/caller-unanswered.wav npm run demo:record
 */

/** Which caller drives the recording; `scripts/demo-audio.mjs --variant` builds them. */
const CALLER = resolve(process.env.DEMO_CALLER ?? "demo/caller-clean.wav");

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
    `build the caller audio first: node scripts/demo-audio.mjs ${CALLER}`,
  ).toBe(true);

  await page.goto("/call");
  await page.getByRole("button", { name: "Call the clinic" }).click();
  await expect(page.getByText("Connected. Speak normally.")).toBeVisible({ timeout: 30_000 });

  // What is worth watching is the conversation and the slip, and the lines a caller is
  // offered before the call push both below a 900 pixel fold. Anyone on this page scrolls
  // here once the call connects, so the recording does the same and holds still after.
  await page
    .getByRole("heading", { name: "Sunrise Family Clinic, intake line" })
    .evaluate((heading) => heading.scrollIntoView({ block: "start" }));

  // The caller's audio is a fixed track, so the call takes as long as the track.
  const slip = page.getByRole("region", { name: "Intake slip" });
  await expect(slip).toContainText("Arjun Mehta", { timeout: 90_000 });
  // The captured values, not the field names. The slip now rules every field out before
  // the call starts, so waiting on a label would pass on page load and prove nothing.
  await expect(slip).toContainText("12 March 1990", { timeout: 120_000 });
  await expect(slip).toContainText(/Allergies\s*none/i, { timeout: 180_000 });
  // The call is not finished until a time has been offered and taken: a chart with an
  // appointment on it is what a clinic actually receives, and the booking is the part
  // the caller came for.
  await expect(slip).toContainText(/booked for/i, { timeout: 180_000 });

  await page.waitForTimeout(8000);
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
