/**
 * One browser call, from the button to the goodbye.
 *
 * Everything that is not React lives here: the microphone, the socket, the
 * playback queue and the tool relay. The page passes in callbacks and gets
 * back a handle it can end. Written against the platform's browser guide:
 * the page never holds the API key, audio starts only after the session is
 * ready, tool results go back after the reply that asked for them, and the
 * session is ended properly so the platform does not keep billing a socket
 * nobody is listening to.
 */

export type CallPhase = "idle" | "connecting" | "live" | "ending" | "ended" | "failed";

export interface CallLine {
  id: string;
  who: "caller" | "agent";
  text: string;
  partial: boolean;
}

export interface CallField {
  field: string;
  value: string;
  status: "heard" | "confirmed" | "unresolved";
}

export interface CallHandlers {
  onPhase(phase: CallPhase, detail?: string): void;
  /** The platform's id for this call, as soon as it exists. */
  onSession(sessionId: string): void;
  onLine(line: CallLine): void;
  onField(field: CallField): void;
  onBooking(spoken: string): void;
}

export interface CallHandle {
  end(): void;
}

interface SessionStart {
  token: string;
  mode: "agent" | "relay";
  agentId?: string;
  session?: Record<string, unknown>;
}

const SOCKET_URL = "wss://agents.assemblyai.com/v1/ws";
const TARGET_RATE = 24_000;

/** Fetches a session, opens the microphone and the socket, and runs the call. */
export async function startCall(clinicId: string, handlers: CallHandlers): Promise<CallHandle> {
  handlers.onPhase("connecting");
  const start = await beginSession(clinicId);
  const audio = await openMicrophone();
  const socket = new WebSocket(`${SOCKET_URL}?token=${encodeURIComponent(start.token)}`);
  const call = new Call(start, audio, socket, handlers);
  call.run();
  return { end: () => call.end() };
}

async function beginSession(clinicId: string): Promise<SessionStart> {
  const response = await fetch("/api/voice/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clinicId }),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(problem.message ?? "The clinic line is not available right now.");
  }
  return (await response.json()) as SessionStart;
}

interface Microphone {
  context: AudioContext;
  stream: MediaStream;
  worklet: AudioWorkletNode;
}

async function openMicrophone(): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Echo cancellation lets a caller use speakers; the platform does its own noise work.
    audio: { echoCancellation: true, noiseSuppression: false },
  });
  const context = new AudioContext();
  await context.resume();
  await context.audioWorklet.addModule("/pcm-processor.js");
  const worklet = new AudioWorkletNode(context, "pcm-processor", {
    processorOptions: { inputSampleRate: context.sampleRate, targetSampleRate: TARGET_RATE },
  });
  context.createMediaStreamSource(stream).connect(worklet);
  return { context, stream, worklet };
}

class Call {
  private ready = false;
  private ended = false;
  private failed = false;
  private playAt = 0;
  private lastEvent = "";
  private pending: Array<{ call_id: string; result: string }> = [];
  private partial = "";

  constructor(
    private readonly start: SessionStart,
    private readonly audio: Microphone,
    private readonly socket: WebSocket,
    private readonly handlers: CallHandlers,
  ) {}

  run(): void {
    this.audio.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!this.ready || this.socket.readyState !== WebSocket.OPEN) return;
      this.send({ type: "input.audio", audio: toBase64(new Uint8Array(event.data)) });
    };
    this.socket.addEventListener("open", () => this.send(this.configure()));
    this.socket.addEventListener("message", (event) => this.handle(JSON.parse(String(event.data))));
    this.socket.addEventListener("error", () => this.fail("The call dropped. Please try again."));
    this.socket.addEventListener("close", () => this.finish());
    window.addEventListener("pagehide", () => this.end(), { once: true });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers.onPhase("ending");
    if (this.socket.readyState === WebSocket.OPEN) this.send({ type: "session.end" });
    else this.finish();
  }

  private configure() {
    const session =
      this.start.mode === "agent" ? { agent_id: this.start.agentId } : this.start.session;
    return { type: "session.update", session };
  }

  private send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  private handle(event: Record<string, unknown>): void {
    const type = String(event.type);
    if (type !== "reply.audio" && type !== "transcript.user.delta") this.lastEvent = type;
    const handler = this.events[type];
    if (handler) handler(event);
  }

  private readonly events: Record<string, (event: Record<string, unknown>) => void> = {
    "session.ready": (event) => {
      this.ready = true;
      const sessionId = String(event.session_id ?? "");
      if (sessionId) this.handlers.onSession(sessionId);
      this.playAt = this.audio.context.currentTime;
      this.handlers.onPhase("live");
    },
    "transcript.user.delta": (event) => {
      this.partial = String(event.text ?? "");
      this.handlers.onLine({ id: "partial", who: "caller", text: this.partial, partial: true });
    },
    "transcript.user": (event) => {
      this.partial = "";
      this.handlers.onLine({
        id: String(event.item_id ?? Date.now()),
        who: "caller",
        text: String(event.text ?? ""),
        partial: false,
      });
    },
    "transcript.agent": (event) => {
      this.handlers.onLine({
        id: String(event.item_id ?? Date.now()),
        who: "agent",
        text: String(event.text ?? ""),
        partial: false,
      });
    },
    "reply.audio": (event) => this.play(String(event.data ?? "")),
    "reply.done": (event) => {
      if (event.status === "interrupted") {
        this.playAt = this.audio.context.currentTime;
        this.pending = [];
      }
      void this.flush();
    },
    "tool.call": (event) => void this.runTool(event),
    "session.ended": () => this.finish(),
    "session.error": (event) =>
      this.fail(String(event.message ?? "The clinic line had a problem.")),
    error: (event) => this.fail(String(event.message ?? "The clinic line had a problem.")),
  };

  /** Chunks are queued end to end so the agent's voice has no gaps. */
  private play(base64: string): void {
    const bytes = fromBase64(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const buffer = this.audio.context.createBuffer(1, samples.length, TARGET_RATE);
    buffer.getChannelData(0).set(Float32Array.from(samples, (sample) => sample / 32768));
    const source = this.audio.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audio.context.destination);
    this.playAt = Math.max(this.playAt, this.audio.context.currentTime);
    source.start(this.playAt);
    this.playAt += buffer.duration;
  }

  /** The page runs no tool itself: it asks this app's API, which is what the phone calls too. */
  private async runTool(event: Record<string, unknown>): Promise<void> {
    const name = String(event.name ?? "");
    const args = (event.arguments ?? {}) as Record<string, unknown>;
    let result = '{"ok":false,"note":"That did not work. Tell the caller and carry on."}';
    try {
      const response = await fetch("/api/voice/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: name, arguments: args }),
      });
      const body: unknown = await response.json();
      if (response.ok) result = JSON.stringify(body);
      this.report(name, args, body);
    } catch {
      // Keep the fixed refusal above: the agent hears something it can act on.
    }
    this.pending.push({ call_id: String(event.call_id ?? ""), result });
    await this.flush();
  }

  private report(name: string, args: Record<string, unknown>, body: unknown): void {
    const ok = (body as { ok?: boolean }).ok === true;
    if (name === "save_field" && ok && typeof args.field === "string") {
      this.handlers.onField({
        field: args.field,
        value: String(args.value ?? ""),
        status: (args.status as CallField["status"]) ?? "heard",
      });
    }
    if (name === "book_appointment" && ok) {
      this.handlers.onBooking(String((body as { say?: string }).say ?? "Appointment booked."));
    }
  }

  /** Results go back only between replies, which is when the platform accepts them. */
  private async flush(): Promise<void> {
    if (this.lastEvent !== "reply.done" || this.pending.length === 0) return;
    for (const result of this.pending.splice(0)) this.send({ type: "tool.result", ...result });
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.failed = true;
    this.handlers.onPhase("failed", message);
    this.cleanup();
  }

  private finish(): void {
    this.cleanup();
    // A failure has already told the caller why; do not paint over it with "call ended".
    if (!this.failed) this.handlers.onPhase("ended");
  }

  private cleanup(): void {
    this.audio.worklet.port.onmessage = null;
    this.audio.stream.getTracks().forEach((track) => track.stop());
    void this.audio.context.close();
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
