import { expect, test, type Page } from "@playwright/test";

/**
 * The product on a phone screen.
 *
 * The unit tests run axe over the markup, which cannot see layout. This runs
 * the built pages in a real browser at 360 by 640, the width of the cheapest
 * Android a clinic's patients are likely to be holding, and checks the three
 * things that break first on a small screen: sideways scrolling, content
 * pushed past the right edge, and controls too small to hit with a thumb.
 */

const PHONE = { width: 360, height: 640 };

/** WCAG 2.2 Target Size (Enhanced), 2.5.5. */
const MIN_TARGET = 44;

/** A pixel of slack, so sub-pixel rounding on its own is not a failure. */
const SLACK = 1;

const PAGES = [
  {
    name: "the home page",
    path: "/",
    heading: "Clinic intake by phone, with nothing on the chart you cannot check.",
  },
  { name: "the call page", path: "/call", heading: "Call the demo clinic" },
  { name: "the desk sign-in page", path: "/desk", heading: "Clinic desk" },
  {
    name: "the 404 page",
    path: "/a-page-that-was-never-here",
    heading: "That page is not here.",
  },
];

test.use({ viewport: PHONE });

interface Overflow {
  name: string;
  right: number;
}

interface Target {
  name: string;
  width: number;
  height: number;
}

/** The single element reaching furthest past `edge`, named so a failure can be acted on. */
async function widestOverflow(page: Page, edge: number): Promise<Overflow | null> {
  return page.evaluate((limit) => {
    let worst: { name: string; right: number } | null = null;
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const right = Math.round(box.right * 10) / 10;
      if (right <= limit) continue;
      if (worst && right <= worst.right) continue;
      const tag = element.tagName.toLowerCase();
      const classes = element.getAttribute("class") ?? "";
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      worst = { name: `<${tag} class="${classes}"> "${text}"`, right };
    }
    return worst;
  }, edge);
}

/** Every visible control whose box is under `min` in either direction. */
async function smallTargets(page: Page, min: number): Promise<Target[]> {
  return page.evaluate((size) => {
    const small: { name: string; width: number; height: number }[] = [];
    const controls = document.querySelectorAll("a[href], button, [role='button']");
    for (const element of Array.from(controls)) {
      const style = getComputedStyle(element);
      // A control clipped to nothing is a screen-reader-only affordance such as
      // the skip link. It is never pointed at, so it has no target to measure.
      const clipped =
        style.clipPath.startsWith("inset(50%") || style.clip === "rect(0px, 0px, 0px, 0px)";
      if (clipped || style.visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.width >= size && box.height >= size) continue;
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      small.push({
        name: `<${element.tagName.toLowerCase()}> "${text}"`,
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
      });
    }
    return small;
  }, min);
}

for (const target of PAGES) {
  test(`${target.name} does not scroll sideways on a 360 pixel wide screen`, async ({ page }) => {
    await page.goto(target.path);
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(
      width.scroll,
      `${target.path} scrolls sideways: document scrollWidth is ${width.scroll}px against a ${width.client}px viewport`,
    ).toBeLessThanOrEqual(width.client + SLACK);
  });

  test(`${target.name} keeps every element inside the right edge of a 360 pixel wide screen`, async ({
    page,
  }) => {
    await page.goto(target.path);
    const edge = await page.evaluate(() => document.documentElement.clientWidth);
    const worst = await widestOverflow(page, edge + SLACK);
    const found = worst
      ? `${worst.name} reaches ${worst.right}px, past the ${edge}px viewport`
      : "nothing overflows";
    expect(found, `${target.path} has content past the right edge`).toBe("nothing overflows");
  });

  test(`${target.name} shows its main heading on a 360 pixel wide screen`, async ({ page }) => {
    await page.goto(target.path);
    await expect(
      page.getByRole("heading", { level: 1, name: target.heading }),
      `${target.path} should show the level 1 heading "${target.heading}"`,
    ).toBeVisible();
  });

  test(`${target.name} gives every visible button and link a 44 by 44 pixel touch target`, async ({
    page,
  }) => {
    await page.goto(target.path);
    const small = await smallTargets(page, MIN_TARGET);
    const listed = small
      .map((control) => `${control.name} is ${control.width} by ${control.height}`)
      .join("; ");
    expect(
      listed,
      `${target.path} has controls under ${MIN_TARGET} by ${MIN_TARGET} CSS pixels`,
    ).toBe("");
  });
}

test.describe("with the browser asking for a dark colour scheme", () => {
  test.use({ colorScheme: "dark" });

  test("the call page still shows its heading and its call button in the dark scheme", async ({
    page,
  }) => {
    await page.goto("/call");
    const ground = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    // Without this the two checks below would also pass in the light scheme,
    // and would prove nothing about the dark one.
    const channels = (ground.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const lightness = channels.reduce((sum, part) => sum + part, 0) / (channels.length || 1);
    expect(
      lightness,
      `the dark scheme should paint a dark ground on <html>, got ${ground}`,
    ).toBeLessThan(128);

    await expect(
      page.getByRole("heading", { level: 1, name: "Call the demo clinic" }),
      'the dark call page should show the heading "Call the demo clinic"',
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Call the clinic" }),
      'the dark call page should show an enabled "Call the clinic" button',
    ).toBeEnabled();
  });
});
