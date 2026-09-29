// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startCall,
  type CallField,
  type CallLine,
  type CallPhase,
} from "@/lib/call/session-client";

/**
 * The browser call, driven against a fake microphone, socket and speaker.
 *
 * Every rule the platform's guide sets is asserted here, because getting one
 * wrong costs a caller a broken call or costs the account a billable socket
 * nobody is listening to: no audio before the session is ready, tool results
 * only between replies, playback queued end to end, and a proper session end.
 */

class FakeSocket {
  static last: FakeSocket;
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** What the server would send the page. */
  say(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  typed(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === type);
  }
}

const track = { stop: vi.fn() };
const worklet = {
  port: { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null },
};
const started: number[] = [];
let audioContext: {
  currentTime: number;
  sampleRate: number;
  destination: unknown;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  createMediaStreamSource: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
};
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

const RELAY_SESSION = { token: "tok", mode: "relay", session: { system_prompt: "be brief" } };

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  track.stop.mockClear();
  worklet.port.onmessage = null;
  started.length = 0;
  audioContext = {
    currentTime: 10,
    sampleRate: 48_000,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createBuffer: vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    })),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn((at: number) => started.push(at)),
    })),
  };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  fetchMock = vi.fn(async () => jsonResponse(RELAY_SESSION));
  vi.stubGlobal("WebSocket", FakeSocket);
  // Both are constructed with `new`, so the stubs must be functions, not arrows.
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function FakeAudioContext() {
      return audioContext;
    }),
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    vi.fn(function FakeAudioWorkletNode() {
      return worklet;
    }),
  );
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function handlers() {
  const phases: CallPhase[] = [];
  const lines: CallLine[] = [];
  const fields: CallField[] = [];
  const bookings: string[] = [];
  const sessions: string[] = [];
  let detail = "";
  return {
    phases,
    lines,
    fields,
    bookings,
    sessions,
    detail: () => detail,
    handlers: {
      onPhase: (phase: CallPhase, note?: string) => {
        phases.push(phase);
        if (note) detail = note;
      },
      onLine: (line: CallLine) => lines.push(line),
      onField: (field: CallField) => fields.push(field),
      onBooking: (spoken: string) => bookings.push(spoken),
      onSession: (sessionId: string) => sessions.push(sessionId),
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("startCall", () => {
  it("asks this app for a session, opens the microphone politely and connects with the token", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body))).toEqual({
      clinicId: "sunrise-family",
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: false },
    });
    expect(audioContext.audioWorklet.addModule).toHaveBeenCalledWith("/pcm-processor.js");
    expect(vi.mocked(AudioWorkletNode).mock.calls[0]?.[2]).toEqual({
      processorOptions: { inputSampleRate: 48_000, targetSampleRate: 24_000 },
    });
    expect(FakeSocket.last.url).toBe("wss://agents.assemblyai.com/v1/ws?token=tok");
    expect(watcher.phases).toEqual(["connecting"]);
  });

  it("sends the inline session when relaying, and the agent id when one exists", async () => {
    await startCall("sunrise-family", handlers().handlers);
    FakeSocket.last.emit("open", {});
    expect(FakeSocket.last.sent[0]).toEqual({
      type: "session.update",
      session: { system_prompt: "be brief" },
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ token: "tok2", mode: "agent", agentId: "agent-1" }),
    );
    await startCall("sunrise-family", handlers().handlers);
    FakeSocket.last.emit("open", {});
    expect(FakeSocket.last.sent[0]).toEqual({
      type: "session.update",
      session: { agent_id: "agent-1" },
    });
  });

  it("holds the microphone until the session is ready, then streams it", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    const frame = new Int16Array([1, -1, 32767]).buffer;
    worklet.port.onmessage?.({ data: frame } as MessageEvent<ArrayBuffer>);
    expect(FakeSocket.last.typed("input.audio")).toHaveLength(0);
    FakeSocket.last.say({ type: "session.ready", session_id: "sess_1" });
    expect(watcher.phases).toContain("live");
    // The page needs the platform's id to claim this call and read its chart back.
    expect(watcher.sessions).toEqual(["sess_1"]);
    worklet.port.onmessage?.({ data: frame } as MessageEvent<ArrayBuffer>);
    const audio = FakeSocket.last.typed("input.audio");
    expect(audio).toHaveLength(1);
    expect(typeof audio[0]?.audio).toBe("string");
  });

  it("shows partial speech, replaces it with the final line, and shows the agent's words", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    FakeSocket.last.say({ type: "transcript.user.delta", text: "my name is" });
    FakeSocket.last.say({ type: "transcript.user", text: "my name is Arjun Mehta", item_id: "u1" });
    FakeSocket.last.say({
      type: "transcript.agent",
      text: "I have your name as Arjun Mehta.",
      item_id: "a1",
    });
    expect(watcher.lines).toEqual([
      { id: "partial", who: "caller", text: "my name is", partial: true },
      { id: "u1", who: "caller", text: "my name is Arjun Mehta", partial: false },
      { id: "a1", who: "agent", text: "I have your name as Arjun Mehta.", partial: false },
    ]);
  });

  it("queues the agent's audio end to end and restarts the queue when the caller interrupts", async () => {
    await startCall("sunrise-family", handlers().handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    const chunk = btoa("\u0000\u0001".repeat(240));
    FakeSocket.last.say({ type: "reply.audio", data: chunk });
    FakeSocket.last.say({ type: "reply.audio", data: chunk });
    expect(started).toEqual([10, 10.01]);
    audioContext.currentTime = 20;
    FakeSocket.last.say({ type: "reply.done", status: "interrupted" });
    FakeSocket.last.say({ type: "reply.audio", data: chunk });
    expect(started.at(-1)).toBe(20);
  });

  it("relays a tool call to this app and returns the result only after the reply is done", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, say: "I have your name as Arjun Mehta. Is that right?" }),
    );
    FakeSocket.last.say({
      type: "tool.call",
      call_id: "c1",
      name: "save_field",
      arguments: { intake_id: "K7F2Q9", field: "full_name", value: "Arjun Mehta", status: "heard" },
    });
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/voice/tool",
      expect.objectContaining({ method: "POST" }),
    );
    expect(FakeSocket.last.typed("tool.result")).toHaveLength(0);
    FakeSocket.last.say({ type: "reply.done", status: "completed" });
    await flush();
    const results = FakeSocket.last.typed("tool.result");
    expect(results[0]).toMatchObject({ call_id: "c1" });
    expect(JSON.parse(String(results[0]?.result))).toMatchObject({ ok: true });
    expect(watcher.fields).toEqual([{ field: "full_name", value: "Arjun Mehta", status: "heard" }]);
  });

  it("reports a booking, and keeps quiet about tools that did not succeed", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, say: "You're booked for Tuesday." }));
    FakeSocket.last.say({
      type: "tool.call",
      call_id: "c2",
      name: "book_appointment",
      arguments: {},
    });
    await flush();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, note: "Confirm the phone first." }));
    FakeSocket.last.say({
      type: "tool.call",
      call_id: "c3",
      name: "save_field",
      arguments: { field: "phone", value: "x", status: "heard" },
    });
    await flush();
    expect(watcher.bookings).toEqual(["You're booked for Tuesday."]);
    expect(watcher.fields).toEqual([]);
  });

  it("gives the agent something to say when the relay itself fails", async () => {
    await startCall("sunrise-family", handlers().handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    FakeSocket.last.say({ type: "tool.call", call_id: "c4", name: "find_slots", arguments: {} });
    await flush();
    FakeSocket.last.say({ type: "reply.done", status: "completed" });
    await flush();
    const result = JSON.parse(String(FakeSocket.last.typed("tool.result")[0]?.result)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
  });

  it("ends the session rather than dropping the socket, and lets go of the microphone", async () => {
    const watcher = handlers();
    const call = await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    call.end();
    expect(FakeSocket.last.typed("session.end")).toHaveLength(1);
    expect(watcher.phases).toContain("ending");
    FakeSocket.last.say({ type: "session.ended", session_duration_seconds: 42 });
    expect(watcher.phases.at(-1)).toBe("ended");
    expect(track.stop).toHaveBeenCalled();
    expect(audioContext.close).toHaveBeenCalled();
    call.end();
    expect(FakeSocket.last.typed("session.end")).toHaveLength(1);
  });

  it("ends the call when the page goes away", async () => {
    await startCall("sunrise-family", handlers().handlers);
    FakeSocket.last.emit("open", {});
    window.dispatchEvent(new Event("pagehide"));
    expect(FakeSocket.last.typed("session.end")).toHaveLength(1);
  });

  it("cleans up when the socket is already closed", async () => {
    const watcher = handlers();
    const call = await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.readyState = 3;
    call.end();
    expect(watcher.phases.at(-1)).toBe("ended");
    expect(track.stop).toHaveBeenCalled();
  });

  it("explains a refused session, a socket error and a session error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Too many calls started." }, false));
    await expect(startCall("sunrise-family", handlers().handlers)).rejects.toThrow(
      "Too many calls started.",
    );
    fetchMock.mockResolvedValueOnce(jsonResponse("not an object", false));
    await expect(startCall("sunrise-family", handlers().handlers)).rejects.toThrow(/not available/);
    // A refusal with no readable body still has to say something a caller can act on.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => Promise.reject(new Error("empty")),
    } as unknown as Response);
    await expect(startCall("sunrise-family", handlers().handlers)).rejects.toThrow(/not available/);

    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("error", {});
    expect(watcher.phases.at(-1)).toBe("failed");
    expect(watcher.detail()).toMatch(/dropped/);
    expect(track.stop).toHaveBeenCalled();

    const second = handlers();
    await startCall("sunrise-family", second.handlers);
    FakeSocket.last.say({ type: "session.error", message: "agent_init_failed" });
    expect(second.phases.at(-1)).toBe("failed");
    expect(second.detail()).toBe("agent_init_failed");

    const third = handlers();
    await startCall("sunrise-family", third.handlers);
    FakeSocket.last.say({ type: "error" });
    expect(third.detail()).toMatch(/problem/);
  });

  it("survives events that leave fields out", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    FakeSocket.last.say({ type: "transcript.user.delta" });
    FakeSocket.last.say({ type: "transcript.user", text: "hello" });
    FakeSocket.last.say({ type: "transcript.agent", text: "hello back" });
    FakeSocket.last.say({ type: "transcript.user", item_id: "u9" });
    FakeSocket.last.say({ type: "transcript.agent", item_id: "a9" });
    FakeSocket.last.say({ type: "reply.audio" });
    // Empty lines are dropped by the page, so only the three with words are kept.
    expect(watcher.lines.map((line) => line.text)).toEqual(["", "hello", "hello back", "", ""]);
    expect(watcher.lines[1]?.id).toMatch(/^\d+$/);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    FakeSocket.last.say({ type: "tool.call" });
    await flush();
    FakeSocket.last.say({ type: "reply.done" });
    await flush();
    expect(FakeSocket.last.typed("tool.result")[0]).toMatchObject({ call_id: "" });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    FakeSocket.last.say({ type: "tool.call", call_id: "c9", name: "book_appointment" });
    await flush();
    expect(watcher.bookings).toEqual(["Appointment booked."]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    FakeSocket.last.say({
      type: "tool.call",
      call_id: "c10",
      name: "save_field",
      arguments: { field: "phone" },
    });
    await flush();
    expect(watcher.fields).toEqual([{ field: "phone", value: "", status: "heard" }]);

    const quiet = handlers();
    await startCall("sunrise-family", quiet.handlers);
    FakeSocket.last.say({ type: "session.error" });
    expect(quiet.detail()).toMatch(/problem/);
  });

  it("keeps a refusal when the relay answers with an error status", async () => {
    await startCall("sunrise-family", handlers().handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no_call_in_progress" }, false));
    FakeSocket.last.say({
      type: "tool.call",
      call_id: "c11",
      name: "finish_intake",
      arguments: {},
    });
    await flush();
    FakeSocket.last.say({ type: "reply.done", status: "completed" });
    await flush();
    const result = JSON.parse(String(FakeSocket.last.typed("tool.result")[0]?.result)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
  });

  it("says nothing more once the call is over", async () => {
    const watcher = handlers();
    const call = await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.emit("open", {});
    FakeSocket.last.say({ type: "session.ready" });
    call.end();
    FakeSocket.last.say({ type: "session.ended" });
    const after = watcher.phases.length;
    FakeSocket.last.emit("error", {});
    expect(watcher.phases).toHaveLength(after);
    expect(watcher.phases.at(-1)).toBe("ended");
  });

  it("ignores events it does not know", async () => {
    const watcher = handlers();
    await startCall("sunrise-family", watcher.handlers);
    FakeSocket.last.say({ type: "input.speech.started" });
    expect(watcher.phases).toEqual(["connecting"]);
  });
});
