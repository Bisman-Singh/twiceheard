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
 * So end of turn is left to the platform, and the latency has to come out of the
 * turn itself rather than out of the caller's pauses. Anything measured here has
 * to be measured with a harness that does not block its own audio pump:
 * synthesising the caller's speech mid-call once added 2.2 s to every gap and
 * made the agent look two seconds slower than it is.
 *
 * `transcription_mode` is the one setting this file does choose, and it chooses
 * the slowest of the three. A real caller on the phone line gave his name and it
 * came back as a different name, at confidence 1.0, twice in a row: the wrong
 * word, held with certainty, is the failure this whole product exists to catch.
 * `max_accuracy` is documented for exactly that audio, and the cost is transcript
 * latency on a turn the agent already spends a second and a half thinking about.
 * This is the same reasoning that rejected `min_latency` above, followed the
 * other way: for a value you cannot get wrong, be more patient, not less.
 */
export const LISTENING = { transcription_mode: "max_accuracy" } as const;

export type Listening = typeof LISTENING;
