/** STAGING DRAFT — native scroll & media behavior primitives (ticket 2F).
 *
 * Self-contained trusted read/act expression builders for bounded scroll and
 * ordinary HTMLVideoElement/HTMLAudioElement playback, following the frozen
 * shape of native-text.ts / native-commit.ts:
 *   - opaque ids share the Symbol.for('webbridge.visible-dom.v2') WeakMap
 *     document registry (same state, same prefix, same idOf semantics);
 *   - identity = document_ref + url + native tag/name/owner scope (+ observed
 *     media source); the mutable data-wb-id attribute is only a candidate
 *     locator and is never trusted on its own;
 *   - one Runtime.evaluate per action, absolute epoch-ms deadline validated
 *     and re-checked synchronously at the last native action, exactly ONE
 *     native prototype call, no retries, no rollback, no raw CDP;
 *   - honest statuses only: a scroll ACK never claims feed coverage and a
 *     play() promise fulfillment is never proof — proof is a fresh, guarded
 *     read (nativeScrollReadExpression / nativeMediaReadExpression);
 *   - public model facts and these private native bindings stay separate;
 *     labels alone never authenticate a scope or a media identity.
 *
 * Scroll outcomes are exact: moved / already_at_end / no_progress
 * (supported refusals are 'unsupported') / effect_unknown. scrollHeight is a
 * transient fact: virtual-feed completeness is never inferred from it.
 *
 * Media: ordinary VIDEO/AUDIO elements only; explicit desired state
 * 'playing' | 'paused' via HTMLMediaElement.prototype play/pause with a
 * native-code check; programmatic dispatch keeps isTrusted semantics out of
 * scope (dispatch.programmatic === true, user_gesture === false is recorded);
 * the play() await is bounded by the absolute deadline and a small await cap,
 * so the expression always settles — a host abort around the await discards
 * the late result and MUST classify it effect_unknown (never not_executed).
 *
 * No third-party deps. Node 22 strip-types compatible (no parameter
 * properties). Root integration: copy into WebBridge packages/shared/src and
 * switch the single import to './native-text.js' (or '@webbridge/shared').
 * NOTHING here is admitted into any wire/provider version until root says so. */
import { NATIVE_TEXT_DOM_HELPERS } from './native-text.js';

// ─────────────────────────────────────────────────────────────────────────────
// Versioned private contracts (new, additive; no existing version touched)
// ─────────────────────────────────────────────────────────────────────────────

/** Identity of a scroll scope. Geometry is deliberately NOT part of identity:
 * content grows and shrinks legitimately between capture and action. */
export interface NativeScrollContainerFact {
  id: string; tag: string; label: string; name_source: string; role: string; dom_id: string;
  owner: { id: string; label: string; role: string; dom_id: string; source: string } | null;
}
export interface NativeScrollBinding {
  schema: 'native-scroll-binding/1.0';
  document_ref: string; url: string;
  scope_kind: 'document' | 'container';
  container: NativeScrollContainerFact | null; // null ⇔ scope_kind 'document'
}
export type ScrollDirection = 'down' | 'up';
/** moved | already_at_end | no_progress carry objective offset facts;
 * 'unsupported' is a refusal outcome paired with status 'not_executed';
 * 'effect_unknown' admits the offset could not be honestly determined. */
export type ScrollOutcome = 'moved' | 'already_at_end' | 'no_progress' | 'unsupported' | 'effect_unknown';
export interface NativeScrollGeometry { scroll_top: number; scroll_height: number; client_height: number }
export interface NativeScrollResult {
  schema: 'native-scroll-result/1.0';
  status: 'executed' | 'not_executed' | 'effect_unknown';
  outcome: ScrollOutcome;
  reason?: string;
  cause?: string;
  scope_kind: 'document' | 'container';
  direction: ScrollDirection;
  dispatched: boolean;                 // exactly one native scrollBy attempted
  before?: NativeScrollGeometry;
  after?: NativeScrollGeometry;
  delta?: number;
  at?: 'start' | 'end';                // boundary fact for already_at_end
  /** No content/feed coverage is claimed — offset delta facts only. */
  claim: 'offset_delta_only';
}
export interface NativeScrollScopeObservation {
  schema: 'native-scroll-scope/1.0';
  scope_kind: 'document' | 'container';
  id: string | null;                   // null for the document scope
  tag: string; label: string; name_source: string; role: string; dom_id: string;
  owner: NativeScrollContainerFact['owner'];
  scrollable: boolean; rendered: boolean;
  overflow_y: string;
  scroll_top: number; scroll_height: number; client_height: number;
}
export interface NativeScrollScopesResult {
  schema: 'native-scroll-scopes/1.0';
  document_ref: string; url: string;
  document: NativeScrollScopeObservation | null;
  containers: NativeScrollScopeObservation[];
  scanned: number;                     // elements examined before the scan bound
  truncated: boolean;                  // honest: more scopes existed than reported
}
export interface NativeScrollRead {
  schema: 'native-scroll-read/1.0';
  ok: boolean;
  reason?: string;
  document_ref: string | null; url: string | null;
  binding_matches: boolean;
  scope_kind: 'document' | 'container' | null;
  identity: NativeScrollContainerFact | null;
  offset: NativeScrollGeometry | null;
  overflow_y: string | null;
  rendered: boolean | null;
  at_start: boolean | null; at_end: boolean | null;
}

/** Identity of an observed media element. currentSrc/src ARE identity: a
 * source change invalidates the binding (harness re-observes; never rebinds
 * silently). Playback state (paused/ended/readyState) is NOT identity. */
export interface NativeMediaFact {
  id: string; tag: 'video' | 'audio'; label: string; name_source: string; role: string; dom_id: string;
  owner: NativeScrollContainerFact['owner'];
}
export interface NativeMediaBinding {
  schema: 'native-media-binding/1.0';
  document_ref: string; url: string;
  media: NativeMediaFact;
  source: { current_src: string; src_attr: string };
}
export type MediaDesired = 'playing' | 'paused';
export interface NativeMediaState {
  paused: boolean; ended: boolean; ready_state: number; current_src: string;
  current_time?: number; playback_rate?: number;
  muted?: boolean; rendered?: boolean; connected?: boolean;
}
export interface NativeMediaResult {
  schema: 'native-media-result/1.0';
  status: 'executed' | 'not_executed' | 'effect_unknown';
  outcome: 'reached' | 'not_reached' | 'unsupported' | 'effect_unknown';
  reason?: string;
  cause?: string;
  desired: MediaDesired;
  dispatched: boolean;                 // a native play()/pause() call happened
  dispatch: { method: 'play' | 'pause' | null; programmatic: true; user_gesture: false };
  promise: 'fulfilled' | 'no_promise' | 'sync' | 'already' | 'timeout' | string; // 'rejected:<Name>'
  before?: NativeMediaState;
  after?: NativeMediaState;
}
export interface NativeMediaObservation {
  schema: 'native-media/1.0';
  id: string; tag: 'video' | 'audio';
  label: string; name_source: string; role: string; dom_id: string;
  owner: NativeScrollContainerFact['owner'];
  source: { current_src: string; src_attr: string };
  paused: boolean; ended: boolean; ready_state: number; muted: boolean;
  rendered: boolean; connected: boolean;
}
export interface NativeMediaObserveResult {
  schema: 'native-media-observation/1.0';
  document_ref: string; url: string;
  total: number; truncated: boolean;
  media: NativeMediaObservation[];
}
export interface NativeMediaRead {
  schema: 'native-media-read/1.0';
  ok: boolean;
  reason?: string;
  document_ref: string | null; url: string | null;
  binding_matches: boolean;
  identity: NativeMediaFact | null;
  source_matches: boolean | null;
  state: NativeMediaState | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Host-side transport validators (mirrors side-tools validTextBinding style:
// only shape; actual identity/state is always rechecked inside the page).
// ─────────────────────────────────────────────────────────────────────────────

const SCROLL_OWNER_FIELDS = ['id', 'label', 'role', 'dom_id', 'source'] as const;
const CONTAINER_FIELDS = ['id', 'tag', 'label', 'name_source', 'role', 'dom_id'] as const;
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;
const ownerShape = (o: unknown): boolean => o === null || !!o && typeof o === 'object'
  && SCROLL_OWNER_FIELDS.every(k => str((o as Record<string, unknown>)[k], 1024));

export function validScrollBinding(binding: unknown, nodeId: string | null): binding is NativeScrollBinding {
  const b = binding as NativeScrollBinding | null;
  if (!b || typeof b !== 'object' || b.schema !== 'native-scroll-binding/1.0'
    || !str(b.document_ref, 256) || !str(b.url, 8192)) return false;
  if (b.scope_kind === 'document') return b.container === null && nodeId === null;
  if (b.scope_kind !== 'container' || nodeId === null) return false;
  const c = b.container;
  return !!c && typeof c === 'object' && CONTAINER_FIELDS.every(k => str(c[k], 1024)) && c.id !== '' && c.id===nodeId
    && ownerShape(c.owner);
}
export function validMediaBinding(binding: unknown, nodeId: string): binding is NativeMediaBinding {
  const b = binding as NativeMediaBinding | null;
  if (!b || typeof b !== 'object' || b.schema !== 'native-media-binding/1.0'
    || !str(b.document_ref, 256) || !str(b.url, 8192)) return false;
  const m = b.media;
  if (!m || typeof m !== 'object' || m.id !== nodeId || !CONTAINER_FIELDS.every(k => str(m[k], 1024)) || m.id === ''
    || (m.tag !== 'video' && m.tag !== 'audio') || !ownerShape(m.owner)) return false;
  const s = b.source;
  return !!s && typeof s === 'object' && str(s.current_src, 8192) && str(s.src_attr, 8192);
}
export function validScrollActResult(v: unknown): v is NativeScrollResult {
  const r = v as NativeScrollResult | null;
  return !!r && typeof r === 'object' && r.schema === 'native-scroll-result/1.0'
    && ['executed', 'not_executed', 'effect_unknown'].includes(r.status)
    && ['moved', 'already_at_end', 'no_progress', 'unsupported', 'effect_unknown'].includes(r.outcome)
    && (r.outcome !== 'unsupported' || r.status === 'not_executed')
    && (r.outcome !== 'effect_unknown' || r.status === 'effect_unknown')
    && ['moved', 'already_at_end', 'no_progress'].includes(r.outcome) === (r.status === 'executed')
    && typeof r.dispatched === 'boolean' && (r.dispatched || r.status !== 'executed' || r.outcome === 'already_at_end')
    && ['document','container'].includes(r.scope_kind) && ['down','up'].includes(r.direction)
    && r.claim === 'offset_delta_only'
    && (r.status!=='executed'||validGeometry(r.before)&&validGeometry(r.after)&&Number.isFinite(r.delta)
      && Math.abs(r.delta!-(r.after!.scroll_top-r.before!.scroll_top))<0.0001
      && (r.outcome==='moved'?(r.direction==='down'?r.delta!>0:r.delta!<0):r.outcome==='no_progress'?(r.direction==='down'?r.delta!<=0:r.delta!>=0):r.delta===0&&r.at===(r.direction==='down'?'end':'start')&&!r.dispatched));
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validGeometry=(v:unknown):v is NativeScrollGeometry=>object(v)&&['scroll_top','scroll_height','client_height'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k]))&&Number(v.scroll_height)>=0&&Number(v.client_height)>0;
const validState=(v:unknown):v is NativeMediaState=>object(v)&&typeof v.paused==='boolean'&&typeof v.ended==='boolean'&&Number.isInteger(v.ready_state)&&Number(v.ready_state)>=0&&Number(v.ready_state)<=4&&str(v.current_src,8192);
const validFact=(v:unknown):boolean=>object(v)&&CONTAINER_FIELDS.every(k=>str(v[k],1024))&&v.id!==''&&ownerShape(v.owner);
export function validScrollReadResult(v: unknown): v is NativeScrollRead {
  const r = v as NativeScrollRead | null;
  return !!r && typeof r === 'object' && r.schema === 'native-scroll-read/1.0' && typeof r.ok === 'boolean'
    && typeof r.binding_matches === 'boolean'
    && (r.ok ? r.binding_matches&&str(r.document_ref,256)&&r.document_ref!==''&&str(r.url,8192)
      && ['document','container'].includes(r.scope_kind??'')&&(r.scope_kind==='document'?r.identity===null:validFact(r.identity))
      && validGeometry(r.offset)&&r.rendered===true&&typeof r.overflow_y==='string'
      && r.at_start===(r.offset.scroll_top<=0)&&r.at_end===(r.offset.scroll_top>=Math.max(0,r.offset.scroll_height-r.offset.client_height))
      : r.offset === null);
}
export function validMediaActResult(v: unknown): v is NativeMediaResult {
  const r = v as NativeMediaResult | null;
  return !!r && typeof r === 'object' && r.schema === 'native-media-result/1.0'
    && ['executed', 'not_executed', 'effect_unknown'].includes(r.status)
    && ['reached', 'not_reached', 'unsupported', 'effect_unknown'].includes(r.outcome)
    && (r.outcome !== 'unsupported' || r.status === 'not_executed')
    && (r.outcome !== 'effect_unknown' || r.status === 'effect_unknown')
    && ['reached', 'not_reached'].includes(r.outcome) === (r.status === 'executed')
    && typeof r.dispatched === 'boolean' && ['playing','paused'].includes(r.desired)
    && object(r.dispatch)&&r.dispatch.programmatic===true&&r.dispatch.user_gesture===false
    && (r.dispatch.method===null||r.dispatch.method===(r.desired==='playing'?'play':'pause'))
    && (r.status!=='executed'||validState(r.before)&&validState(r.after));
}
export function validMediaReadResult(v: unknown): v is NativeMediaRead {
  const r = v as NativeMediaRead | null;
  return !!r && typeof r === 'object' && r.schema === 'native-media-read/1.0' && typeof r.ok === 'boolean'
    && typeof r.binding_matches === 'boolean' && (r.ok ? r.binding_matches&&r.source_matches===true
      && str(r.document_ref,256)&&r.document_ref!==''&&str(r.url,8192)&&validFact(r.identity)
      && validState(r.state)&&['video','audio'].includes(r.identity!.tag)&&typeof r.state.connected==='boolean'&&typeof r.state.rendered==='boolean' : r.state === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavior DOM helpers. Built ON NATIVE_TEXT_DOM_HELPERS (no duplication):
// the WeakMap state installed by the visible-dom observer is authoritative.
// ─────────────────────────────────────────────────────────────────────────────

const BEHAVIOR_DOM_HELPERS = `
  const wbBehKey = () => Symbol.for('webbridge.visible-dom.v2');
  const wbBehState = () => window[wbBehKey()];
  const wbBehIdOf = el => { let s = wbBehState();
    if (!s || !s.ids || typeof s.prefix !== 'string') { s = { ids: new WeakMap(), next: 0, prefix: 'n-' + crypto.randomUUID() }; window[wbBehKey()] = s; }
    let id = s.ids.get(el); if (!id) { id = s.prefix + '-' + (++s.next); s.ids.set(el, id); }
    if (el.getAttribute('data-wb-id') !== id) el.setAttribute('data-wb-id', id);
    return id; };
  const wbBehObservedId = el => { const s = wbBehState(); const id = s && s.ids ? s.ids.get(el) : null; return typeof id === 'string' ? id : null; };
  const wbBehById = id => { const s = wbBehState(); if (!s || !s.ids || typeof id !== 'string' || id === '') return null;
    for (const el of document.querySelectorAll('[data-wb-id]')) if (s.ids.get(el) === id) return el;
    return null; };
  const wbBehDocState = expected => { const s = wbBehState();
    if (!s || !s.ids || typeof s.prefix !== 'string' || s.prefix === '') return 'behavior_document_unobserved';
    if (s.prefix !== expected.document_ref) return 'behavior_document_ref_changed';
    if (window.location.href !== expected.url) return 'behavior_url_changed';
    return null; };
  const wbBehOwnerFact = el => { const scope = wbScope(el);
    return scope ? { id: wbBehIdOf(scope), label: wbName(scope).label, role: scope.getAttribute('role') || scope.tagName.toLowerCase(), dom_id: scope.id || '', source: wbName(scope).source } : null; };
  const wbBehControlFact = el => { const name = wbName(el);
    return { id: wbBehIdOf(el), tag: el.tagName.toLowerCase(), label: name.label, name_source: name.source,
      role: el.getAttribute('role') || '', dom_id: el.id || '', owner: wbBehOwnerFact(el) }; };
  const wbBehFactMatches = (actual, expected) => { if ((actual === null) !== (expected === null)) return false; if (actual === null) return true;
    if (!['id','tag','label','name_source','role','dom_id'].every(k => typeof expected[k] === 'string' && actual[k] === expected[k])) return false;
    if ((actual.owner === null) !== (expected.owner === null)) return false;
    return actual.owner === null || ['id','label','role','dom_id','source'].every(k => typeof expected.owner[k] === 'string' && actual.owner[k] === expected.owner[k]); };
  const wbBehSourceOf = el => ({ current_src: String(el.currentSrc || ''), src_attr: el.getAttribute('src') || '' });
  const wbBehNativeFn = (proto, name) => { try { const d = Object.getOwnPropertyDescriptor(proto, name); const fn = d && (d.value || d.get);
    return typeof fn === 'function' && Function.prototype.toString.call(fn).indexOf('[native code]') !== -1 ? fn : null; } catch (_) { return null; } };
  const wbBehInstanceClean = (el, names) => names.every(n => !Object.prototype.hasOwnProperty.call(el, n));
  const wbBehOverflowY = el => String(getComputedStyle(el).overflowY || '');
  const wbBehGeometry = el => ({ scroll_top: el.scrollTop, scroll_height: el.scrollHeight, client_height: el.clientHeight });
`;

// ─────────────────────────────────────────────────────────────────────────────
// Scroll: bounded scope discovery (observation is bounded with honest
// truncation; difficult candidates — unnamed, unknown owner — are preserved).
// ─────────────────────────────────────────────────────────────────────────────

/** Observe the document scroll scope plus the first maxContainers effective
 * vertical overflow containers, scanning at most scanLimit elements. Ids are
 * minted in the SAME visible-dom registry (observer-compatible). */
export function nativeScrollScopesExpression(maxContainers = 8, scanLimit = 4000): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${BEHAVIOR_DOM_HELPERS}
    const maxContainers = ${JSON.stringify(Math.max(1, Math.min(32, Math.trunc(maxContainers))))};
    const scanLimit = ${JSON.stringify(Math.max(100, Math.min(20000, Math.trunc(scanLimit))))};
    const docFact = el => ({ schema: 'native-scroll-scope/1.0', scope_kind: 'document', id: null,
      tag: el.tagName.toLowerCase(), label: document.title || '', name_source: 'document-title', role: '', dom_id: '',
      owner: null, scrollable: el.scrollHeight > el.clientHeight, rendered: true, overflow_y: 'viewport', ...wbBehGeometry(el) });
    const containerFact = el => ({ schema: 'native-scroll-scope/1.0', scope_kind: 'container', id: wbBehIdOf(el),
      tag: el.tagName.toLowerCase(), label: wbName(el).label, name_source: wbName(el).source,
      role: el.getAttribute('role') || '', dom_id: el.id || '', owner: wbBehOwnerFact(el),
      scrollable: el.scrollHeight > el.clientHeight, rendered: wbTextRendered(el), overflow_y: wbBehOverflowY(el), ...wbBehGeometry(el) });
    const out = { schema: 'native-scroll-scopes/1.0', document_ref: null, url: window.location.href,
      document: null, containers: [], scanned: 0, truncated: false };
    // Bootstrap/lazily create the SAME registry state the observer uses, then
    // take the document reference from it (never from the mutable attribute).
    wbBehIdOf(document.documentElement);
    out.document_ref = wbBehState().prefix;
    const scrolling = document.scrollingElement;
    out.document = scrolling ? docFact(scrolling) : null;
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (out.scanned >= scanLimit) { out.truncated = true; break; }
      out.scanned++;
      if (el === document.documentElement || el === document.body || el === document.head || el === document.title) continue;
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') continue;
      if (!(el.clientHeight > 0) || !(el.scrollHeight > el.clientHeight)) continue;
      const oy = wbBehOverflowY(el);
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (out.containers.length >= maxContainers) { out.truncated = true; break; }
      out.containers.push(containerFact(el));
    }
    return out;
  })()`;
}

/** Resolve one scroll scope and re-check the full binding on a fresh read.
 * Fail-closed: any drift yields ok:false with the exact reason. */
export function nativeScrollReadExpression(nodeId: string | null, binding: unknown): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${BEHAVIOR_DOM_HELPERS}
    const id = ${JSON.stringify(nodeId)}, expected = ${JSON.stringify(binding)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fail = reason => ({ schema: 'native-scroll-read/1.0', ok: false, reason, document_ref: null, url: null,
      binding_matches: false, scope_kind: null, identity: null, offset: null, overflow_y: null, rendered: null, at_start: null, at_end: null });
    if (!object(expected) || expected.schema !== 'native-scroll-binding/1.0'
      || typeof expected.document_ref !== 'string' || typeof expected.url !== 'string'
      || !['document', 'container'].includes(expected.scope_kind)
      || expected.scope_kind === 'document' && (id !== null || expected.container !== null)
      || expected.scope_kind === 'container' && (id === null || !object(expected.container) || typeof expected.container.id !== 'string' || expected.container.id !== id
        || !['tag','label','name_source','role','dom_id'].every(k => typeof expected.container[k] === 'string')
        || !(expected.container.owner === null || object(expected.container.owner) && ['id','label','role','dom_id','source'].every(k => typeof expected.container.owner[k] === 'string'))))
      return fail('scroll_read_malformed');
    const docErr = wbBehDocState(expected); if (docErr) return fail(docErr);
    let el, identity;
    if (expected.scope_kind === 'document') {
      el = document.scrollingElement;
      if (!el) return fail('scroll_scope_unsupported');
      identity = null;
    } else {
      el = wbBehById(id);
      if (!el || wbBehObservedId(el) !== id) return fail('scroll_scope_not_observed');
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return fail('scroll_scope_iframe_unsupported');
      if (!el.isConnected) return fail('scroll_scope_disconnected');
      identity = wbBehControlFact(el);
      if (!wbBehFactMatches(identity, expected.container)) return { ...fail('scroll_scope_identity_drift'), document_ref: wbBehState().prefix, url: window.location.href, identity };
    }
    if(!wbBehInstanceClean(el,['scrollTop','scrollHeight','clientHeight','scrollBy']))return fail('scroll_state_overridden');
    const offset = wbBehGeometry(el);
    const maxTop = Math.max(0, offset.scroll_height - offset.client_height);
    return { schema: 'native-scroll-read/1.0', ok: true, document_ref: wbBehState().prefix, url: window.location.href,
      binding_matches: true, scope_kind: expected.scope_kind, identity,
      offset, overflow_y: expected.scope_kind === 'document' ? 'viewport' : wbBehOverflowY(el),
      rendered: expected.scope_kind === 'document' ? true : wbTextRendered(el),
      at_start: offset.scroll_top <= 0, at_end: offset.scroll_top >= maxTop };
  })()`;
}

/** Guarded bounded scroll as ONE Runtime.evaluate expression: exactly one
 * native Element.prototype.scrollBy of one viewport page (down/up). Refuses
 * before any effect on malformed shape, expired/invalid deadline, document
 * drift, unobserved/forged/foreign/iframe/repurposed scopes or overridden
 * methods; rechecks the deadline synchronously immediately before the single
 * native call; reads actual before/after offsets and classifies exactly.
 * No retries, no page replacement, no feed-coverage claim. */
export function nativeScrollExpression(nodeId: string | null, binding: unknown, direction: ScrollDirection, deadlineAtMs: number): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${BEHAVIOR_DOM_HELPERS}
    const id = ${JSON.stringify(nodeId)}, expected = ${JSON.stringify(binding)}, direction = ${JSON.stringify(direction)}, deadline = ${JSON.stringify(deadlineAtMs)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const refuse = reason => ({ schema: 'native-scroll-result/1.0', status: 'not_executed', outcome: 'unsupported', reason,
      scope_kind: expected && object(expected) ? expected.scope_kind : 'document', direction: direction === 'up' ? 'up' : 'down', dispatched: false, claim: 'offset_delta_only' });
    // 1. binding shape — fail closed on anything malformed.
    if (!object(expected) || expected.schema !== 'native-scroll-binding/1.0'
      || typeof expected.document_ref !== 'string' || expected.document_ref === '' || typeof expected.url !== 'string')
      return refuse('scroll_binding_malformed');
    if (expected.scope_kind === 'document' && (id !== null || expected.container !== null)) return refuse('scroll_binding_malformed');
    if (expected.scope_kind === 'container' && (id === null || !object(expected.container) || typeof expected.container.id !== 'string' || expected.container.id === '' || expected.container.id !== id
      || !['tag','label','name_source','role','dom_id'].every(k => typeof expected.container[k] === 'string')
      || !(expected.container.owner === null || object(expected.container.owner) && ['id','label','role','dom_id','source'].every(k => typeof expected.container.owner[k] === 'string'))))
      return refuse('scroll_binding_malformed');
    if (id !== null && typeof id !== 'string') return refuse('scroll_binding_malformed');
    if (direction !== 'down' && direction !== 'up') return refuse('scroll_direction_invalid');
    // 2. absolute deadline (safe integer; refused before any native call).
    if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline)) return refuse('scroll_deadline_invalid');
    if (Date.now() >= deadline) return refuse('scroll_deadline_expired');
    // 3. document identity.
    const docErr = wbBehDocState(expected); if (docErr) return refuse(docErr);
    // 4. resolve and re-verify the scope binding on a fresh read.
    let el;
    if (expected.scope_kind === 'document') {
      el = document.scrollingElement;
      if (!el) return refuse('scroll_scope_unsupported');
      if (!wbBehInstanceClean(el, ['scrollTop', 'scrollHeight', 'clientHeight', 'scrollBy'])) return refuse('scroll_state_overridden');
    } else {
      el = wbBehById(id);
      if (!el || wbBehObservedId(el) !== id) return refuse('scroll_scope_not_observed');
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return refuse('scroll_scope_iframe_unsupported');
      if (!el.isConnected) return refuse('scroll_scope_disconnected');
      const identity = wbBehControlFact(el);
      if (!wbBehFactMatches(identity, expected.container)) return refuse('scroll_scope_identity_drift');
      const oy = wbBehOverflowY(el);
      if (oy !== 'auto' && oy !== 'scroll') return refuse('scroll_scope_not_scrollable');
      if (!wbTextRendered(el)) return refuse('scroll_scope_not_accessible');
      if (!wbBehInstanceClean(el, ['scrollTop', 'scrollHeight', 'clientHeight', 'scrollBy'])) return refuse('scroll_state_overridden');
    }
    // 5. native method integrity (prototype function must be native code).
    const scrollBy = wbBehNativeFn(Element.prototype, 'scrollBy');
    if (!scrollBy) return refuse('scroll_method_overridden');
    // 6. before read; boundary check decides already_at_end without a call.
    const before = wbBehGeometry(el);
    const base = { schema: 'native-scroll-result/1.0', scope_kind: expected.scope_kind, direction,
      claim: 'offset_delta_only', before };
    const maxTop = Math.max(0, before.scroll_height - before.client_height);
    const atBoundary = direction === 'down' ? before.scroll_top >= maxTop : before.scroll_top <= 0;
    if (atBoundary) return { ...base, status: 'executed', outcome: 'already_at_end',
      at: direction === 'down' ? 'end' : 'start',after:before,delta:0, dispatched: false };
    // 7. final synchronous deadline recheck; exactly ONE native scrollBy of one viewport page.
    if (Date.now() >= deadline) return refuse('scroll_deadline_expired');
    const delta = (direction === 'down' ? 1 : -1) * before.client_height;
    try { scrollBy.call(el, { top: delta, left: 0, behavior: 'instant' }); }
    catch (e) { return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'scroll_dispatch_threw',
      cause: String(e && e.message || e), dispatched: true }; }
    // 8. after read + honest classification on actual offsets.
    let after;
    try {
      if (wbBehDocState(expected)) return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'scroll_document_changed_during_scroll', dispatched: true };
      const elNow = expected.scope_kind === 'document' ? document.scrollingElement : wbBehById(id);
      if (elNow !== el) return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'scroll_scope_drifted_during_scroll', dispatched: true };
      after = wbBehGeometry(el);
    } catch (e) { return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'scroll_post_read_failed',
      cause: String(e && e.message || e), dispatched: true }; }
    const movedDown = after.scroll_top > before.scroll_top, movedUp = after.scroll_top < before.scroll_top;
    if (direction === 'down' && movedDown) return { ...base, status: 'executed', outcome: 'moved', after,
      delta: after.scroll_top - before.scroll_top, dispatched: true };
    if (direction === 'up' && movedUp) return { ...base, status: 'executed', outcome: 'moved', after,
      delta: after.scroll_top - before.scroll_top, dispatched: true };
    if (after.scroll_top === before.scroll_top) {
      if (String(getComputedStyle(el).scrollBehavior || 'auto') === 'smooth')
        return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'scroll_smooth_in_flight', after, dispatched: true };
      return { ...base, status: 'executed', outcome: 'no_progress', after, delta:0, dispatched: true };
    }
    return { ...base, status: 'executed', outcome: 'no_progress', reason: 'scroll_moved_opposite_direction', after,
      delta: after.scroll_top - before.scroll_top, dispatched: true };
  })()`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media: ordinary HTMLVideoElement / HTMLAudioElement only.
// ─────────────────────────────────────────────────────────────────────────────

/** Observe media elements in this document, bounded, honest truncation,
 * difficult candidates (unnamed, sourceless, hidden) preserved with facts. */
export function nativeMediaObserveExpression(maxMedia = 16): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${BEHAVIOR_DOM_HELPERS}
    const max = ${JSON.stringify(Math.max(1, Math.min(64, Math.trunc(maxMedia))))};
    wbBehIdOf(document.documentElement); // ensure the shared registry state exists
    const els = Array.from(document.querySelectorAll('video,audio')).filter(el => el.tagName === 'VIDEO' || el.tagName === 'AUDIO');
    const media = els.slice(0, max).map(el => { const fact = wbBehControlFact(el);
      return { schema: 'native-media/1.0', id: fact.id, tag: fact.tag === 'audio' ? 'audio' : 'video',
        label: fact.label, name_source: fact.name_source, role: fact.role, dom_id: fact.dom_id, owner: fact.owner,
        source: wbBehSourceOf(el),
        paused: el.paused === true, ended: el.ended === true, ready_state: Number(el.readyState) | 0, muted: el.muted === true,
        rendered: wbTextRendered(el), connected: el.isConnected === true }; });
    return { schema: 'native-media-observation/1.0', document_ref: wbBehState() ? wbBehState().prefix : null,
      url: window.location.href, total: els.length, truncated: els.length > media.length, media };
  })()`;
}

/** Resolve one observed media element and re-check the full binding (identity
 * AND source) on a fresh read. Fresh paused/ended/readyState/currentSrc are
 * the only admissible playback proof — never a play() promise. */
export function nativeMediaReadExpression(nodeId: string, binding: unknown): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${BEHAVIOR_DOM_HELPERS}
    const id = ${JSON.stringify(nodeId)}, expected = ${JSON.stringify(binding)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fail = reason => ({ schema: 'native-media-read/1.0', ok: false, reason, document_ref: null, url: null,
      binding_matches: false, identity: null, source_matches: null, state: null });
    if (!object(expected) || expected.schema !== 'native-media-binding/1.0'
      || typeof expected.document_ref !== 'string' || typeof expected.url !== 'string' || !object(expected.media)
      || expected.media.id !== id || typeof id !== 'string' || id === ''
      || !['tag','label','name_source','role','dom_id'].every(k => typeof expected.media[k] === 'string')
      || expected.media.tag !== 'video' && expected.media.tag !== 'audio'
      || !(expected.media.owner === null || object(expected.media.owner) && ['id','label','role','dom_id','source'].every(k => typeof expected.media.owner[k] === 'string'))
      || !object(expected.source) || typeof expected.source.current_src !== 'string' || typeof expected.source.src_attr !== 'string')
      return fail('media_read_malformed');
    const docErr = wbBehDocState(expected); if (docErr) return fail(docErr);
    const el = wbBehById(id);
    if (!el || wbBehObservedId(el) !== id) return fail('media_not_observed');
    if (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') return fail('media_not_observed');
    if (!el.isConnected) return fail('media_disconnected');
    if(!wbBehInstanceClean(el,['paused','ended','readyState','currentSrc','currentTime','playbackRate']))return fail('media_state_overridden');
    const identity = wbBehControlFact(el);
    if (!wbBehFactMatches(identity, expected.media)) return { ...fail('media_identity_drift'), document_ref: wbBehState().prefix, url: window.location.href, identity };
    const sourceMatches = JSON.stringify(wbBehSourceOf(el)) === JSON.stringify(expected.source);
    if (!sourceMatches) return { ...fail('media_source_changed'), document_ref: wbBehState().prefix, url: window.location.href, identity };
    return { schema: 'native-media-read/1.0', ok: true, document_ref: wbBehState().prefix, url: window.location.href,
      binding_matches: true, identity, source_matches: true,
      state: { paused: el.paused === true, ended: el.ended === true, ready_state: Number(el.readyState) | 0,
        current_src: String(el.currentSrc || ''), current_time:el.currentTime,playback_rate:el.playbackRate, muted: el.muted === true, rendered: wbTextRendered(el), connected: el.isConnected === true } };
  })()`;
}

/** Guarded media play/pause as ONE awaited Runtime.evaluate expression
 * (awaitPromise transport). Exactly one native prototype call:
 * HTMLMediaElement.prototype.play or .pause, both verified native code, with
 * instance overrides refused. The play() promise await is bounded by the
 * absolute deadline and awaitCapMs, so the expression always settles. The
 * promise is evidence of NOTHING by itself: the proof is the fresh post-read
 * of paused/ended/readyState/currentSrc plus full identity recheck. Identity
 * or source drift after dispatch ⇒ effect_unknown (no retry). */
export function nativeMediaActExpression(nodeId: string, binding: unknown, desired: MediaDesired, deadlineAtMs: number, awaitCapMs = 2500): string {
  return `(async () => { ${NATIVE_TEXT_DOM_HELPERS}
${BEHAVIOR_DOM_HELPERS}
    const id = ${JSON.stringify(nodeId)}, expected = ${JSON.stringify(binding)}, desired = ${JSON.stringify(desired)}, deadline = ${JSON.stringify(deadlineAtMs)}, awaitCap = ${JSON.stringify(Math.max(50, Math.min(10_000, Math.trunc(awaitCapMs))))};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const refuse = reason => ({ schema: 'native-media-result/1.0', status: 'not_executed', outcome: 'unsupported', reason,
      desired: desired === 'paused' ? 'paused' : 'playing', dispatched: false, dispatch: { method: null, programmatic: true, user_gesture: false }, promise: 'not_awaited' });
    // 1. binding shape — fail closed.
    if (!object(expected) || expected.schema !== 'native-media-binding/1.0'
      || typeof expected.document_ref !== 'string' || expected.document_ref === '' || typeof expected.url !== 'string')
      return refuse('media_binding_malformed');
    if (typeof id !== 'string' || id === '' || !object(expected.media) || expected.media.id !== id
      || !['tag','label','name_source','role','dom_id'].every(k => typeof expected.media[k] === 'string')
      || expected.media.tag !== 'video' && expected.media.tag !== 'audio'
      || !(expected.media.owner === null || object(expected.media.owner) && ['id','label','role','dom_id','source'].every(k => typeof expected.media.owner[k] === 'string')))
      return refuse('media_binding_malformed');
    if (!object(expected.source) || typeof expected.source.current_src !== 'string' || typeof expected.source.src_attr !== 'string')
      return refuse('media_binding_malformed');
    if (desired !== 'playing' && desired !== 'paused') return refuse('media_desired_invalid');
    // 2. absolute deadline.
    if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline)) return refuse('media_deadline_invalid');
    if (Date.now() >= deadline) return refuse('media_deadline_expired');
    // 3. document identity.
    const docErr = wbBehDocState(expected); if (docErr) return refuse(docErr);
    // 4. observed element + full identity recheck (forged/foreign bindings fail).
    const el = wbBehById(id);
    if (!el || wbBehObservedId(el) !== id) return refuse('media_not_observed');
    if (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') return refuse('media_not_observed');
    if (!el.isConnected) return refuse('media_disconnected');
    const preIdentity = wbBehControlFact(el);
    if (!wbBehFactMatches(preIdentity, expected.media)) return refuse('media_identity_drift');
    if (JSON.stringify(wbBehSourceOf(el)) !== JSON.stringify(expected.source)) return refuse('media_source_changed');
    // 5. native prototype methods + instance-override refusal.
    const play = wbBehNativeFn(HTMLMediaElement.prototype, 'play');
    const pause = wbBehNativeFn(HTMLMediaElement.prototype, 'pause');
    if (!play || !pause) return refuse('media_method_overridden');
    if (!wbBehInstanceClean(el, ['play', 'pause'])) return refuse('media_method_overridden');
    if (!wbBehInstanceClean(el, ['paused', 'ended', 'readyState', 'currentSrc','currentTime','playbackRate'])) return refuse('media_state_overridden');
    // 6. fresh pre-state.
    const pre = { paused: el.paused === true, ended: el.ended === true, ready_state: Number(el.readyState) | 0, current_src: String(el.currentSrc || ''), current_time:el.currentTime,playback_rate:el.playbackRate };
    if (desired === 'playing' && pre.current_src === '' && pre.ready_state === 0) return refuse('media_source_absent');
    // 7. final synchronous deadline recheck; exactly ONE native dispatch.
    if (Date.now() >= deadline) return refuse('media_deadline_expired');
    const base = { schema: 'native-media-result/1.0', desired,
      dispatch: { method: desired === 'playing' ? 'play' : 'pause', programmatic: true, user_gesture: false }, before: pre };
    let promiseOutcome;
    if (desired === 'paused') {
      if (pre.paused) promiseOutcome = 'already';
      else { try { pause.call(el); promiseOutcome = 'sync'; }
        catch (e) { return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_pause_threw',
          cause: String(e && e.message || e), dispatched: true, promise: 'sync' }; } }
    } else {
      let p;
      try { p = play.call(el); }
      catch (e) { return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_play_threw',
        cause: String(e && e.message || e), dispatched: true, promise: 'threw' }; }
      if (p && typeof p.then === 'function') {
        const wait = Math.max(0, Math.min(awaitCap, deadline - Date.now()));
        promiseOutcome = await Promise.race([
          p.then(() => 'fulfilled', err => 'rejected:' + String((err && err.name) || err)),
          new Promise(resolve => setTimeout(() => resolve('timeout'), wait)),
        ]);
      } else promiseOutcome = 'no_promise';
    }
    // 8. FRESH read + identity recheck — the only proof. Promise alone proves nothing.
    const dispatched = desired === 'paused' ? !pre.paused : true;
    try {
      if (wbBehDocState(expected)) return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_document_changed_during_dispatch', dispatched: true, promise: promiseOutcome };
      if (wbBehById(id) !== el || wbBehObservedId(el) !== id || !el.isConnected)
        return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_scope_drifted_during_dispatch', dispatched: true, promise: promiseOutcome };
      if (!wbBehFactMatches(wbBehControlFact(el), expected.media))
        return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_identity_drifted_during_dispatch', dispatched: true, promise: promiseOutcome };
      const sourceNow = wbBehSourceOf(el);
      const sourceMatches = JSON.stringify(sourceNow) === JSON.stringify(expected.source);
      const after = { paused: el.paused === true, ended: el.ended === true, ready_state: Number(el.readyState) | 0,
        current_src: sourceNow.current_src,current_time:el.currentTime,playback_rate:el.playbackRate, muted: el.muted === true, rendered: wbTextRendered(el), connected: el.isConnected === true };
      if(!sourceMatches)return {...base,status:'effect_unknown',outcome:'effect_unknown',reason:'media_source_changed_during_dispatch',dispatched,promise:promiseOutcome,after};
      const reached = desired === 'playing' ? after.paused === false && after.ended === false && after.ready_state>=2 : after.paused === true;
      if (reached) return { ...base, status: 'executed', outcome: 'reached', dispatched, promise: promiseOutcome, after };
      if (promiseOutcome === 'timeout')
        return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_play_timeout', dispatched, promise: promiseOutcome, after };
      if (!sourceMatches)
        return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_source_changed_during_dispatch', dispatched, promise: promiseOutcome, after };
      const reason = typeof promiseOutcome === 'string' && promiseOutcome.indexOf('rejected:') === 0 ? 'media_play_rejected:' + promiseOutcome.slice('rejected:'.length)
        : promiseOutcome === 'fulfilled' ? 'media_paused_after_fulfillment'
        : desired === 'paused' ? 'media_pause_not_effective' : 'media_play_not_effective';
      return { ...base, status: 'executed', outcome: 'not_reached', reason, dispatched, promise: promiseOutcome, after };
    } catch (e) { return { ...base, status: 'effect_unknown', outcome: 'effect_unknown', reason: 'media_post_read_failed',
      cause: String(e && e.message || e), dispatched, promise: promiseOutcome }; }
  })()`;
}
