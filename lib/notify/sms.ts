/**
 * Text messages to callers. The interface is all the tools know about.
 *
 * Which implementation is wired decides what the agent is allowed to promise.
 * `twilioMessenger` really sends. `recordingMessenger` is the test and demo
 * fake. `refusingMessenger` is what runs when no provider is configured, and it
 * reports failure on purpose: the booking still stands, but a caller is never
 * told a text is on its way when nothing is going to arrive.
 */
export interface Messenger {
  send(to: string, body: string): Promise<{ ok: boolean }>;
}

export interface SentMessage {
  to: string;
  body: string;
}

export function recordingMessenger(): Messenger & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    async send(to, body) {
      sent.push({ to, body });
      return { ok: true };
    },
  };
}

/** No provider configured. The booking is real; the text is not, and says so. */
export function refusingMessenger(): Messenger {
  return {
    async send() {
      return { ok: false };
    },
  };
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** The sending number, in E.164. */
  from: string;
}

/** How long a caller can be kept waiting for a carrier before the booking finishes without the text. */
const SEND_TIMEOUT_MS = 5000;

/**
 * Twilio's Messages resource, over plain fetch because one form POST does not
 * justify a dependency. A failure is a returned false, never a throw: the slot
 * is already claimed by the time this runs, and losing the booking because a
 * carrier was slow would be the worse outcome.
 */
export function twilioMessenger(config: TwilioConfig, fetchImpl: typeof fetch = fetch): Messenger {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  return {
    async send(to, body) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Basic ${auth}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: config.from, Body: body }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        // The status is enough to log. The body carries the caller's number and the
        // message, and neither belongs in a log line.
        if (!response.ok) console.error("sms send refused", { status: response.status });
        return { ok: response.ok };
      } catch (error) {
        console.error("sms send failed", { kind: error instanceof Error ? error.name : "unknown" });
        return { ok: false };
      }
    },
  };
}

/** A text message confirming a booking, short enough for one SMS segment where possible. */
export function bookingMessage(clinicName: string, spoken: string): string {
  return `${clinicName}: you are booked for ${spoken}. Please arrive 10 minutes early. Call the clinic if you need to change it.`;
}
