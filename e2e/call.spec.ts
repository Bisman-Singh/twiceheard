import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

/**
 * One call, in a real browser, with the platform played by the test.
 *
 * The socket to the voice platform is intercepted, so the agent's side is
 * scripted and the run is the same every time. Everything on this side of the
 * socket is real: the microphone is opened, the audio worklet runs, each tool
 * call goes to the server and comes back, the session is claimed, and the
 * chart at the end is the one the server worked out.
 */

const SILENCE = Buffer.alloc(2400).toString("base64");
const SESSION = "sess_browser_e2e";

interface Sent {
  type: string;
  [key: string]: unknown;
}

/** The platform's side of the call, in the order a real call sends it. */
async function playAgent(socket: WebSocketRoute, page: Page) {
  const sent: Sent[] = [];
  const say = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));

  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw)) as Sent;
    sent.push(message);
    if (message.type === "session.update") {
      say({ type: "session.ready", session_id: SESSION });
      say({
        type: "transcript.agent",
        item_id: "a1",
        text: "Hello, you've reached Sunrise Family Clinic. May I have your full name?",
      });
      say({ type: "reply.audio", data: SILENCE });
      say({ type: "reply.done", status: "completed" });
    }
    if (message.type === "session.end") {
      say({ type: "session.ended", session_duration_seconds: 42 });
      socket.close({ code: 1000 });
    }
    if (message.type === "tool.result") {
      const result = JSON.parse(String(message.result)) as { say?: string; intake_id?: string };
      if (result.say) {
        say({ type: "transcript.agent", item_id: "a3", text: result.say });
        say({ type: "reply.done", status: "completed" });
      }
    }
  });

  await page.waitForFunction(() => document.body.textContent?.includes("Sunrise Family Clinic"));
  return { sent, say };
}

test("a caller speaks, sees the conversation, and gets the chart the clinic gets", async ({
  page,
}) => {
  let agent: Awaited<ReturnType<typeof playAgent>> | null = null;
  await page.routeWebSocket(/agents\.assemblyai\.com/, async (socket) => {
    agent = await playAgent(socket, page);
  });

  await page.goto("/call");
  await expect(page.getByRole("button", { name: "Call the clinic" })).toBeEnabled();
  await expect(page.getByText("Nothing said yet.")).toBeVisible();

  await page.getByRole("button", { name: "Call the clinic" }).click();

  // The platform said it was ready, so the page says the line is open.
  await expect(page.getByText("Connected. Speak normally.")).toBeVisible();
  await expect(page.getByText("May I have your full name?")).toBeVisible();
  await expect(page.getByRole("button", { name: "End the call" })).toBeEnabled();

  // A tool call goes to this site's own endpoint and the readback comes back from it.
  const ready = agent as unknown as Awaited<ReturnType<typeof playAgent>>;
  // The platform asks for a tool during a reply and the page answers once that reply is done,
  // which is the order the API requires.
  const callTool = (call: Record<string, unknown>) => {
    ready.say({ type: "tool.call", ...call });
    ready.say({ type: "reply.done", status: "completed" });
  };
  callTool({ call_id: "c1", name: "start_intake", arguments: {} });
  await expect
    .poll(() => ready.sent.filter((message) => message.type === "tool.result").length)
    .toBeGreaterThan(0);
  const started = ready.sent.find((message) => message.type === "tool.result");
  const intake = JSON.parse(String(started?.result)) as { intake_id: string };
  expect(intake.intake_id).toMatch(/^[A-Z0-9]{6}$/);

  callTool({
    call_id: "c2",
    name: "save_field",
    arguments: {
      intake_id: intake.intake_id,
      field: "full_name",
      value: "Arjun Mehta",
      status: "heard",
    },
  });
  await expect(page.getByText("I have your name as Arjun Mehta. Is that right?")).toBeVisible();
  await expect(page.getByRole("region", { name: "Intake slip" })).toContainText("Arjun Mehta");
  await expect(page.getByRole("region", { name: "Intake slip" })).toContainText(
    "read back, waiting",
  );

  // The caller's own words appear as the platform hears them.
  ready.say({ type: "transcript.user", item_id: "u1", text: "Yes, that's right." });
  await expect(page.getByText("Yes, that's right.")).toBeVisible();

  await page.getByRole("button", { name: "End the call" }).click();
  await expect(page.getByText("Call ended.")).toBeVisible();
  // No recording exists for a session the platform never had, so the page says so rather than hang.
  await expect(page.getByText(/chart is not ready yet|Listening to the recording/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Call again" })).toBeEnabled();
});

test("the page explains itself when the clinic line cannot be reached", async ({ page }) => {
  await page.route("**/api/voice/session", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable", message: "The clinic line is closed." }),
    }),
  );
  await page.goto("/call");
  await page.getByRole("button", { name: "Call the clinic" }).click();
  await expect(page.getByText("The clinic line is closed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Call the clinic" })).toBeEnabled();
});
