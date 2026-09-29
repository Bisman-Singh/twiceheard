/**
 * How the agent decides the caller has stopped talking.
 *
 * Only one setting, deliberately. The platform's end of turn detection is
 * semantic and adapts to each speaker's pace, and its own guidance is to leave
 * it alone. Pinning fixed silence thresholds here replaced that with a worse
 * rule: on a measured call it made the median gap between a caller finishing
 * and the agent answering longer, not shorter. The lever that is meant to be
 * pulled for speed is the transcription mode, so that is the only one pulled.
 *
 * A clinic intake is also the wrong place to be aggressive about cutting a
 * caller off. People read a phone number with a pause in the middle of it.
 */
export const LISTENING = {
  /** Finalise the transcript as soon as it is stable, rather than as late as possible. */
  transcription_mode: "min_latency",
} as const;

export type Listening = typeof LISTENING;
