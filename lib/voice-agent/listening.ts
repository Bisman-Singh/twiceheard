/**
 * How the agent listens, and why nothing here is tuned for speed.
 *
 * Measured on a real call, the gap between a caller finishing and the agent
 * answering has a median of 3.37 s, which is slower than a phone call should
 * feel. Almost all of it is the platform's own turn: the endpointing wait sits
 * at about 0.9 s, which is its documented default, and the language model's
 * first pass takes about 1.5 s. This product's tool handlers account for 20 ms.
 * Two attempts to fix it from this file both made the product worse:
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
 * latency has to come out of the turn itself rather than out of the caller's
 * pauses. Anything measured here has to be measured with a harness that does not
 * block its own audio pump: synthesising the caller's speech mid-call once added
 * 2.2 s to every gap and made the agent look two seconds slower than it is.
 */
export const LISTENING = {} as const;

export type Listening = typeof LISTENING;
