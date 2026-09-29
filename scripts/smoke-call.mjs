// Places one synthetic call against the live Voice Agent API and reports what happened.
//
// A scripted caller (macOS `say`, Indian English voice) speaks one line after each agent
// reply. The agent runs a two-field intake with a client-side `save_field` tool, so the
// run proves the token flow, the session config, the tool protocol and the audio path,
// and measures how long the agent takes to start answering after the caller stops.
//
// Usage: node scripts/smoke-call.mjs [outDir]     (reads ASSEMBLYAI_API_KEY from .env.local)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/twiceheard-smoke";
const TOOL_MODE = process.env.TOOL_MODE ?? "interactive";
const TRANSCRIPTION_MODE = process.env.TRANSCRIPTION_MODE ?? "balanced";
mkdirSync(OUT, { recursive: true });
const KEY = readEnv(".env.local").ASSEMBLYAI_API_KEY;
if (!KEY) throw new Error("ASSEMBLYAI_API_KEY missing from .env.local");

const RATE = 24_000;
const FRAME_BYTES = (RATE / 20) * 2; // 50 ms of PCM16 mono
const CALLER_VOICE = "Rishi";
const CALLER_LINES = [
  "Hi, I want to book an appointment. My name is Arjun Mehta.",
  "Yes, that's correct.",
  "My date of birth is the twelfth of March, nineteen ninety.",
  "Yes.",
  "No, that's all. Thank you, bye.",
];
const HARD_LIMIT_MS = 180_000;

const SYSTEM_PROMPT = [
  "You are the phone intake assistant for a small clinic. Speak briefly, one question at a time.",
  "Collect the caller's full name, then their date of birth.",
  "As soon as you hear a value, call save_field with status heard. The tool returns a readback sentence: say it exactly, then wait for the caller.",
  "When the caller confirms, call save_field again with the same value and status confirmed.",
  "If the caller corrects you, call save_field with the corrected value and status heard.",
  "Dates go to the tool as YYYY-MM-DD. Never give medical advice.",
  "When both fields are confirmed, ask if there is anything else, then say goodbye.",
].join(" ");

const TOOLS = [
  {
    type: "function",
    name: "save_field",
    description: "Store one intake field as heard or as confirmed by the caller.",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["full_name", "date_of_birth"] },
        value: { type: "string" },
        status: { type: "string", enum: ["heard", "confirmed"] },
      },
      required: ["field", "value", "status"],
    },
    execution_mode: TOOL_MODE,
    timeout_seconds: 10,
  },
];

function readEnv(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

/** Synthesise a caller line to raw 24 kHz PCM16 mono. */
function speak(text, index) {
  const aiff = join(OUT, `caller-${index}.aiff`);
  const wav = join(OUT, `caller-${index}.wav`);
  execFileSync("say", ["-v", CALLER_VOICE, "-o", aiff, text]);
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
  throw new Error("no data chunk");
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

async function mintToken() {
  const url =
    "https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=300";
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`token ${response.status}`);
  return (await response.json()).token;
}

const lines = CALLER_LINES.map(speak);
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(2);
const log = [];
const note = (text) => {
  const entry = `${at()}s ${text}`;
  log.push(entry);
  console.log(entry);
};

const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${await mintToken()}`);
const agentAudio = [];
const fields = {};
const latencies = [];
const pendingResults = [];
let ready = false;
let callerBuffer = null;
let callerCursor = 0;
let nextLine = 0;
let callerEndedAt = null;
const heardLatencies = [];
let firstAudioThisReply = true;
let replyBytes = 0;
let lastEvent = "";
let finished = false;

function send(message) {
  ws.send(JSON.stringify(message));
}

function readbackFor(field, value) {
  if (field === "date_of_birth") {
    const date = new Date(`${value}T00:00:00Z`);
    const spoken = date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    return `I have your date of birth as ${spoken}. Is that right?`;
  }
  return `I have your name as ${value}. Is that right?`;
}

function runTool(call) {
  const args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
  fields[args.field] = { value: args.value, status: args.status };
  const result =
    args.status === "heard"
      ? { ok: true, readback: readbackFor(args.field, args.value) }
      : { ok: true, confirmed: args.field };
  pendingResults.push({ call_id: call.call_id, result: JSON.stringify(result) });
  flushIfIdle();
}

function flushIfIdle() {
  if (lastEvent !== "reply.done" || pendingResults.length === 0) return;
  for (const item of pendingResults.splice(0)) send({ type: "tool.result", ...item });
  note(`tool.result flushed`);
}

function speakNextLine() {
  if (nextLine >= lines.length) {
    if (!finished) {
      finished = true;
      setTimeout(() => send({ type: "session.end" }), 1500);
    }
    return;
  }
  callerBuffer = lines[nextLine];
  callerCursor = 0;
  note(`caller: ${CALLER_LINES[nextLine]}`);
  nextLine += 1;
}

// Real-time audio pump: caller speech when there is some, silence otherwise.
const silence = Buffer.alloc(FRAME_BYTES);
let pumpTicks = 0;
const pump = setInterval(() => {
  if (!ready || ws.readyState !== WebSocket.OPEN) return;
  const expected = Math.floor((Date.now() - pumpStart) / 50);
  while (pumpTicks < expected) {
    pumpTicks += 1;
    let frame = silence;
    if (callerBuffer) {
      frame = Buffer.alloc(FRAME_BYTES);
      callerBuffer.copy(frame, 0, callerCursor, callerCursor + FRAME_BYTES);
      callerCursor += FRAME_BYTES;
      if (callerCursor >= callerBuffer.length) {
        callerBuffer = null;
        callerEndedAt = Date.now();
      }
    }
    send({ type: "input.audio", audio: frame.toString("base64") });
  }
}, 20);
let pumpStart = Date.now();

ws.addEventListener("open", () => {
  note("socket open");
  send({
    type: "session.update",
    session: {
      system_prompt: SYSTEM_PROMPT,
      greeting: "Hello, you've reached the clinic. May I have your full name, please?",
      input: {
        keyterms: ["Arjun Mehta"],
        transcription_mode: TRANSCRIPTION_MODE,
        voice_focus: "far-field",
      },
      output: { voice: "anna" },
      tools: TOOLS,
    },
  });
});

ws.addEventListener("message", (message) => {
  const event = JSON.parse(message.data);
  const type = event.type;
  if (type !== "reply.audio" && type !== "transcript.user.delta") lastEvent = type;
  switch (type) {
    case "session.ready":
      ready = true;
      pumpStart = Date.now();
      pumpTicks = 0;
      note(`session.ready ${event.session_id}`);
      setTimeout(() => nextLine === 0 && speakNextLine(), 6000);
      break;
    case "input.speech.stopped":
      note("speech.stopped");
      break;
    case "transcript.user":
      if (callerEndedAt) heardLatencies.push(Date.now() - callerEndedAt);
      note(`heard: ${event.text}`);
      break;
    case "reply.started":
      firstAudioThisReply = true;
      note("reply.started");
      break;
    case "reply.audio":
      agentAudio.push(Buffer.from(event.data, "base64"));
      replyBytes += Buffer.byteLength(event.data, "base64");
      if (firstAudioThisReply) note("first audio");
      if (firstAudioThisReply && callerEndedAt) {
        latencies.push(Date.now() - callerEndedAt);
        callerEndedAt = null;
      }
      firstAudioThisReply = false;
      break;
    case "transcript.agent":
      note(`agent: ${event.text}${event.interrupted ? " [interrupted]" : ""}`);
      break;
    case "tool.call":
      note(`tool.call ${event.name} ${JSON.stringify(event.arguments)}`);
      runTool(event);
      break;
    case "reply.done":
      note(`reply.done ${event.status ?? ""} audio=${(replyBytes / (RATE * 2)).toFixed(2)}s`);
      replyBytes = 0;
      if (event.status === "interrupted") pendingResults.length = 0;
      if (pendingResults.length > 0) flushIfIdle();
      else setTimeout(() => lastEvent === "reply.done" && speakNextLine(), 600);
      break;
    case "session.ended":
      note(`session.ended duration=${event.session_duration_seconds}s`);
      break;
    case "session.error":
    case "error":
      note(`ERROR ${event.code}: ${event.message}`);
      break;
    default:
      break;
  }
});

const done = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
const timer = setTimeout(() => {
  note("hard limit reached, ending session");
  send({ type: "session.end" });
}, HARD_LIMIT_MS);
const code = await done;
clearInterval(pump);
clearTimeout(timer);

writeFileSync(join(OUT, "agent.wav"), wavFromPcm(Buffer.concat(agentAudio)));
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const report = {
  closeCode: code,
  fields,
  toolMode: TOOL_MODE,
  transcriptionMode: TRANSCRIPTION_MODE,
  turns: latencies.length,
  heardAfterCallerEndMs: heardLatencies,
  firstAgentAudioAfterCallerEndMs: latencies,
  latencyMs: sorted.length ? { min: sorted[0], p50: pct(50), max: sorted.at(-1) } : null,
  agentAudioSeconds: Number((Buffer.concat(agentAudio).length / (RATE * 2)).toFixed(1)),
};
writeFileSync(join(OUT, "report.json"), JSON.stringify({ ...report, log }, null, 2));
console.log(JSON.stringify(report, null, 2));
