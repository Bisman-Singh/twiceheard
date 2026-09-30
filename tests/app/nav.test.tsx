// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SiteNav from "@/components/site/nav";
import { DESTINATIONS } from "@/components/site/destinations";

/**
 * The nav is the only way into the product from the front page, so these tests
 * hold three things: every page is listed, the page being read is marked in a
 * way both a reader and a screen reader can tell, and the middle dots between
 * the links stay out of the names.
 */

const here = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({ usePathname: () => here.pathname }));

beforeEach(() => {
  here.pathname = "/";
});

/** The nav's links, in the order they are read. */
function links() {
  return within(screen.getByRole("navigation", { name: "Pages" })).getAllByRole("link");
}

/** The name of every link the nav marks as the page being read. */
function marked() {
  return links()
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);
}

describe("site nav", () => {
  it("lists the wordmark and every page as a text link, with no accessibility violations", async () => {
    const { container } = render(<SiteNav />);

    expect(links().map((link) => link.textContent)).toEqual([
      "Twiceheard",
      "What it does",
      "Call the clinic",
      "Clinic desk",
    ]);
    expect(links().map((link) => link.getAttribute("href"))).toEqual(["/", "/", "/call", "/desk"]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("separates the links with middle dots that are not part of any link's name", () => {
    render(<SiteNav />);

    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(nav.textContent).toContain("·");
    for (const link of links()) {
      expect(link.textContent).not.toContain("·");
    }
    for (const dot of nav.querySelectorAll("span")) {
      expect(dot).toHaveAttribute("aria-hidden", "true");
    }
  });

  it.each([
    ["/", "What it does"],
    ["/call", "Call the clinic"],
    ["/desk", "Clinic desk"],
    ["/desk/calls/9f3a", "Clinic desk"],
  ])("marks the page being read on %s, and only that one", (pathname, label) => {
    here.pathname = pathname;
    render(<SiteNav />);

    expect(marked()).toEqual([label]);
    // Marked in ink as well as in the accessible name, so it does not rely on
    // a screen reader: the current link is underlined, the others are not.
    for (const link of links()) {
      const isCurrentLink = link.getAttribute("aria-current") === "page";
      expect(link.classList.contains("underline")).toBe(isCurrentLink);
    }
  });

  it("marks nothing when the address is not one of the pages", () => {
    here.pathname = "/a-page-that-was-never-here";
    render(<SiteNav />);

    expect(marked()).toEqual([]);
    expect(links()).toHaveLength(DESTINATIONS.length + 1);
  });
});
