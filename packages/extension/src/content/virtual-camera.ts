// WebBridge Virtual ASCII Camera content script.
// Injected into meet.google.com at document_start in the MAIN world so it can
// monkey-patch navigator.mediaDevices before the page calls getUserMedia.
//
// Behavior: once armed, ANY getUserMedia({video: ...}) returns a live
// canvas-capture stream of an animated ASCII-art persona, while microphone
// audio (if requested) is still fetched from the real device, merged in, and
// tapped by an AnalyserNode to drive a reactive "listening" emote.
//
// Reactive emotes:
//   - idle      -> calm, slow blink (antennae relaxed)
//   - listening -> antennae perk UP, eyes wide (triggered by detected speech)
//   - thinking  -> animated thought bubble (dots), antennae wiggling
//   - speaking  -> mouth animates open/closed, antennae up
//   - muted     -> eyes x_x
// The explicit state (thinking/speaking/muted set by Agent Viso) always wins
// over auto-detected listening.

(() => {
  const GLOBAL_NAME = "__webbridgeVirtualCamera";
  const VERSION = "webbridge-virtual-camera-v3";
  const DEVICE_ID = "webbridge-virtual-ascii-camera";
  const DEVICE_LABEL = "Viso ASCII Cam";

  const existing = (window as any)[GLOBAL_NAME];
  if (existing?.version === VERSION && existing.stopped !== true) {
    existing.note?.("virtual_camera_reused", { href: location.href });
    return;
  }

  type VirtualCameraState = "idle" | "thinking" | "speaking" | "muted";
  type EmoteState = VirtualCameraState | "listening";

  interface VirtualCameraStateInternal {
    version: string;
    stopped: boolean;
    armed: boolean;
    state: VirtualCameraState; // explicit state set by Agent Viso
    emote: EmoteState; // effective displayed emote (may include auto "listening")
    persona: string;
    name: string;
    mirror: boolean;
    fps: number;
    frame: number;
    detectedSpeech: boolean;
    audioLevel: number;
    lastError?: string;
    lastEvent: string;
    streamActive: boolean;
    requestedCount: number;
  }

  const state: VirtualCameraStateInternal = {
    version: VERSION,
    stopped: false,
    armed: false,
    state: "idle",
    emote: "idle",
    persona: "zob",
    name: "Zob",
    mirror: true,
    fps: 15,
    frame: 0,
    detectedSpeech: false,
    audioLevel: 0,
    lastEvent: "initializing",
    streamActive: false,
    requestedCount: 0,
  };

  // --- logging ---
  function note(type: string, detail: Record<string, unknown> = {}) {
    state.lastEvent = type;
    console.log(`[WebBridge VirtualCamera] ${type}`, detail);
  }
  function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  function fail(type: string, error: unknown, detail: Record<string, unknown> = {}) {
    const message = errMsg(error);
    state.lastError = message;
    note(type, { message, ...detail });
  }

  // --- canvas / animation ---
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let rafId: number | null = null;
  let stream: MediaStream | null = null;

  // Audio analysis for the "listening" emote.
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserBuffer: Uint8Array<ArrayBuffer> | null = null;
  let speechEnvelope = 0; // smoothed RMS envelope

  // Frames are arrays of line strings. All states share a consistent body so
  // the only things that move are the antennae, eyes, mouth, and (for
  // thinking) a thought bubble.
  const PERSONAS: Record<string, Record<EmoteState, string[][]>> = {
    zob: {
      idle: [
        [
          "    .           .    ",
          "    |           |    ",
          "  +---------------+  ",
          "  |      ^_^      |  ",
          "  |     [_____]    |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
        [
          "    .           .    ",
          "    |           |    ",
          "  +---------------+  ",
          "  |      -_-      |  ",
          "  |     [_____]    |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
      ],
      // Detected speech: antennae perk straight up, eyes wide open, listening.
      listening: [
        [
          "    /\\         /\\    ",
          "   o  \\       /  o   ",
          "  >---------------<  ",
          "  |      O O      |  ",
          "  |     [_____]    |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
        [
          "   /\\           /\\   ",
          "  o  \\         /  o  ",
          "  >---------------<  ",
          "  |      O O      |  ",
          "  |     [_____]    |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
      ],
      // Thinking: thought bubble top-right with animated dots, antennae wiggle.
      thinking: [
        [
          "   ~             .    ",
          "    \\            |    ",
          "  +---------------+   .",
          "  |     o_o?      |   '",
          "  |    [~___~]     |   ",
          "  +---------------+   ",
          "        |   |         ",
          "      /       \\       ",
          "     /         \\      ",
        ],
        [
          "   ~             .    ",
          "    \\            |    ",
          "  +---------------+  .",
          "  |     o_o?      |  '",
          "  |    [~___~]     |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
        [
          "   ~             .    ",
          "    \\            |    ",
          "  +---------------+ .  ",
          "  |     o_o?      | '  ",
          "  |    [~___~]     |   ",
          "  +---------------+   ",
          "        |   |         ",
          "      /       \\       ",
          "     /         \\      ",
        ],
      ],
      // Speaking: mouth animates, antennae up.
      speaking: [
        [
          "    /\\         /\\    ",
          "   o  o       o  o   ",
          "  +---------------+  ",
          "  |      O O      |  ",
          "  |     [====]     |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
        [
          "    /\\         /\\    ",
          "   o  o       o  o   ",
          "  +---------------+  ",
          "  |      O O      |  ",
          "  |     [    ]     |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
        [
          "    /\\         /\\    ",
          "   o  o       o  o   ",
          "  +---------------+  ",
          "  |      O_O      |  ",
          "  |     [-__-]     |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
      ],
      muted: [
        [
          "    .           .    ",
          "    |           |    ",
          "  +---------------+  ",
          "  |      x_x      |  ",
          "  |     [     ]    |  ",
          "  +---------------+  ",
          "        |   |        ",
          "      /       \\      ",
          "     /         \\     ",
        ],
      ],
    },
  };

  function getFrames(emote: EmoteState): string[][] {
    const persona = PERSONAS[state.persona] ?? PERSONAS.zob;
    return persona[emote] ?? persona.idle;
  }

  function computeEmote(): EmoteState {
    // Explicit states always win. Otherwise auto-detect "listening" from mic.
    if (state.state === "thinking") return "thinking";
    if (state.state === "speaking") return "speaking";
    if (state.state === "muted") return "muted";
    return state.detectedSpeech ? "listening" : "idle";
  }

  function measureAudio() {
    if (!analyser || !analyserBuffer) return;
    analyser.getByteTimeDomainData(analyserBuffer as Uint8Array<ArrayBuffer>);
    let sumSq = 0;
    for (let i = 0; i < analyserBuffer.length; i += 1) {
      const v = (analyserBuffer[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / analyserBuffer.length);
    state.audioLevel = rms;
    // Smooth attack/fast release so the emote feels responsive but not jittery.
    if (rms > 0.035) {
      speechEnvelope = Math.max(speechEnvelope, rms);
    } else {
      speechEnvelope = Math.max(0, speechEnvelope - 0.012);
    }
    const wasSpeech = state.detectedSpeech;
    state.detectedSpeech = speechEnvelope > 0.05;
    if (wasSpeech !== state.detectedSpeech) {
      note("virtual_camera_speech_detected", { speaking: state.detectedSpeech, rms });
    }
  }

  function renderFrame() {
    if (!canvas || !ctx) return;
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    state.emote = computeEmote();
    const frames = getFrames(state.emote);
    const ticksPerFrame = Math.max(1, Math.round(60 / state.fps));
    const frameIndex = Math.floor(state.frame / ticksPerFrame) % frames.length;
    const lines = frames[frameIndex];

    // Horizontal mirror so Meet's self-view mirror cancels out -> readable.
    if (state.mirror) {
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }

    const fontSize = 26;
    const lineHeight = fontSize + 6;
    ctx.fillStyle = "#10b981";
    ctx.font = `${fontSize}px "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const totalHeight = lines.length * lineHeight;
    let y = (height - totalHeight) / 2 + lineHeight / 2;
    for (const line of lines) {
      ctx.fillText(line, width / 2, y);
      y += lineHeight;
    }

    if (state.mirror) {
      ctx.restore();
    }

    // Status label (drawn un-mirrored so it stays readable).
    const labelColor: Record<EmoteState, string> = {
      idle: "#9ca3af",
      listening: "#34d399",
      thinking: "#f59e0b",
      speaking: "#3b82f6",
      muted: "#ef4444",
    };
    ctx.fillStyle = labelColor[state.emote];
    ctx.font = '16px "Courier New", monospace';
    ctx.textAlign = "left";
    ctx.fillText(`${state.name} • ${state.emote}`, 16, height - 18);

    // Audio meter on the right (small reactive bar).
    if (analyser) {
      const meterW = Math.min(120, Math.round(state.audioLevel * 800));
      ctx.fillStyle = "rgba(148,163,184,0.25)";
      ctx.fillRect(width - 16 - 120, height - 26, 120, 6);
      ctx.fillStyle = state.detectedSpeech ? "#34d399" : "#64748b";
      ctx.fillRect(width - 16 - 120, height - 26, Math.max(2, meterW), 6);
    }

    // Status dot.
    ctx.fillStyle = labelColor[state.emote];
    ctx.beginPath();
    ctx.arc(width - 18, 18, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    canvas.style.display = "none";
    (document.body || document.documentElement).appendChild(canvas);
    ctx = canvas.getContext("2d");
    note("virtual_camera_canvas_created", { width: canvas.width, height: canvas.height });
  }

  function startLoop() {
    if (rafId != null) return;
    let last = performance.now();
    function tick(now: number) {
      if (state.stopped) return;
      if (now - last >= 1000 / state.fps) {
        state.frame += 1;
        measureAudio();
        renderFrame();
        last = now;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function getOrCreateStream(): MediaStream {
    ensureCanvas();
    if (!canvas) throw new Error("Virtual camera canvas not available");
    startLoop();
    renderFrame();
    if (!stream) {
      stream = canvas.captureStream(state.fps);
      state.streamActive = true;
      note("virtual_camera_stream_created", { tracks: stream.getVideoTracks().length });
    }
    return stream;
  }

  // Tap the real mic stream to drive the listening emote.
  function attachAudioAnalyzer(micStream: MediaStream) {
    try {
      const tracks = micStream.getAudioTracks();
      if (tracks.length === 0) return;
      if (!audioCtx) {
        const Ctor: typeof AudioContext =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return;
        audioCtx = new Ctor();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      // Re-use a single analyser; disconnect previous source if any.
      if (!analyser) {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        analyserBuffer = new Uint8Array(analyser.fftSize);
      }
      const source = audioCtx.createMediaStreamSource(new MediaStream(tracks));
      source.connect(analyser);
      note("virtual_camera_audio_analyzer_attached", { tracks: tracks.length });
    } catch (error) {
      note("virtual_camera_audio_analyzer_failed", { message: errMsg(error) });
    }
  }

  // --- MediaDevices monkey patch ---
  function installMediaDevicesPatch() {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) {
      note("virtual_camera_no_mediadevices");
      return false;
    }

    const originalEnumerateDevices = mediaDevices.enumerateDevices.bind(mediaDevices);
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

    if ((originalGetUserMedia as any).__webbridgeVirtualCameraWrapped) {
      note("virtual_camera_already_wrapped");
      return true;
    }

    mediaDevices.enumerateDevices = async function enumerateDevices() {
      try {
        const devices = await originalEnumerateDevices();
        if (state.armed) {
          const hasVirtual = devices.some((d) => d.deviceId === DEVICE_ID);
          if (!hasVirtual) {
            const virtual: MediaDeviceInfo = {
              deviceId: DEVICE_ID,
              groupId: "webbridge-virtual-camera-group",
              kind: "videoinput",
              label: DEVICE_LABEL,
              toJSON: () => ({
                deviceId: DEVICE_ID,
                groupId: "webbridge-virtual-camera-group",
                kind: "videoinput",
                label: DEVICE_LABEL,
              }),
            } as unknown as MediaDeviceInfo;
            return [...devices, virtual];
          }
        }
        return devices;
      } catch (error) {
        fail("virtual_camera_enumerate_devices_failed", error);
        throw error;
      }
    };
    (mediaDevices.enumerateDevices as any).__webbridgeVirtualCameraWrapped = true;

    // KEY: when armed, intercept EVERY getUserMedia that requests video and
    // return our canvas stream, regardless of which deviceId Meet asks for.
    // Microphone audio (if requested) is fetched from the real device, merged
    // in, and tapped to drive the listening emote.
    mediaDevices.getUserMedia = async function getUserMedia(constraints?: MediaStreamConstraints) {
      try {
        const videoRequested =
          !!constraints && constraints.video !== undefined && constraints.video !== false;

        if (state.armed && videoRequested) {
          state.requestedCount += 1;
          note("virtual_camera_selected", { requestedCount: state.requestedCount });

          const baseStream = getOrCreateStream();
          const clonedVideo = baseStream.getVideoTracks().map((t) => t.clone());

          const audioRequested =
            !!constraints && constraints.audio !== undefined && constraints.audio !== false;
          let audioTracks: MediaStreamTrack[] = [];
          if (audioRequested) {
            try {
              const realAudio = await originalGetUserMedia({
                audio: constraints.audio,
                video: false,
              });
              audioTracks = realAudio.getAudioTracks();
              attachAudioAnalyzer(realAudio);
              note("virtual_camera_audio_passthrough_ok", { audioTracks: audioTracks.length });
            } catch (audioError) {
              note("virtual_camera_audio_passthrough_failed", { message: errMsg(audioError) });
            }
          }

          return new MediaStream([...clonedVideo, ...audioTracks]);
        }

        return await originalGetUserMedia(constraints);
      } catch (error) {
        fail("virtual_camera_get_user_media_failed", error, { armed: state.armed });
        throw error;
      }
    };
    (mediaDevices.getUserMedia as any).__webbridgeVirtualCameraWrapped = true;

    note("virtual_camera_patch_installed");
    return true;
  }

  function dispatchDeviceChange() {
    try {
      navigator.mediaDevices?.dispatchEvent(new Event("devicechange"));
    } catch {
      // ignore
    }
  }

  function arm(options: { persona?: string; name?: string; fps?: number; mirror?: boolean } = {}) {
    if (options.name) state.name = options.name;
    if (options.mirror !== undefined) state.mirror = options.mirror;
    if (state.armed) {
      renderFrame();
      dispatchDeviceChange();
      return true;
    }
    state.armed = true;
    if (options.persona) state.persona = options.persona;
    if (options.fps) state.fps = Math.max(5, Math.min(30, options.fps));
    const ok = installMediaDevicesPatch();
    if (ok) {
      getOrCreateStream();
      dispatchDeviceChange();
      note("virtual_camera_armed", {
        persona: state.persona,
        name: state.name,
        fps: state.fps,
        mirror: state.mirror,
      });
    }
    return ok;
  }

  function setState(newState: VirtualCameraState) {
    state.state = newState;
    state.frame = 0;
    renderFrame();
    note("virtual_camera_state_changed", { state: newState, persona: state.persona });
  }

  function stop() {
    state.stopped = true;
    stopLoop();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (canvas) {
      canvas.remove();
      canvas = null;
      ctx = null;
    }
    note("virtual_camera_stopped");
  }

  function stats() {
    return {
      ...state,
      streamTracks: stream?.getTracks().length ?? 0,
      analyserActive: !!analyser,
    };
  }

  (window as any)[GLOBAL_NAME] = {
    version: VERSION,
    arm,
    setState,
    stop,
    stats,
    note,
    fail,
  };

  note("virtual_camera_content_script_ready", { href: location.href });
})();
