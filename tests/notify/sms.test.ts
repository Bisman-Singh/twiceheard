import { describe, expect, it, vi } from "vitest";
import {
  bookingMessage,
  recordingMessenger,
  refusingMessenger,
  twilioMessenger,
} from "@/lib/notify/sms";

const CONFIG = { accountSid: "AC1", authToken: "token", from: "+14155550123" };

describe("refusingMessenger", () => {
  it("reports failure, because a booking must not promise a text nothing will send", async () => {
    expect(await refusingMessenger().send("+919812345678", "anything")).toEqual({ ok: false });
  });
});

describe("recordingMessenger", () => {
  it("keeps what it was asked to send so a test can read it back", async () => {
    const messenger = recordingMessenger();
    expect(await messenger.send("+919812345678", "hello")).toEqual({ ok: true });
    expect(messenger.sent).toEqual([{ to: "+919812345678", body: "hello" }]);
  });
});

describe("twilioMessenger", () => {
  it("posts the message as a form to the account's own resource", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const sent = await twilioMessenger(CONFIG, fetchImpl as unknown as typeof fetch).send(
      "+919812345678",
      "You are booked.",
    );
    expect(sent).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("AC1:token").toString("base64")}`);
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      To: "+919812345678",
      From: "+14155550123",
      Body: "You are booked.",
    });
  });

  it("reports failure on a refusal, and logs the status without the number or the message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const sent = await twilioMessenger(CONFIG, fetchImpl as unknown as typeof fetch).send(
      "+919812345678",
      "You are booked.",
    );
    expect(sent).toEqual({ ok: false });
    expect(errors).toHaveBeenCalledWith("sms send refused", { status: 400 });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("9812345678");
    errors.mockRestore();
  });

  it("reports failure when the carrier cannot be reached, and never throws into the booking", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const sent = await twilioMessenger(CONFIG, fetchImpl as unknown as typeof fetch).send(
      "+919812345678",
      "You are booked.",
    );
    expect(sent).toEqual({ ok: false });
    expect(errors).toHaveBeenCalledWith("sms send failed", { kind: "TypeError" });
    errors.mockRestore();
  });

  it("reports failure when something that is not an Error is thrown", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw "carrier gone";
    });
    expect(
      await twilioMessenger(CONFIG, fetchImpl as unknown as typeof fetch).send("+91981", "hi"),
    ).toEqual({ ok: false });
    expect(errors).toHaveBeenCalledWith("sms send failed", { kind: "unknown" });
    errors.mockRestore();
  });
});

describe("bookingMessage", () => {
  it("names the clinic and the time in one sentence a caller can act on", () => {
    expect(
      bookingMessage("Sunrise Family Clinic", "Wednesday 30 September at 9:40 in the morning"),
    ).toBe(
      "Sunrise Family Clinic: you are booked for Wednesday 30 September at 9:40 in the morning. Please arrive 10 minutes early. Call the clinic if you need to change it.",
    );
  });
});
