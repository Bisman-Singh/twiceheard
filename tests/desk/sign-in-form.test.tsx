// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInForm } from "@/components/desk/sign-in-form";

const signInAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/desk/actions", () => ({ signInAction, signOutAction: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

describe("the desk sign-in form", () => {
  it("sends the typed code and keeps the field labelled and reachable", async () => {
    signInAction.mockResolvedValue("");
    const { container } = render(<SignInForm demoCode={null} />);
    const field = screen.getByLabelText("Clinic code");
    await userEvent.type(field, "ABCD234XYZ");
    await userEvent.click(screen.getByRole("button", { name: "Open the desk" }));
    await waitFor(() => expect(signInAction).toHaveBeenCalled());
    const form = signInAction.mock.calls[0]?.[1] as FormData;
    expect(form.get("code")).toBe("ABCD234XYZ");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the reason a code was refused, where a screen reader will read it", async () => {
    signInAction.mockResolvedValue("That code does not match a clinic.");
    render(<SignInForm demoCode={null} />);
    await userEvent.type(screen.getByLabelText("Clinic code"), "AAAAAAAAAA");
    await userEvent.click(screen.getByRole("button", { name: "Open the desk" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That code does not match a clinic.");
  });

  it("prints a demonstration code beside the field without filling it in", async () => {
    const { container } = render(<SignInForm demoCode="ABCD234XYZ" />);
    expect(screen.getByText(/A clinic code is required/)).toHaveTextContent(
      "For this demonstration, use ABCD234XYZ.",
    );
    // What is typed is still what is checked, so the field starts empty and stays required.
    const field = screen.getByLabelText("Clinic code");
    expect(field).toHaveValue("");
    expect(field).toBeRequired();
    // The field's description stays the help text alone, so a refusal reads as the reason.
    expect(field).toHaveAccessibleDescription("Ten characters, from the clinic's setup sheet.");
    expect(await axe(container)).toHaveNoViolations();
  });
});
