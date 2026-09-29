// Drives one whole call through the running product, against the live Voice Agent API.
//
// Unlike scripts/smoke-call.mjs, which talks to the platform directly, this script behaves
// exactly as the browser does: it asks the server for a session, keeps the grant cookie,
// relays every tool call back through the server, claims the session, and then asks the
// server for the chart. What it proves is the whole path, including the parts a unit test
// has to fake: the real socket, the real agent, the real tools, the real second hearing.
//
// The caller is synthetic. macOS `say` speaks each line, and the reply is chosen from what
// the agent just asked, so the run does not drift when the agent varies its wording.
//
// Usage: node scripts/e2e-call.mjs [baseUrl] [outDir]     (needs the dev server running)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "/tmp/twiceheard-e2e";
const CLINIC = process.env.CLINIC_ID ?? "sunrise-family";
const CALLER_VOICE = process.env.CALLER_VOICE ?? "Rishi";
const RATE = 24_000;
const FRAME_BYTES = (RATE / 20) * 2; // 50 ms of PCM16 mono
const HARD_LIMIT_MS = 5 * 60_000;
const RESULT_TRIES = 30;
const RESULT_WAIT_MS = 4000;

mkdirSync(OUT, { recursive: true });

/** What the synthetic caller says, chosen by what the agent just asked for. */
const ANSWERS = [
  [/is that right|did i get that|is that correct|correct\?|spelt|spelled/i, "Yes, that's right."],
  [/full name|your name|may i have your name/i, "My name is Arjun Mehta."],
  [/date of birth|born|birthday/i, "The twelfth of March, nineteen ninety."],
  [
    /phone|mobile|number to reach|contact number/i,
    "It is nine eight one two three four five six seven eight.",
  ],
  [
    /reason|bring you in|what.*visit|how can i help|what's the matter|symptom/i,
    "I have had a fever and a sore throat for three days.",
  ],
  [/medication|medicine|tablets|taking anything/i, "I take Metformin every day."],
  [/allerg/i, "No allergies."],
  [/time|when would|morning|afternoon|slot|appointment/i, "Tomorrow morning would suit me."],
  [/anything else|that all|help you with today/i, "No, that's all. Thank you."],
];
const FALLBACK = "Yes.";

const log = [];
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(2);
const note = (text) => {
  const entry = `${at()}s ${text}`;
  log.push(entry);
  console.log(entry);
};

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
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Every request the page would make, including the cookie the server handed back. */
let cookie = "";
async function ask(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

const session = await ask("/api/voice/session", { clinicId: CLINIC });
if (session.status !== 200) {
  throw new Error(`session ${session.status}: ${JSON.stringify(session.body)}`);
}
note(`session minted, mode=${session.body.mode}`);

const ws = new WebSocket(
  `wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(session.body.token)}`,
);

const agentAudio = [];
const latencies = [];
const pending = [];
const toolCalls = [];
const said = [];
let sessionId = null;
let ready = false;
let lastEvent = "";
let callerBuffer = null;
let callerCursor = 0;
let callerEndedAt = null;
let firstAudioThisReply = true;
let spokenLines = 0;
let goodbyeSaid = false;
let finished = false;

const send = (message) => ws.send(JSON.stringify(message));

function reply(question) {
  const found = ANSWERS.find(([pattern]) => pattern.test(question));
  return found ? found[1] : FALLBACK;
}

function say(text) {
  callerBuffer = speak(text, spokenLines);
  callerCursor = 0;
  spokenLines += 1;
  said.push(text);
  note(`caller: ${text}`);
  if (/that's all/i.test(text)) goodbyeSaid = true;
}

async function runTool(event) {
  const args = typeof event.arguments === "string" ? JSON.parse(event.arguments) : event.arguments;
  const started = Date.now();
  const { status, body } = await ask("/api/voice/tool", { tool: event.name, arguments: args });
  toolCalls.push({ tool: event.name, status, ms: Date.now() - started, ok: body?.ok });
  note(`tool ${event.name} -> ${status} ${JSON.stringify(body).slice(0, 120)}`);
  pending.push({ call_id: event.call_id, result: JSON.stringify(body) });
  flushIfIdle();
}

function flushIfIdle() {
  if (lastEvent !== "reply.done" || pending.length === 0) return;
  for (const item of pending.splice(0)) send({ type: "tool.result", ...item });
}

const silence = Buffer.alloc(FRAME_BYTES);
let pumpStart = Date.now();
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

ws.addEventListener("open", () => {
  note("socket open");
  const config =
    session.body.mode === "agent" ? { agent_id: session.body.agentId } : session.body.session;
  send({ type: "session.update", session: config });
});

ws.addEventListener("message", async (message) => {
  const event = JSON.parse(message.data);
  const type = event.type;
  if (type !== "reply.audio" && type !== "transcript.user.delta") lastEvent = type;
  switch (type) {
    case "session.ready": {
      ready = true;
      pumpStart = Date.now();
      pumpTicks = 0;
      sessionId = event.session_id ?? null;
      note(`session.ready ${sessionId}`);
      if (sessionId) {
        const claimed = await ask("/api/call/claim", { sessionId });
        note(`claim -> ${claimed.status}`);
      }
      break;
    }
    case "transcript.agent":
      note(`agent: ${event.text}`);
      break;
    case "reply.audio":
      agentAudio.push(Buffer.from(event.data, "base64"));
      if (firstAudioThisReply && callerEndedAt) {
        latencies.push(Date.now() - callerEndedAt);
        callerEndedAt = null;
      }
      firstAudioThisReply = false;
      break;
    case "reply.started":
      firstAudioThisReply = true;
      break;
    case "tool.call":
      await runTool(event);
      break;
    case "reply.done":
      if (event.status === "interrupted") pending.length = 0;
      if (pending.length > 0) {
        flushIfIdle();
      } else if (goodbyeSaid) {
        if (!finished) {
          finished = true;
          setTimeout(() => send({ type: "session.end" }), 2000);
        }
      } else {
        const question = event.text ?? lastAgentLine();
        setTimeout(() => lastEvent === "reply.done" && say(reply(question)), 900);
      }
      break;
    case "session.ended":
      note(`session.ended ${event.session_duration_seconds ?? ""}s`);
      break;
    case "session.error":
    case "error":
      note(`ERROR ${event.code ?? ""}: ${event.message ?? ""}`);
      break;
    default:
      break;
  }
});

function lastAgentLine() {
  const line = [...log].reverse().find((entry) => entry.includes("agent: "));
  return line ? line.slice(line.indexOf("agent: ") + 7) : "";
}

const closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
const limit = setTimeout(() => {
  note("hard limit reached, ending the call");
  send({ type: "session.end" });
}, HARD_LIMIT_MS);
const closeCode = await closed;
clearInterval(pump);
clearTimeout(limit);
note(`socket closed ${closeCode}`);

writeFileSync(join(OUT, "agent.wav"), wavFromPcm(Buffer.concat(agentAudio)));

let result = { status: "not asked" };
if (sessionId) {
  for (let attempt = 1; attempt <= RESULT_TRIES; attempt += 1) {
    const response = await ask("/api/call/result", { sessionId });
    note(`result attempt ${attempt} -> ${response.status} ${response.body?.status ?? ""}`);
    if (response.status === 200 && response.body?.status === "ready") {
      result = response.body;
      break;
    }
    result = { status: response.body?.status ?? `http ${response.status}` };
    await new Promise((resolve) => setTimeout(resolve, RESULT_WAIT_MS));
  }
}

const record = result.record ?? null;
const report = {
  closeCode,
  sessionId,
  mode: session.body.mode,
  said,
  toolCalls,
  firstAudioAfterCallerMs: latencies,
  agentAudioSeconds: Number((Buffer.concat(agentAudio).length / (RATE * 2)).toFixed(1)),
  chart: record
    ? Object.fromEntries(
        record.grade.fields.map((field) => [
          field.id,
          {
            value: record.chart[field.id].value,
            status: record.chart[field.id].status,
            grade: field.grade,
            reasons: field.reasons,
          },
        ]),
      )
    : null,
  counts: record?.grade.counts ?? null,
  ready: record?.grade.ready ?? null,
  hearing: record?.hearing ?? null,
  issues: record?.issues ?? null,
  booking: record?.booking ?? null,
  resultStatus: result.status,
};
writeFileSync(join(OUT, "report.json"), JSON.stringify({ ...report, log }, null, 2));
console.log(JSON.stringify(report, null, 2));
