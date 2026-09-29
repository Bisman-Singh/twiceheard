// Builds one WAV of a caller working through an intake, for the demo recording.
//
// Chromium can use a file as the microphone, so a whole call can be made with no person
// and no hardware. The file is one long track: each answer, then a gap long enough for
// the agent to ask the next question and read a value back. The gaps are set from real
// runs, where the agent took four to eight seconds between turns.
//
// Usage: node scripts/demo-audio.mjs [outFile]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "demo/caller.wav";
const VOICE = process.env.CALLER_VOICE ?? "Rishi";
const RATE = 48_000;

/** Each line, and the silence after it, in seconds. */
const SCRIPT = [
  ["I have had a fever and a sore throat for three days.", 11],
  ["My name is Arjun Mehta.", 13],
  ["Yes, that's right.", 11],
  ["The twelfth of March, nineteen ninety.", 14],
  ["Yes, that's right.", 11],
  ["It is nine eight one two three four five six seven eight.", 15],
  ["Yes, that's right.", 11],
  ["I take Metformin every day.", 14],
  // Deliberately not a yes. The caller answers the readback without agreeing to it, which is
  // what the product is built to notice, so the recording shows a field that ends amber.
  ["That's the only one I take.", 12],
  ["No allergies.", 13],
  ["Yes, that's right.", 11],
  ["Tomorrow morning would suit me.", 14],
  ["Doctor Kapoor, please.", 13],
  ["Yes, please book that one.", 12],
  ["No, that's all. Thank you.", 8],
];

const work = mkdtempSync(join(tmpdir(), "twiceheard-demo-"));

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
SCRIPT.forEach(([line, gap], index) => {
  parts.push(speak(line, index), silence(gap));
});

const pcm = Buffer.concat(parts);
writeFileSync(OUT, wavFromPcm(pcm));
console.log(`${OUT}: ${(pcm.length / (RATE * 2)).toFixed(1)}s, ${SCRIPT.length} answers`);
