export {};

type AudioAction = "start" | "stop" | "status" | "drain";

interface TabAudioMessage {
  type: "WEBBRIDGE_TAB_AUDIO";
  action: AudioAction;
  streamId?: string;
  tabId?: number;
  tabTitle?: string;
  tabUrl?: string;
  timesliceMs?: number;
  mimeType?: string;
  maxChunks?: number;
  includeBase64?: boolean;
  clear?: boolean;
  maxBytes?: number;
  audioEndpoint?: string;
  eventEndpoint?: string;
  pcmSampleRate?: number;
  pcmChunkSamples?: number;
}

interface StoredChunk {
  seq: number;
  capturedAt: number;
  size: number;
  mimeType: string;
  blob: Blob;
}

interface RecorderState {
  status: "idle" | "recording" | "stopping" | "error";
  startedAt?: number;
  stoppedAt?: number;
  tabId?: number;
  tabTitle?: string;
  tabUrl?: string;
  mimeType?: string;
  timesliceMs?: number;
  audioEndpointConfigured?: boolean;
  eventEndpointConfigured?: boolean;
  pcmSampleRate?: number;
  pcmChunkSamples?: number;
  pcmChunksPosted?: number;
  pcmBytesPosted?: number;
  pcmLastError?: string;
  lastError?: string;
}

let state: RecorderState = { status: "idle" };
let stream: MediaStream | undefined;
let recorder: MediaRecorder | undefined;
let audioContext: AudioContext | undefined;
let sourceNode: MediaStreamAudioSourceNode | undefined;
let processorNode: ScriptProcessorNode | undefined;
let monitorGainNode: GainNode | undefined;
let pcmChunk = new Int16Array(0);
let pcmOffset = 0;
let audioEndpoint: string | undefined;
let eventEndpoint: string | undefined;
let seq = 0;
let retainedMaxChunks = 120;
let chunks: StoredChunk[] = [];

function pickMimeType(preferred?: string): string | undefined {
  const candidates = [
    preferred,
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((value) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(value));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pcmEncoding(): string {
  return `pcm_s16le_${state.pcmSampleRate || 16_000}hz_mono`;
}

function postCaptureEvent(type: string, detail: Record<string, unknown> = {}): void {
  if (!eventEndpoint) return;
  fetch(eventEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, source: "webbridge-tab-audio", at: new Date().toISOString(), ...detail }),
    keepalive: true,
  }).catch((error) => {
    state = { ...state, pcmLastError: toErrorMessage(error) };
  });
}

function postPcmChunk(buffer: ArrayBuffer): void {
  if (!audioEndpoint) return;
  const byteLength = buffer.byteLength;
  fetch(audioEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-agent-viso-encoding": pcmEncoding(),
    },
    body: buffer,
    keepalive: false,
  }).then(() => {
    state = {
      ...state,
      pcmChunksPosted: (state.pcmChunksPosted || 0) + 1,
      pcmBytesPosted: (state.pcmBytesPosted || 0) + byteLength,
    };
  }).catch((error) => {
    state = { ...state, pcmLastError: toErrorMessage(error) };
  });
}

function flushPcmChunk(): void {
  if (!pcmOffset || !pcmChunk.length) return;
  const out = pcmOffset === pcmChunk.length ? pcmChunk : pcmChunk.slice(0, pcmOffset);
  const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  pcmOffset = 0;
  pcmChunk = new Int16Array(state.pcmChunkSamples || pcmChunk.length || 1_920);
  postPcmChunk(buffer);
}

function enqueueFloat32(floatData: Float32Array, inputSampleRate: number): void {
  if (!state.audioEndpointConfigured || !pcmChunk.length || state.status !== "recording") return;
  const outputRate = state.pcmSampleRate || 16_000;
  const ratio = (inputSampleRate || outputRate) / outputRate;
  const outputLength = Math.max(1, Math.floor(floatData.length / ratio));
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(floatData.length - 1, low + 1);
    const frac = sourceIndex - low;
    const sample = ((floatData[low] || 0) * (1 - frac)) + ((floatData[high] || 0) * frac);
    const clamped = Math.max(-1, Math.min(1, sample));
    pcmChunk[pcmOffset++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    if (pcmOffset >= pcmChunk.length) flushPcmChunk();
  }
}

function summarize() {
  return {
    ...state,
    chunks: chunks.length,
    totalBytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
    firstChunkAt: chunks[0]?.capturedAt,
    lastChunkAt: chunks[chunks.length - 1]?.capturedAt,
    recorderState: recorder?.state,
    streamActive: Boolean(stream?.active),
  };
}

async function stopCapture(): Promise<Record<string, unknown>> {
  if (state.status === "idle") return { ok: true, ...summarize() };

  state.status = "stopping";
  await new Promise<void>((resolve) => {
    const current = recorder;
    if (!current || current.state === "inactive") {
      resolve();
      return;
    }
    const finish = () => resolve();
    current.addEventListener("stop", finish, { once: true });
    current.stop();
    setTimeout(finish, 2_000);
  });

  flushPcmChunk();
  for (const track of stream?.getTracks() ?? []) track.stop();
  sourceNode?.disconnect();
  processorNode?.disconnect();
  monitorGainNode?.disconnect();
  postCaptureEvent("tab_audio_capture_stopped", { chunks: chunks.length, totalBytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0) });
  await audioContext?.close().catch(() => undefined);

  stream = undefined;
  recorder = undefined;
  sourceNode = undefined;
  processorNode = undefined;
  monitorGainNode = undefined;
  audioContext = undefined;
  audioEndpoint = undefined;
  eventEndpoint = undefined;
  state = { ...state, status: "idle", stoppedAt: Date.now() };
  return { ok: true, ...summarize() };
}

async function startCapture(message: TabAudioMessage): Promise<Record<string, unknown>> {
  if (!message.streamId) throw new Error("tab-audio offscreen start requires streamId");
  if (recorder && recorder.state !== "inactive") await stopCapture();

  retainedMaxChunks = clampNumber(message.maxChunks, 1, 600, 120);
  chunks = [];
  seq = 0;
  audioEndpoint = typeof message.audioEndpoint === "string" && message.audioEndpoint.length > 0 ? message.audioEndpoint : undefined;
  eventEndpoint = typeof message.eventEndpoint === "string" && message.eventEndpoint.length > 0 ? message.eventEndpoint : undefined;
  const pcmSampleRate = clampNumber(message.pcmSampleRate, 8_000, 48_000, 16_000);
  const pcmChunkSamples = clampNumber(message.pcmChunkSamples, 320, 48_000, Math.round(pcmSampleRate * 0.12));
  pcmChunk = new Int16Array(pcmChunkSamples);
  pcmOffset = 0;

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  const capturedStream = await navigator.mediaDevices.getUserMedia(constraints);
  const selectedMimeType = pickMimeType(message.mimeType);
  const nextRecorder = new MediaRecorder(
    capturedStream,
    selectedMimeType ? { mimeType: selectedMimeType } : undefined,
  );

  nextRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size <= 0) return;
    chunks.push({
      seq: seq++,
      capturedAt: Date.now(),
      size: event.data.size,
      mimeType: event.data.type || nextRecorder.mimeType || selectedMimeType || "application/octet-stream",
      blob: event.data,
    });
    while (chunks.length > retainedMaxChunks) chunks.shift();
  });

  nextRecorder.addEventListener("error", (event) => {
    const message = (event as ErrorEvent).error?.message || "MediaRecorder error";
    state = {
      ...state,
      status: "error",
      lastError: message,
    };
    postCaptureEvent("tab_audio_capture_recorder_error", { message });
  });

  // Chrome tabCapture mutes local tab playback. Re-attach the captured stream so
  // the meeting remains audible to the user while the prototype recorder runs.
  const nextAudioContext = new AudioContext({ sampleRate: pcmSampleRate });
  const nextSourceNode = nextAudioContext.createMediaStreamSource(capturedStream);
  const nextProcessorNode = nextAudioContext.createScriptProcessor(4096, 1, 1);
  const nextMonitorGainNode = nextAudioContext.createGain();
  nextMonitorGainNode.gain.value = 0;
  nextProcessorNode.onaudioprocess = (event) => {
    enqueueFloat32(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate || nextAudioContext.sampleRate || pcmSampleRate);
  };
  nextSourceNode.connect(nextAudioContext.destination);
  nextSourceNode.connect(nextProcessorNode);
  nextProcessorNode.connect(nextMonitorGainNode);
  nextMonitorGainNode.connect(nextAudioContext.destination);

  const timesliceMs = clampNumber(message.timesliceMs, 250, 30_000, 1_000);
  stream = capturedStream;
  recorder = nextRecorder;
  audioContext = nextAudioContext;
  sourceNode = nextSourceNode;
  processorNode = nextProcessorNode;
  monitorGainNode = nextMonitorGainNode;
  state = {
    status: "recording",
    startedAt: Date.now(),
    tabId: message.tabId,
    tabTitle: message.tabTitle,
    tabUrl: message.tabUrl,
    mimeType: nextRecorder.mimeType || selectedMimeType,
    timesliceMs,
    audioEndpointConfigured: Boolean(audioEndpoint),
    eventEndpointConfigured: Boolean(eventEndpoint),
    pcmSampleRate,
    pcmChunkSamples,
    pcmChunksPosted: 0,
    pcmBytesPosted: 0,
  };

  postCaptureEvent("tab_audio_capture_started", {
    tabId: message.tabId,
    pcmSampleRate,
    pcmChunkSamples,
    mimeType: nextRecorder.mimeType || selectedMimeType,
  });
  nextRecorder.start(timesliceMs);
  return { ok: true, ...summarize() };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const batchSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    const batch = bytes.subarray(offset, offset + batchSize);
    binary += String.fromCharCode(...batch);
  }
  return btoa(binary);
}

async function drainCapture(message: TabAudioMessage): Promise<Record<string, unknown>> {
  if (recorder?.state === "recording") {
    recorder.requestData();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const includeBase64 = message.includeBase64 !== false;
  const maxBytes = clampNumber(message.maxBytes, 0, 50_000_000, 5_000_000);
  const maxChunks = clampNumber(message.maxChunks, 1, 600, chunks.length || 1);
  const selected: StoredChunk[] = [];
  let bytes = 0;

  for (const chunk of chunks.slice(0, maxChunks)) {
    if (includeBase64 && bytes + chunk.size > maxBytes) break;
    selected.push(chunk);
    bytes += chunk.size;
  }

  const drained = [];
  for (const chunk of selected) {
    drained.push({
      seq: chunk.seq,
      capturedAt: chunk.capturedAt,
      size: chunk.size,
      mimeType: chunk.mimeType,
      base64: includeBase64 ? await blobToBase64(chunk.blob) : undefined,
    });
  }

  if (message.clear !== false) {
    const drainedSeq = new Set(selected.map((chunk) => chunk.seq));
    chunks = chunks.filter((chunk) => !drainedSeq.has(chunk.seq));
  }

  return {
    ok: true,
    ...summarize(),
    drainedChunks: drained.length,
    drainedBytes: bytes,
    includeBase64,
    chunks: drained,
    truncated: selected.length < Math.min(maxChunks, chunks.length + selected.length),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

chrome.runtime.onMessage.addListener((message: TabAudioMessage, _sender, sendResponse) => {
  if (message?.type !== "WEBBRIDGE_TAB_AUDIO") return false;

  (async () => {
    try {
      if (message.action === "start") sendResponse(await startCapture(message));
      else if (message.action === "stop") sendResponse(await stopCapture());
      else if (message.action === "status") sendResponse({ ok: true, ...summarize() });
      else if (message.action === "drain") sendResponse(await drainCapture(message));
      else sendResponse({ ok: false, error: `Unsupported tab audio action: ${String(message.action)}` });
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      state = { ...state, status: "error", lastError: errorMessage };
      postCaptureEvent("tab_audio_capture_error", { message: errorMessage, requestedAction: message.action });
      sendResponse({ ok: false, error: errorMessage, ...summarize() });
    }
  })();

  return true;
});
