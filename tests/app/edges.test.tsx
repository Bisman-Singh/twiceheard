// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import { metadata } from "@/app/layout";
import NotFound from "@/app/not-found";

/** Carries the two things that must never be shown: a message and a digest. */
const thrown = () =>
  Object.assign(new Error("upstream rejected token sk-live-9f3a for host db.internal"), {
    digest: "d1g3st",
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared metadata", () => {
  it("gives a shared link a title and the same description the page carries", () => {
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "Twiceheard",
      title: "Twiceheard",
    });
    expect(metadata.openGraph?.description).toBe(metadata.description);
  });
});

describe("not found page", () => {
  it("names the pages that exist and links to each, with no accessibility violations", async () => {
    const { container } = render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("That page is not here.");
    expect(screen.getByRole("link", { name: "What Twiceheard does" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Call the demo clinic" })).toHaveAttribute(
      "href",
      "/call",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("error page", () => {
  it("says what happened without putting the message, the stack or the digest on screen", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = thrown();
    const { container } = render(<ErrorPage error={error} reset={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This page could not be shown.",
    );
    const shown = container.textContent ?? "";
    for (const leak of ["sk-live-9f3a", "db.internal", "upstream rejected", "d1g3st"]) {
      expect(shown).not.toContain(leak);
    }
    expect(shown).not.toContain(error.stack?.split("\n")[1]?.trim() ?? "at ");
    // The digest goes to the console, which is the only place it is useful.
    expect(logged.mock.calls).toEqual([["page failed to render", { digest: "d1g3st" }]]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("runs the reset action from the button and offers the way home", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reset = vi.fn();
    render(<ErrorPage error={thrown()} reset={reset} />);

    expect(screen.getByRole("link", { name: "Go to the front page" })).toHaveAttribute("href", "/");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
