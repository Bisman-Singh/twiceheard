import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The product driven by the Tab key alone.
 *
 * A clinic's front desk works a keyboard, and a patient using a screen reader
 * never touches a pointer. These tests take the built pages in a real browser
 * and prove the three things a keyboard user needs: a skip link that comes
 * first and works, a focus ring that can be seen, and no page that swallows
 * focus once it has it.
 */

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Long enough to walk any of these pages twice over, short enough to fail fast. */
const TAB_LIMIT = 40;

const BODY = "the document body";

/** Every tab stop the page declares, named the way a failure should name it. */
async function tabStops(page: Page): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const id = element.id ? `#${element.id}` : "";
        const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `<${element.tagName.toLowerCase()}${id}>${text ? ` "${text}"` : ""}`;
      }),
    FOCUSABLE,
  );
}

/** Where focus is now, expressed in the same names as `tabStops`. */
async function focusedStop(page: Page, stops: string[]): Promise<string> {
  const where = await page.evaluate((selector) => {
    const active = document.activeElement;
    if (!active || active === document.body) return { index: -1, tag: "body" };
    const id = active.id ? `#${active.id}` : "";
    return {
      index: Array.from(document.querySelectorAll(selector)).indexOf(active),
      tag: `${active.tagName.toLowerCase()}${id}`,
    };
  }, FOCUSABLE);
  if (where.tag === "body") return BODY;
  return stops[where.index] ?? `<${where.tag}>, which is not one of the page's tab stops`;
}

/** Tab until `target` holds focus, or say how many presses were spent failing. */
async function tabTo(page: Page, target: Locator, what: string): Promise<number> {
  for (let press = 1; press <= TAB_LIMIT; press += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return press;
  }
  throw new Error(`${what} was never focused after ${TAB_LIMIT} Tab presses on ${page.url()}`);
}

/** The two properties a focus ring is normally drawn with. */
async function indicator(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outline: style.outline,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
    };
  });
}

test("the first Tab on the home page reaches the skip link, and using it lands on the main landmark", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
    'the first Tab stop on / should be the "Skip to content" link',
  ).toBeFocused();

  await page.keyboard.press("Enter");
  const landing = await page.evaluate(() => ({
    focused: document.activeElement?.id ?? "",
    hash: location.hash,
  }));
  expect(
    landing.focused === "main" || landing.hash === "#main",
    `the skip link should move focus or the document position to <main id="main">; focus is on "${landing.focused}" and the location hash is "${landing.hash}"`,
  ).toBe(true);
});

test("every interactive element on the home page is reachable by Tab before focus falls to the body", async ({
  page,
}) => {
  await page.goto("/");
  const stops = await tabStops(page);
  expect(stops.length, "/ should declare at least one tab stop").toBeGreaterThan(0);

  const reached = new Set<string>();
  for (let press = 0; press < stops.length + 2; press += 1) {
    if (reached.size === stops.length) break;
    await page.keyboard.press("Tab");
    const stop = await focusedStop(page, stops);
    const missing = stops.filter((name) => !reached.has(name)).join(", ");
    expect(stop, `focus fell to the body on / with these still unreached: ${missing}`).not.toBe(
      BODY,
    );
    reached.add(stop);
  }
  expect([...reached].sort(), "Tab did not reach every interactive element on /").toEqual(
    [...stops].sort(),
  );
});

test("the call button is reachable by Tab alone and gains a focus ring that can be seen", async ({
  page,
}) => {
  await page.goto("/call");
  const button = page.getByRole("button", { name: "Call the clinic" });
  await expect(button).toBeEnabled();

  const before = await indicator(button);
  const presses = await tabTo(page, button, 'the "Call the clinic" button');
  const after = await indicator(button);
  await expect(
    button,
    `the call button should hold focus after ${presses} Tab presses`,
  ).toBeFocused();

  const carrier =
    after.outline !== before.outline
      ? "outline"
      : after.boxShadow !== before.boxShadow
        ? "box-shadow"
        : "none";
  test.info().annotations.push({ type: "focus indicator", description: `carried by ${carrier}` });
  expect(
    carrier,
    `the call button gained no focus ring: outline went "${before.outline}" to "${after.outline}", box-shadow went "${before.boxShadow}" to "${after.boxShadow}"`,
  ).not.toBe("none");
  // A change from one invisible value to another would satisfy the check above
  // while painting nothing, so the focused state has to be paintable too.
  expect(
    `${after.outlineStyle}/${after.boxShadow}`,
    `the focused call button paints nothing: outline-style "${after.outlineStyle}" and box-shadow "${after.boxShadow}"`,
  ).not.toBe("none/none");
});

test("the call button can be activated by keyboard alone, with the clinic line never contacted", async ({
  page,
}) => {
  // The session endpoint is answered by the test, so no API key is used and the
  // voice platform is never reached. This proves the key press starts the call,
  // which is all this test is about.
  await page.route("**/api/voice/session", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable", message: "The clinic line is closed." }),
    }),
  );
  await page.goto("/call");
  const button = page.getByRole("button", { name: "Call the clinic" });
  await tabTo(page, button, 'the "Call the clinic" button');
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("The clinic line is closed."),
    'Enter on the focused "Call the clinic" button should start the call attempt',
  ).toBeVisible();
});

test("a wrong clinic code typed with the keyboard alone is announced and the field keeps its label", async ({
  page,
}) => {
  // Sign-in attempts are throttled per client address, so each run claims its own
  // documentation-range address and the message under test is the wrong-code one
  // rather than the throttle one.
  const address = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
  await page.setExtraHTTPHeaders({ "x-real-ip": address });
  await page.goto("/desk");

  const field = page.getByLabel("Clinic code");
  await tabTo(page, field, "the clinic code field");
  await page.keyboard.type("WRONGCODE9");
  await page.keyboard.press("Enter");

  // Scoped to the form because the framework keeps its own route announcer,
  // an empty role=alert region, on every page.
  await expect(
    page.locator("form").getByRole("alert"),
    "a wrong code should be announced through a role=alert message inside the sign-in form",
  ).toHaveText("That code does not match a clinic.");
  await expect(
    field,
    "the clinic code field should keep its label once the failure is shown",
  ).toHaveAccessibleName("Clinic code");
  // The field keeps its help text and now also carries the reason, so someone who tabs
  // back to it is told why the submission failed rather than only how to fill it in.
  await expect(
    field,
    "the clinic code field should keep its help text and add the reason it was refused",
  ).toHaveAccessibleDescription(
    "Ten characters, from the clinic's setup sheet. That code does not match a clinic.",
  );
  await expect(field, "a refused field should be marked invalid").toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

for (const path of ["/", "/call", "/desk"]) {
  test(`${path} never traps the keyboard: Tab keeps moving and comes back round`, async ({
    page,
  }) => {
    await page.goto(path);
    const stops = await tabStops(page);
    const walk: string[] = [];
    for (let press = 0; press < TAB_LIMIT; press += 1) {
      await page.keyboard.press("Tab");
      walk.push(await focusedStop(page, stops));
    }

    const stuck = walk.find(
      (stop, index) => index >= 2 && walk[index - 1] === stop && walk[index - 2] === stop,
    );
    expect(
      stuck ?? "nothing is stuck",
      `${path} held focus on ${stuck} for three Tab presses`,
    ).toBe("nothing is stuck");
    const first = walk[0] ?? "";
    const cycled = walk.includes(BODY) || walk.indexOf(first) !== walk.lastIndexOf(first);
    expect(
      cycled,
      `${path} neither returned focus to the document body nor cycled within ${TAB_LIMIT} Tab presses; the walk was ${walk.join(" -> ")}`,
    ).toBe(true);
  });
}
