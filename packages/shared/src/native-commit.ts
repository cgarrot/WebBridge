/** Canonical native guarded commit helper, integrated from the reviewed draft.
 * One Runtime.evaluate per commit: validate shape → document/url identity →
 * observed control identity/state → every captured payload guard → identity
 * attribute guards → exactly ONE programmatic HTMLElement.click().
 * A dispatched click is NOT proof of backend persistence or publication; the
 * independent backend proof belongs to the installed trusted
 * app profile. No retries, no rollback of real effects, no raw CDP/network.
 * Programmatic click keeps isTrusted === false; no isTrusted promise is made.
 * Control kinds admitted by this helper: BUTTON, INPUT[type=submit|button].
 * Canonical destination: WebBridge packages/shared/src/native-commit.ts,
 * importing './native-text.js' from the shared package. */
import { NATIVE_TEXT_DOM_HELPERS } from './native-text.js';
import type { NativeTextBinding } from './native-text.js';

/** Generic native control identity; ids are actual WeakMap ids, never the
 * mutable data-wb-id attribute alone. owner/form are this control's own
 * observed facts — no same-owner condition versus any other node is implied. */
export interface NativeControlIdentity {
  id: string; label: string; dom_id: string; name: string; role: string;
  tag: string; input_type: string;
  owner: { id: string; label: string; role: string; dom_id: string; source: string } | null;
  form: { id: string; label: string; dom_id: string; name: string } | null;
}
/** Ordinary text field: complete native-text-binding/1.1 identity plus the
 * exact wbReadText value. Ordinary text is compared byte-exact; never NFC/trim. */
export interface NativeCommitTextField {
  kind: 'text'; id: string; binding: NativeTextBinding; expected: string;
}
/** Native select: selected option values, canonical JSON (sorted asc). */
export interface NativeCommitSelectField {
  kind: 'select'; id: string; binding: NativeControlIdentity; expected: string;
}
/** Native checkbox: el.checked encoded as the literal 'true' | 'false'. */
export interface NativeCommitCheckboxField {
  kind: 'checkbox'; id: string; binding: NativeControlIdentity; expected: 'true' | 'false';
}
export type NativeCommitField = NativeCommitTextField | NativeCommitSelectField | NativeCommitCheckboxField;
/** Profile-installed data-* identity attributes on observed native IDs.
 * Attribute names are validated as data-*; never selectors or model code. */
export interface NativeCommitIdentityGuard {
  node_id: string; attribute: string; value: string;
}
/** native-commit-binding/1.0 — the binding the root's trusted app profile
 * builds from nativeCommitReadExpression output plus the server baseline. */
export interface NativeCommitBinding {
  schema: 'native-commit-binding/1.0';
  document_ref: string; url: string;
  control_id: string;            // === the nodeId passed to the click expression
  control: NativeControlIdentity;
  fields: NativeCommitField[];   // unique ids, at most 128
  identity_guards: NativeCommitIdentityGuard[]; // 1..32, profile-installed data-*
  /** Only for explicitly admitted fixture profiles; paired with a trusted
   * runtime-generated operation_ref argument on the click call. Default none. */
  correlation_attribute?: string;
}
export interface NativeCommitCorrelationReport {
  attribute: string | null; injected: boolean; restored: boolean;
}
/** Honest native dispatch status only; never a backend-commit claim. */
export interface NativeCommitClickResult {
  dispatched: boolean;
  effect_unknown?: boolean;
  reason?: string;
  cause?: string;
  correlation?: NativeCommitCorrelationReport;
}
/** Field spec for the independent read capture. Declared encodings only;
 * the read API takes no requested text input. */
export interface NativeCommitFieldSpec {
  id: string; encoding: 'text' | 'select_values' | 'checkbox_checked';
}
export interface NativeCommitGuardSpec {
  node_id: string; attribute: string;
}
export interface NativeCommitReadResult {
  schema: 'native-commit-read/1.0';
  ok: boolean;
  reason?: string;
  document_ref: string | null; url: string | null;
  control: { observed: boolean; identity: NativeControlIdentity | null;
    state: { visible: boolean; enabled: boolean; readonly: boolean; admitted: boolean } | null } | null;
  fields: Array<{ id: string; encoding: string; ok: boolean; reason?: string; binding: unknown; value: string | null }>;
  identity_guards: Array<{ node_id: string; attribute: string; observed: boolean; value: string | null }>;
  correlation: { attribute: string; observed: boolean; value: string | null } | null;
}

/** Commit-side DOM helpers. Built ON NATIVE_TEXT_DOM_HELPERS (no duplication):
 * the WeakMap state installed by the visible-dom observer is authoritative;
 * data-wb-id is only a candidate locator and is never trusted on its own. */
const NATIVE_COMMIT_DOM_HELPERS = `
  const wbCommitState = () => window[Symbol.for('webbridge.visible-dom.v2')];
  const wbCommitObservedId = el => { const s = wbCommitState(); const id = s && s.ids ? s.ids.get(el) : null; return typeof id === 'string' ? id : null; };
  const wbCommitById = id => { const s = wbCommitState(); if (!s || !s.ids || typeof id !== 'string') return null;
    for (const el of document.querySelectorAll('[data-wb-id]')) if (s.ids.get(el) === id) return el;
    return null; };
  const wbCommitInputType = el => 'type' in el && typeof el.type === 'string' ? el.type : el.getAttribute('type') || '';
  const wbCommitIdentity = el => { const s = wbCommitState(); const idOf = n => { const v = s && s.ids ? s.ids.get(n) : null; return typeof v === 'string' ? v : null; };
    const scope = wbScope(el); const form = 'form' in el ? el.form : null;
    return { id: idOf(el), label: wbName(el).label, dom_id: el.id || '', name: el.name || '', role: el.getAttribute('role') || '',
      tag: el.tagName.toLowerCase(), input_type: wbCommitInputType(el),
      owner: scope ? wbScopeFact(scope, idOf) : null, form: form ? wbFormFact(form, idOf) : null }; };
  const wbCommitFactMatches = (actual, expected, fields) => { if ((actual === null) !== (expected === null)) return false;
    if (actual === null || expected === null) return true;
    return fields.every(k => typeof expected[k] === 'string' && actual[k] === expected[k]); };
  const wbCommitIdentityMatches = (el, expected) => { if (!expected || typeof expected !== 'object') return false;
    const actual = wbCommitIdentity(el);
    for (const k of ['id','label','dom_id','name','role','tag','input_type']) if (typeof expected[k] !== 'string' || actual[k] !== expected[k]) return false;
    if (!wbCommitFactMatches(actual.owner, expected.owner, ['id','label','role','dom_id','source'])) return false;
    return wbCommitFactMatches(actual.form, expected.form, ['id','label','dom_id','name']); };
  const wbCommitAdmitted = el => el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && ['submit','button'].includes(String(el.type || '')));
  const wbCommitAttrName = name => typeof name === 'string' && /^data-[a-z0-9-]+$/i.test(name) && name.toLowerCase() !== 'data-wb-id';
  const wbCommitCapture = (el, encoding) => {
    if (!wbCommitObservedId(el)) return { ok: false, reason: 'not_observed' };
    if (!wbTextRendered(el)) return { ok: false, reason: 'not_rendered' };
    if (encoding === 'text') { const binding = wbCurrentBinding(el);
      if (!binding) return { ok: false, reason: 'not_observed' };
      if (binding.editor_kind === 'opaque' || binding.read_kind === 'none') return { ok: false, reason: 'opaque' };
      if (!wbBackendSupported(el)) return { ok: false, reason: 'editor_unsupported' };
      const value = wbReadText(el); return value === null ? { ok: false, reason: 'value_unreadable' } : { ok: true, binding, value }; }
    if (encoding === 'select_values') { if (el.tagName !== 'SELECT') return { ok: false, reason: 'not_native_select' };
      const value = JSON.stringify(Array.from(el.options || []).filter(o => o.selected === true).map(o => String(o.value)).sort());
      return { ok: true, binding: wbCommitIdentity(el), value }; }
    if (encoding === 'checkbox_checked') { if (el.tagName !== 'INPUT' || String(el.type) !== 'checkbox') return { ok: false, reason: 'not_native_checkbox' };
      return { ok: true, binding: wbCommitIdentity(el), value: el.checked === true ? 'true' : 'false' }; }
    return { ok: false, reason: 'encoding_unknown' }; };
  const wbCommitFieldCheck = (el, field) => {
    if (wbCommitObservedId(el) !== field.id) return 'commit_field_id_mismatch';
    const encoding = field.kind === 'text' ? 'text' : field.kind === 'select' ? 'select_values' : field.kind === 'checkbox' ? 'checkbox_checked' : null;
    if (!encoding || typeof field.expected !== 'string') return 'commit_field_malformed';
    const cap = wbCommitCapture(el, encoding);
    if (!cap.ok) return 'commit_field_' + cap.reason;
    if (field.expected !== cap.value) return 'commit_field_value_drift';
    if (encoding === 'text' ? !wbBindingMatches(el, field.binding) : !wbCommitIdentityMatches(el, field.binding)) return 'commit_field_binding_drift';
    if (!wbEnabled(el) || wbReadonly(el)) return 'commit_field_state';
    return null; };
`;

/** Guarded native commit click as ONE Runtime.evaluate expression.
 * deadlineAtMs is an absolute epoch-ms deadline, validated as a safe integer
 * and refused once Date.now() >= deadline; it is a call parameter and is
 * excluded from the binding's logical identity.
 * operationRef pairs with binding.correlation_attribute (fixture profiles
 * only): injected as the attribute's value for the synchronous dispatch and
 * restored afterwards, even when the click throws. Default: no injection. */
export function nativeCommitClickExpression(nodeId: string, binding: unknown, deadlineAtMs: number, operationRef?: string): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${NATIVE_COMMIT_DOM_HELPERS}
    const id=${JSON.stringify(nodeId)}, expected=${JSON.stringify(binding)}, deadline=${JSON.stringify(deadlineAtMs)}, opRef=${JSON.stringify(operationRef ?? null)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const refuse = reason => ({ dispatched: false, reason });
    // 1. binding shape — fail closed on anything malformed.
    if (!object(expected) || expected.schema !== 'native-commit-binding/1.0' || typeof expected.document_ref !== 'string'
      || typeof expected.url !== 'string' || typeof expected.control_id !== 'string' || !object(expected.control)) return refuse('commit_binding_malformed');
    if (expected.control_id !== id) return refuse('commit_control_id_mismatch');
    if (!Array.isArray(expected.fields) || expected.fields.length > 128) return refuse('commit_binding_malformed');
    const fieldIds = expected.fields.map(f => object(f) && f.id);
    if (fieldIds.some(v => typeof v !== 'string') || new Set(fieldIds).size !== fieldIds.length) return refuse('commit_binding_malformed');
    for (const f of expected.fields) if (!['text','select','checkbox'].includes(f && f.kind) || typeof f.expected !== 'string' || !object(f.binding)) return refuse('commit_binding_malformed');
    if (!Array.isArray(expected.identity_guards) || expected.identity_guards.length < 1 || expected.identity_guards.length > 32) return refuse('commit_binding_malformed');
    for (const g of expected.identity_guards) if (!object(g) || typeof g.node_id !== 'string' || !wbCommitAttrName(g.attribute) || typeof g.value !== 'string') return refuse('commit_binding_malformed');
    const corr = expected.correlation_attribute === undefined ? null : expected.correlation_attribute;
    if (corr !== null && !wbCommitAttrName(corr)) return refuse('commit_binding_malformed');
    if(corr!==null && expected.identity_guards.some(g=>g.node_id===id&&g.attribute.toLowerCase()===corr.toLowerCase()))return refuse('commit_correlation_overlaps_identity');
    if (corr !== null && (typeof opRef !== 'string' || opRef === '' || opRef.length > 256)) return refuse('commit_correlation_ref_missing');
    // 2. absolute deadline (integer/finite validated; refused before any click).
    if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline)) return refuse('commit_deadline_invalid');
    if (Date.now() >= deadline) return refuse('commit_deadline_expired');
    // 3. document identity.
    const state = wbCommitState();
    if (!state || typeof state.prefix !== 'string' || state.prefix !== expected.document_ref) return refuse('commit_document_ref_changed');
    if (window.location.href !== expected.url) return refuse('commit_url_changed');
    // 4. observed control identity, visibility/enabled state, admitted kind.
    const control = wbCommitById(id);
    if (!control) return refuse('commit_control_not_observed');
    if (!wbCommitIdentityMatches(control, expected.control)) return refuse('commit_control_identity_drift');
    if (!wbTextRendered(control) || !wbEnabled(control) || wbReadonly(control)) return refuse('commit_control_state');
    if (!wbCommitAdmitted(control)) return refuse('commit_control_not_admitted');
    // 5. every captured payload guard re-observed and compared exactly.
    for (const field of expected.fields) { const el = wbCommitById(field.id);
      if (!el || wbCommitObservedId(el) !== field.id) return refuse('commit_field_not_observed:' + field.id);
      const bad = wbCommitFieldCheck(el, field); if (bad) return refuse(bad + ':' + field.id); }
    // 6. identity attribute guards on observed native IDs.
    for (const g of expected.identity_guards) { const el = wbCommitById(g.node_id);
      if (!el || wbCommitObservedId(el) !== g.node_id) return refuse('commit_guard_not_observed');
      if (el.getAttribute(g.attribute) !== g.value) return refuse('commit_guard_drift:' + g.attribute); }
    // 7. exactly one synchronous programmatic dispatch (isTrusted stays false).
    if(Date.now()>=deadline)return refuse('commit_deadline_expired');
    const correlation = { attribute: corr, injected: false, restored: false };
    const prev = corr === null ? null : { present: control.hasAttribute(corr), value: control.getAttribute(corr) };
    try {
      if (corr !== null) { correlation.injected = true; control.setAttribute(corr, opRef); }
      control.click();
    } catch (e) {
      return { dispatched: false, effect_unknown: true, reason: 'commit_click_threw', cause: String(e && e.message || e), correlation };
    } finally {
      if (correlation.injected) try { if (prev.present) control.setAttribute(corr, prev.value); else control.removeAttribute(corr); correlation.restored = true; } catch (_) {}
    }
    // 8. honest post-dispatch check. Identity/document drift during the click
    // makes the effect unknown; the payload may legitimately clear or reset
    // and is never re-compared after dispatch.
    try {
      if (wbCommitState().prefix !== expected.document_ref || window.location.href !== expected.url)
        return { dispatched: true, effect_unknown: true, reason: 'commit_document_changed_during_click', correlation };
      if (wbCommitById(id) !== control || !wbCommitIdentityMatches(control, expected.control))
        return { dispatched: true, effect_unknown: true, reason: 'commit_control_drifted_during_click', correlation };
      for(const g of expected.identity_guards){const el=wbCommitById(g.node_id);if(!el||el.getAttribute(g.attribute)!==g.value)
        return {dispatched:true,effect_unknown:true,reason:'commit_guard_drifted_during_click',correlation};}
      if(correlation.injected && !correlation.restored)return {dispatched:true,effect_unknown:true,reason:'commit_correlation_restore_failed',correlation};
    } catch (e) {
      return { dispatched: true, effect_unknown: true, reason: 'commit_post_click_check_failed', cause: String(e && e.message || e), correlation };
    }
    return { dispatched: true, effect_unknown: false, reason: 'native_dispatch_completed', correlation };
  })()`;
}

/** Independent capture: control binding, per-field bindings and current exact
 * values (declared encodings only), actual identity-guard attribute values,
 * document_ref/url. Only observed (WeakMap-present) IDs resolve; malformed
 * specs, opaque editors, unsupported editors and unrendered nodes fail closed.
 * Takes no requested text input; performs no writes and no clicks. The root's
 * trusted app profile builds the final binding from this read plus the server
 * identity/baseline read; this helper claims nothing about the backend. */
export function nativeCommitReadExpression(nodeId: string, fields: ReadonlyArray<NativeCommitFieldSpec>, identityGuards: ReadonlyArray<NativeCommitGuardSpec>, correlationAttribute?: string): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${NATIVE_COMMIT_DOM_HELPERS}
    const id=${JSON.stringify(nodeId)}, specs=${JSON.stringify(fields)}, guards=${JSON.stringify(identityGuards)}, corrAttr=${JSON.stringify(correlationAttribute ?? null)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fail = reason => ({ schema: 'native-commit-read/1.0', ok: false, reason, document_ref: null, url: null, control: null,
      fields: [], identity_guards: [], correlation: corrAttr === null ? null : { attribute: corrAttr, observed: false, value: null } });
    if (typeof id !== 'string' || !Array.isArray(specs) || specs.length > 128 || !Array.isArray(guards) || guards.length > 32) return fail('commit_read_malformed');
    for (const s of specs) if (!object(s) || typeof s.id !== 'string' || !['text','select_values','checkbox_checked'].includes(s.encoding)) return fail('commit_read_malformed');
    for (const g of guards) if (!object(g) || typeof g.node_id !== 'string' || !wbCommitAttrName(g.attribute)) return fail('commit_read_malformed');
    if (corrAttr !== null && !wbCommitAttrName(corrAttr)) return fail('commit_read_malformed');
    const state = wbCommitState();
    if (!state || typeof state.prefix !== 'string') return { ...fail('commit_document_unobserved') };
    const controlEl = wbCommitById(id);
    const control = { observed: !!controlEl, identity: controlEl ? wbCommitIdentity(controlEl) : null,
      state: controlEl ? { visible: wbTextRendered(controlEl), enabled: wbEnabled(controlEl), readonly: wbReadonly(controlEl), admitted: wbCommitAdmitted(controlEl) } : null };
    const fieldResults = specs.map(s => { const el = wbCommitById(s.id); const cap = el ? wbCommitCapture(el, s.encoding) : { ok: false, reason: 'not_observed' };
      return { id: s.id, encoding: s.encoding, ok: cap.ok, ...(cap.ok ? {} : { reason: cap.reason }), binding: cap.binding ?? null, value: cap.value ?? null }; });
    const guardResults = guards.map(g => { const el = wbCommitById(g.node_id);
      return { node_id: g.node_id, attribute: g.attribute, observed: !!el, value: el ? el.getAttribute(g.attribute) : null }; });
    const ok = !!controlEl && fieldResults.every(f => f.ok) && guardResults.every(g => g.observed);
    return { schema: 'native-commit-read/1.0', ok, ...(ok ? {} : { reason: !controlEl ? 'commit_control_not_observed' : undefined }),
      document_ref: state.prefix, url: window.location.href, control, fields: fieldResults, identity_guards: guardResults,
      correlation: corrAttr === null ? null : { attribute: corrAttr, observed: !!controlEl, value: controlEl ? controlEl.getAttribute(corrAttr) : null } };
  })()`;
}
