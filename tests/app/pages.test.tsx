// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import RootLayout, { dynamic, metadata, viewport } from "@/app/layout";
import HomePage from "@/app/page";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

/** True when `other` comes after `node` in the document. */
function comesAfter(node: Node, other: Node): boolean {
  return Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("home page", () => {
  it("explains a call and the three grades in words, with no accessibility violations", async () => {
    const { container } = render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Clinic intake by phone, with nothing on the chart you cannot check.",
    );
    const steps = within(screen.getByRole("region", { name: "How a call works" })).getAllByRole(
      "listitem",
    );
    expect(steps).toHaveLength(4);
    const grades = within(
      screen.getByRole("region", { name: "What the clinic sees for each field" }),
    );
    for (const label of ["Verified", "Check", "Missing"]) {
      expect(grades.getByRole("heading", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText(/does not give medical advice/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("offers both ways in directly under the standfirst, drawn as a rule and not a fill", () => {
    render(<HomePage />);

    const standfirst = screen.getByText(/A voice agent answers the clinic/);
    const call = screen.getByRole("link", { name: "Call the demo clinic" });
    const chart = screen.getByRole("link", { name: "See a finished chart" });
    expect(call).toHaveAttribute("href", "/call");
    expect(chart).toHaveAttribute("href", "/desk");

    // Under the standfirst and before the first explanation, which is what keeps
    // it in the opening screen rather than below the page's own reading.
    expect(comesAfter(standfirst, call)).toBe(true);
    expect(comesAfter(call, screen.getByRole("heading", { name: "How a call works" }))).toBe(true);

    for (const link of [call, chart]) {
      expect(link.className).toMatch(/(^|\s)border(\s|$)/);
      expect(link.className).not.toMatch(/rounded/);
      expect(link.className).not.toMatch(/(^|\s)bg-/);
    }
  });
});

describe("root layout", () => {
  it("sets the language, a skip link, the main landmark and per-request rendering", () => {
    const tree = RootLayout({ children: <p>child</p> });
    expect(tree.type).toBe("html");
    expect(tree.props.lang).toBe("en-IN");
    const { container } = render(tree.props.children);
    expect(within(container).getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main",
    );
    expect(within(container).getByRole("main")).toHaveTextContent("child");
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.title).toMatchObject({ default: "Twiceheard" });
    expect(viewport.width).toBe("device-width");
  });

  it("carries the nav on every page, after the skip link so the first Tab still skips", () => {
    const { container } = render(RootLayout({ children: <p>child</p> }).props.children);

    const nav = within(container).getByRole("navigation", { name: "Pages" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/", "/", "/call", "/desk"]);
    const focusable = [...container.querySelectorAll("a[href], button")];
    expect(focusable[0]).toHaveTextContent("Skip to content");
    expect(focusable[0]).toHaveAttribute("href", "#main");
    expect(comesAfter(nav, within(container).getByRole("main"))).toBe(true);
  });
});
