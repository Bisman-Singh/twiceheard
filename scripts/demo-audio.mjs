// Builds one WAV of a caller working through an intake, for the demo recording.
//
// Chromium can use a file as the microphone, so a whole call can be made with no person
// and no hardware. The file is one long track: each answer, then a gap long enough for
// the agent to ask the next question and read a value back. The gaps are set from real
// runs, where the agent took four to eight seconds between turns.
//
// A recorded voice makes a better demonstration than a synthesised one, so if a file of
// the caller's lines is given with --voice, it is split on its own pauses and used
// instead of the system voice. The line order has to match the script below.
//
// Two callers can be built from the same recording, because the demonstration needs
// both halves of the claim on screen:
//
//   --variant clean        every readback answered with a yes, and an appointment booked.
//                          This is what a good call looks like, and the chart is all green.
//   --variant unanswered   the caller says nothing at all after the medications readback.
//                          A dropped line, a distracted patient. Whatever the agent files
//                          next, nobody confirmed that value, and the chart has to say so.
//
// The second is the one that matters. It is deliberately not a caller who mumbles or
// half-agrees: an example a viewer could argue with is worse than no example, because
// the whole product rests on the flag being fair.
//
// Usage: node scripts/demo-audio.mjs [outFile] [--voice caller-voice.mp3] [--variant clean]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "demo/caller.wav";
const VOICE = process.env.CALLER_VOICE ?? "Rishi";
const RATE = 48_000;

const variantAt = process.argv.indexOf("--variant");
const VARIANT = variantAt === -1 ? "clean" : process.argv[variantAt + 1];
if (VARIANT !== "clean" && VARIANT !== "unanswered") {
  throw new Error("--variant must be clean or unanswered");
}

/**
 * Each line, and the silence after it, in seconds.
 *
 * A gap has to hold the agent's next question, its readback, and whatever a narrator
 * says over the recording afterwards. The agent's replies vary by a second or so between
 * runs, so the gaps where the demonstration is narrated carry about two seconds of slack;
 * without it a line of narration runs into the caller's next answer.
 */
const SCRIPT = [
  ["I have had a fever and a sore throat for three days.", 11],
  ["My name is Arjun Mehta.", 15],
  ["Yes, that's right.", 13],
  ["The twelfth of March, nineteen ninety.", 14],
  ["Yes, that's right.", 12],
  ["It is nine eight one two three four five six seven eight.", 15],
  ["Yes, that's right.", 13],
  ["I take Metformin every day.", 14],
  // The answer to the medications readback, and the only line the two variants differ on.
  // In `unanswered` the caller says nothing here at all: the clip is dropped and only the
  // silence is kept, so nobody can argue about whether that was agreement.
  ["Yes, that's right.", 13],
  ["No allergies.", 15],
  ["Yes, that's right.", 11],
  ["Tomorrow morning would suit me.", 14],
  ["Doctor Kapoor, please.", 13],
  ["Yes, please book that one.", 12],
  ["No, that's all. Thank you.", 8],
];

const work = mkdtempSync(join(tmpdir(), "twiceheard-demo-"));
const voiceAt = process.argv.indexOf("--voice");
const VOICE_FILE = voiceAt === -1 ? null : process.argv[voiceAt + 1];

/** Where each line starts in a recording of all of them, found by its own pauses. */
function lineStarts(file, expected) {
  const output = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-34dB:d=0.3", "-f", "null", "-"],
    { encoding: "utf8" },
  ).stderr;
  const ends = [...output.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const starts = [0, ...ends];
  if (starts.length < expected) {
    throw new Error(`found ${starts.length} lines in ${file}, expected ${expected}`);
  }
  return starts.slice(0, expected);
}

function cut(file, start, end, index) {
  const wav = join(work, `voice-${index}.wav`);
  const args = ["-hide_banner", "-loglevel", "error", "-ss", String(start)];
  if (end !== null) args.push("-to", String(end));
  execFileSync("ffmpeg", [...args, "-i", file, "-ar", String(RATE), "-ac", "1", wav, "-y"]);
  return pcmFromWav(readFileSync(wav));
}

function speak(text, index) {
  const aiff = join(work, `${index}.aiff`);
  const wav = join(work, `${index}.wav`);
  execFileSync("say", ["-v", VOICE, "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", aiff, wav]);
  return pcmFromWav(readFileSync(wav));
}

function pcmFromWav(buffer) {
  let offset = 12;
  while (offset < buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in synthesised audio");
}

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const silence = (seconds) => Buffer.alloc(Math.round(seconds * RATE) * 2);

// The agent greets first, so the caller waits before saying anything.
const parts = [silence(8)];
const starts = VOICE_FILE ? lineStarts(VOICE_FILE, SCRIPT.length) : null;
/** The medications readback is answered by the line at this position in the script. */
const MEDICATION_ANSWER = 8;
/** How long the silent caller stays silent, on top of the answer they are not giving. */
const WAIT_OUT = 12;
/**
 * Where a line takes its audio from, when it is not its own position.
 *
 * The recording was made against an earlier script whose medications answer was
 * "That's the only one I take". That reads as agreement to anyone listening, so the
 * script now answers with a yes and borrows the yes already in the recording rather
 * than asking for the voice to be recorded again for one line.
 */
const CLIP_FOR = new Map([[MEDICATION_ANSWER, 2]]);

SCRIPT.forEach(([line, gap], index) => {
  const clip = CLIP_FOR.get(index) ?? index;
  const spoken = starts
    ? cut(VOICE_FILE, starts[clip], starts[clip + 1] ?? null, index)
    : speak(line, index);
  const silent = VARIANT === "unanswered" && index === MEDICATION_ANSWER;
  // The gap holds the clip's own length so later answers do not slide forward, plus
  // long enough for the agent to stop waiting and ask its next question. Without that
  // the caller's next line lands against the unanswered readback instead, and the
  // chart reports them as having answered a question they never heard.
  parts.push(silent ? silence(spoken.length / (RATE * 2) + WAIT_OUT) : spoken, silence(gap));
});

const pcm = Buffer.concat(parts);
writeFileSync(OUT, wavFromPcm(pcm));
console.log(
  `${OUT}: ${(pcm.length / (RATE * 2)).toFixed(1)}s, ${SCRIPT.length} answers, variant ${VARIANT}`,
);
