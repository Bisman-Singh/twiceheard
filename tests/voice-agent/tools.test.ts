import { describe, expect, it } from "vitest";
import { TOOL_SPECS, type ToolName, type ToolSpec } from "@/lib/voice-agent/tools";

/**
 * What the platform is told about each tool, read the way the caller
 * experiences it: an execution mode is a decision about dead air, and a
 * parameter description is what makes the platform wait for a whole phone
 * number instead of cutting in after the first pause.
 */

function spec(name: ToolName): ToolSpec {
  const found = TOOL_SPECS.find((tool) => tool.name === name);
  expect(found, name).toBeDefined();
  return found as ToolSpec;
}

const property = (name: ToolName, key: string) =>
  spec(name).parameters.properties[key] as Record<string, unknown>;

describe("execution modes", () => {
  it("leaves every tool interactive, because hold is a silence the caller sits through", () => {
    // The platform's rule is "Default to interactive", with hold for transfers,
    // escalations and work over ten seconds. Each of these is one store read or
    // write, and a seven-field intake made roughly fifteen hold windows.
    const held = TOOL_SPECS.filter((tool) => tool.execution_mode === "hold").map(
      (tool) => tool.name,
    );
    expect(held).toEqual(["save_field"]);
  });

  it("keeps save_field on hold, the one result the caller must hear word for word", () => {
    expect(spec("save_field").execution_mode).toBe("hold");
  });

  it("gives every tool long enough to answer without the agent giving up on it", () => {
    for (const tool of TOOL_SPECS) {
      expect(tool.timeout_seconds, tool.name).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("parameter hints, which are what turn-taking runs on", () => {
  // Two calls split "Bisman Singh" into two turns, one of which never ended, so the
  // hint has to say that a name arrives in parts the way a phone number does.
  it("tells the platform a name arrives in parts, and to prefer a spelling over a guess", () => {
    const saveField = TOOL_SPECS.find((spec) => spec.name === "save_field");
    const hint = String(saveField?.parameters.properties.value?.description);
    expect(hint).toMatch(/pause between them, so wait for all of it/i);
    expect(hint).toMatch(/spelled a name out, use the spelling they gave/i);
  });

  it("tells the platform a phone number is ten digits and to wait for all of them", () => {
    const value = property("save_field", "value");
    expect(String(value.description)).toContain("ten of them in India");
    expect(String(value.description)).toContain("wait for the whole number");
  });

  it("gives examples in the forms a spoken value really arrives in, digit by digit too", () => {
    const examples = property("save_field", "value").examples as string[];
    expect(examples).toContain("98765 43210");
    expect(examples).toContain("9 8 7 6 5 4 3 2 1 0");
    expect(examples).toContain("1990-03-12");
  });

  it("names the shape of every field on both the field and the value", () => {
    for (const key of ["field", "value"]) {
      const description = String(property("save_field", key).description);
      expect(description, key).toContain("date_of_birth: YYYY-MM-DD");
      expect(description, key).toContain("semicolons");
    }
  });

  it("declares the day as a date, so a half-said one does not end the caller's turn", () => {
    const date = property("find_slots", "date");
    expect(date.format).toBe("date");
    expect(date.pattern).toBe("\\d{4}-\\d{2}-\\d{2}");
    expect(date.examples).toEqual(["2026-09-15"]);
  });

  it("offers a way to say the caller has disowned a value already on the chart", () => {
    const replaces = property("save_field", "replaces_earlier_value");
    expect(replaces.type).toBe("boolean");
    expect(String(replaces.description)).toContain("out of date");
    expect(spec("save_field").parameters.required).not.toContain("replaces_earlier_value");
  });

  it("gives every free-form value an example, which beats a longer description", () => {
    for (const name of [
      "check_medication",
      "find_slots",
      "book_appointment",
      "escalate",
    ] as const) {
      for (const [key, hint] of Object.entries(spec(name).parameters.properties)) {
        if (hint.enum !== undefined || hint.type === "boolean") continue;
        expect((hint.examples as string[] | undefined) ?? [], `${name}.${key}`).not.toHaveLength(0);
      }
    }
  });
});

describe("descriptions, which are what makes a tool fire at the right moment", () => {
  it("tells save_field how to reproduce a readback the caller asks to hear again", () => {
    expect(spec("save_field").description).toContain("asks to hear a detail again");
  });

  it("tells find_slots that an empty answer carries a reason to pass on", () => {
    expect(spec("find_slots").description).toContain("it says why");
  });

  it("says that finish_intake and escalate return the sentence that ends the call", () => {
    expect(spec("finish_intake").description).toContain("the sentence that ends the call");
    expect(spec("escalate").description).toContain("the sentence that ends the call");
  });

  it("names the anti-trigger on the tool most likely to be reached for wrongly", () => {
    expect(spec("check_medication").description).toContain("Do not call it to find out what");
  });
});
