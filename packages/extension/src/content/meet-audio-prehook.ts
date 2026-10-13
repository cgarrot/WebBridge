(() => {
  const GLOBAL_NAME = "__webbridgeMeetAudioPrehook";
  const VERSION = "webbridge-meet-audio-prehook-v1";

  const existing = (window as any)[GLOBAL_NAME];
  if (existing?.version === VERSION && existing.stopped !== true) {
    existing.note?.("prehook_reused", { href: location.href, readyState: document.readyState });
    return;
  }

  const peerConnections: RTCPeerConnection[] = [];
  const peerConnectionIds = new WeakMap<RTCPeerConnection, number>();
  const events: Array<Record<string, unknown>> = [];
  const state = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    stopped: false,
    constructorHookInstalled: false,
    prototypeHookInstalled: false,
    rtcHookInstalled: false,
    peerConnectionCount: 0,
    receiverAudioTrackCount: 0,
    lastEvent: "initializing",
    lastError: undefined as string | undefined,
  };

  function note(type: string, detail: Record<string, unknown> = {}) {
    state.lastEvent = type;
    const event = { type, at: new Date().toISOString(), href: location.href, readyState: document.readyState, ...detail };
    events.push(event);
    if (events.length > 200) events.splice(0, events.length - 200);
  }

  function fail(type: string, error: unknown, detail: Record<string, unknown> = {}) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    note(type, { message, ...detail });
  }

  function summarizeRtcConfig(config: unknown) {
    if (!config || typeof config !== "object") return undefined;
    const record = config as RTCConfiguration;
    const iceServers = Array.isArray(record.iceServers)
      ? record.iceServers.slice(0, 8).map((server) => ({
        urls: Array.isArray(server.urls) ? server.urls.slice(0, 8) : server.urls,
      }))
      : undefined;
    return {
      bundlePolicy: record.bundlePolicy,
      iceTransportPolicy: record.iceTransportPolicy,
      rtcpMuxPolicy: record.rtcpMuxPolicy,
      iceServers,
    };
  }

  function describeTrack(track: MediaStreamTrack | null | undefined, source: string, detail: Record<string, unknown> = {}) {
    return {
      source,
      id: track?.id,
      label: track?.label,
      kind: track?.kind,
      muted: track?.muted,
      enabled: track?.enabled,
      readyState: track?.readyState,
      ...detail,
    };
  }

  function scanReceivers(pc: RTCPeerConnection, reason = "scan") {
    const pcId = peerConnectionIds.get(pc);
    let receivers: RTCRtpReceiver[] = [];
    try {
      receivers = typeof pc.getReceivers === "function" ? pc.getReceivers() : [];
    } catch (error) {
      fail("prehook_get_receivers_failed", error, { pcId, reason });
      return;
    }
    const audioTracks = receivers
      .map((receiver, receiverIndex) => ({ receiverIndex, track: receiver.track }))
      .filter((entry) => entry.track?.kind === "audio");
    if (audioTracks.length > 0) {
      state.receiverAudioTrackCount = audioTracks.length;
      note("prehook_audio_receivers_seen", {
        pcId,
        reason,
        tracks: audioTracks.map((entry) => describeTrack(entry.track, "prehook-receiver", { receiverIndex: entry.receiverIndex })),
      });
    }
  }

  function hookPeerConnection(pc: RTCPeerConnection, reason: string, config?: unknown) {
    if (!pc || peerConnectionIds.has(pc)) return peerConnectionIds.get(pc);
    const pcId = peerConnections.length + 1;
    peerConnectionIds.set(pc, pcId);
    peerConnections.push(pc);
    state.peerConnectionCount = peerConnections.length;
    note("prehook_peer_connection_hooked", { pcId, reason, config: summarizeRtcConfig(config) });
    try {
      pc.addEventListener("track", (event) => {
        const track = event.track;
        if (track?.kind !== "audio") return;
        const streams = Array.from(event.streams || []).map((stream) => ({
          id: stream.id,
          active: stream.active,
          audioTrackIds: stream.getAudioTracks().map((item) => item.id),
        }));
        note("prehook_webrtc_ontrack", { pcId, track: describeTrack(track, "prehook-ontrack", { streams }) });
      });
    } catch (error) {
      fail("prehook_track_listener_failed", error, { pcId });
    }
    setTimeout(() => scanReceivers(pc, reason), 0);
    return pcId;
  }

  function installPeerConnectionHook() {
    const Original = window.RTCPeerConnection || (window as any).webkitRTCPeerConnection;
    if (typeof Original !== "function" || !Original.prototype) {
      note("prehook_webrtc_unavailable");
      return false;
    }

    try {
      const Wrapped = new Proxy(Original, {
        construct(target, args: unknown[]) {
          const pc = Reflect.construct(target, args) as RTCPeerConnection;
          hookPeerConnection(pc, "constructor", args[0]);
          return pc;
        },
      });
      Wrapped.prototype = Original.prototype;
      if (window.RTCPeerConnection === Original) window.RTCPeerConnection = Wrapped as typeof RTCPeerConnection;
      if ((window as any).webkitRTCPeerConnection === Original) (window as any).webkitRTCPeerConnection = Wrapped;
      state.constructorHookInstalled = true;
    } catch (error) {
      fail("prehook_constructor_hook_failed", error);
    }

    try {
      const originalSetRemoteDescription = Original.prototype.setRemoteDescription;
      if (typeof originalSetRemoteDescription === "function" && !(originalSetRemoteDescription as any).__webbridgeMeetPrehookWrapped) {
        Original.prototype.setRemoteDescription = function(this: RTCPeerConnection, ...args: unknown[]) {
          hookPeerConnection(this, "setRemoteDescription-before");
          const result = originalSetRemoteDescription.apply(this, args as any);
          Promise.resolve(result)
            .then(() => setTimeout(() => scanReceivers(this, "setRemoteDescription-after"), 0))
            .catch(() => undefined);
          return result;
        };
        (Original.prototype.setRemoteDescription as any).__webbridgeMeetPrehookWrapped = true;
        state.prototypeHookInstalled = true;
      }
    } catch (error) {
      fail("prehook_set_remote_description_hook_failed", error);
    }

    try {
      const originalAddEventListener = Original.prototype.addEventListener;
      if (typeof originalAddEventListener === "function" && !(originalAddEventListener as any).__webbridgeMeetPrehookWrapped) {
        Original.prototype.addEventListener = function(this: RTCPeerConnection, type: string, ...args: unknown[]) {
          if (type === "track") hookPeerConnection(this, "addEventListener(track)");
          return (originalAddEventListener as any).apply(this, [type, ...args]);
        };
        (Original.prototype.addEventListener as any).__webbridgeMeetPrehookWrapped = true;
        state.prototypeHookInstalled = true;
      }
    } catch (error) {
      fail("prehook_add_event_listener_hook_failed", error);
    }

    state.rtcHookInstalled = state.constructorHookInstalled || state.prototypeHookInstalled;
    note("prehook_installed", {
      constructorHookInstalled: state.constructorHookInstalled,
      prototypeHookInstalled: state.prototypeHookInstalled,
      rtcHookInstalled: state.rtcHookInstalled,
    });
    return state.rtcHookInstalled;
  }

  installPeerConnectionHook();

  const interval = setInterval(() => {
    if (state.stopped) return;
    for (const pc of peerConnections) scanReceivers(pc, "periodic");
  }, 1000);

  (window as any)[GLOBAL_NAME] = {
    version: VERSION,
    note,
    state,
    peerConnections,
    getPeerConnections: () => peerConnections.slice(),
    drain: () => events.splice(0, events.length),
    stats: () => ({
      ...state,
      queuedEvents: events.length,
      peerConnectionCount: peerConnections.length,
    }),
    stop: () => {
      state.stopped = true;
      clearInterval(interval);
      note("prehook_stopped");
      return { ok: true, stopped: true, peerConnectionCount: peerConnections.length };
    },
  };
})();
