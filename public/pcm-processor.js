/**
 * Microphone capture for a browser call.
 *
 * The voice platform wants 24 kHz signed 16-bit mono. Chromium will give an
 * AudioContext at that rate, but Firefox breaks echo cancellation when forced
 * and Safari ignores the request entirely, so the page keeps the browser's own
 * rate and this worklet resamples. It runs off the main thread, so a busy page
 * never stutters the caller's audio.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate } = options.processorOptions;
    this.ratio = inputSampleRate / targetSampleRate;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const length = Math.floor(input.length / this.ratio);
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i += 1) {
      const sample = input[Math.floor(i * this.ratio)] || 0;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
