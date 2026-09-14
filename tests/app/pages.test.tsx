// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { describe, expect, it } from "vitest";
import RootLayout, { dynamic, metadata, viewport } from "@/app/layout";
import HomePage from "@/app/page";

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
    expect(metadata.title).toMatchObject({ default: "Earshot" });
    expect(viewport.width).toBe("device-width");
  });
});
