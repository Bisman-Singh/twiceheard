/**
 * How the agent listens, and why nothing here is tuned for speed.
 *
 * Measured on a real call, the gap between a caller finishing and the agent
 * answering was a median of 3.55 s, which is far slower than a phone call should
 * feel. Two attempts to fix it from this file both made the product worse:
 *
 * Pinning `min_silence` and `max_silence` turned off the platform's adaptive,
 * entity-aware end of turn detection, which is the feature that waits for a whole
 * phone number instead of cutting in after the first pause. The measured median got
 * longer, not shorter.
 *
 * `transcription_mode: "min_latency"` is worse than slow. It is documented as the
 * least patient setting, and it drops the barge-in guard to zero, so any "mm-hm" from
 * the caller interrupts a readback in progress. A readback the caller talked over is
 * exactly what this product then refuses to count, so the fast setting would have
 * lowered the grade of correct calls. The platform's own guidance for capturing a
 * value you cannot get wrong is the opposite: be more patient, not less.
 *
 * So the listening settings are the platform's defaults, deliberately, and the
 * latency has to come out of the turn itself rather than out of the caller's pauses.
 */
export const LISTENING = {} as const;

export type Listening = typeof LISTENING;
