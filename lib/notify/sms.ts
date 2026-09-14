/**
 * Text messages to callers. The interface is all the tools know about; the
 * Twilio adapter implements it in production, and the recording fake below
 * stands in everywhere else, so a demo never texts a real phone.
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

/** A text message confirming a booking, short enough for one SMS segment where possible. */
export function bookingMessage(clinicName: string, spoken: string): string {
  return `${clinicName}: you are booked for ${spoken}. Please arrive 10 minutes early. Call the clinic if you need to change it.`;
}
