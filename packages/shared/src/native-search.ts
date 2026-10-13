/** Canonical native guarded search helper (reviewed component draft — NOT
 * production-admitted until root reviews and owns the extension export/build).
 * One Runtime.evaluate per submit: validate shape → document/url identity →
 * observed query-field identity/state (WeakMap ids authoritative) → observed
 * submit identity/state → identity attribute guards → guarded NATIVE-SETTER
 * write of the exact requested query (beforeinput/input/change, prototype
 * setter; an instance-level value interceptor is refused) → FRESH full
 * identity/state/value/deadline recheck AFTER the event handlers and BEFORE
 * exactly ONE submit activation (form.requestSubmit(control) or
 * HTMLElement.click, both resolved from the prototype chain; an instance
 * override of either is refused) → honest post-dispatch drift check.
 * Programmatic activation keeps isTrusted === false: no trusted event is
 * claimed, fabricated, or required. A submit activation is NOT proof that a
 * search ran; the independent result provider owns that claim.
 * Built ON NATIVE_TEXT_DOM_HELPERS from './native-text.js' and the same
 * control-identity discipline as native-commit.ts (no duplication of state
 * semantics; the WeakMap state installed by the visible-dom observer is
 * authoritative, data-wb-id is only a candidate locator). */
import { NATIVE_TEXT_DOM_HELPERS } from './native-text.js';
import type { NativeTextBinding } from './native-text.js';
import type { NativeControlIdentity, NativeCommitIdentityGuard } from './native-commit.js';

/** native-search-binding/1.1 — the binding the installed trusted search
 * profile builds from nativeSearchReadExpression output plus the provider
 * baseline. Never a model input. */
export interface NativeSearchBinding {
  schema: 'native-search-binding/1.1';
  document_ref: string;
  url: string;
  /** Observed query field: complete native-text-binding/1.1 identity. */
  query_field: { id: string; binding: NativeTextBinding };
  /** Observed submit control: complete native control identity. */
  submit: { id: string; control: NativeControlIdentity };
  /** Profile-installed data-* identity attributes on observed native IDs. */
  identity_guards: NativeCommitIdentityGuard[];
  /** Fixture profiles only: pairs with a trusted runtime operation_ref. */
  correlation_attribute?: string;
}

/** Honest native submit status only; never a search-results claim. */
export interface NativeSearchSubmitResult {
  submitted: boolean;
  /** True when the page may have been mutated (or activation outcome is
   * unknowable) and no submit activation was confirmed. */
  effect_unknown?: boolean;
  reason?: string;
  cause?: string;
  observed_field_value?: string | null;
  correlation?: NativeSearchCorrelationReport;
}
export interface NativeSearchCorrelationReport {
  attribute: string | null; injected: boolean; restored: boolean;
}

/** Guard spec for the independent read capture. */
export interface NativeSearchGuardSpec { node_id: string; attribute: string }

/** Read-only capture result. Declared encodings only; no requested query
 * input, no writes, no submit. */
export interface NativeSearchReadResult {
  schema: 'native-search-read/1.1';
  ok: boolean;
  reason?: string;
  document_ref: string | null;
  url: string | null;
  field: {
    observed: boolean;
    identity: NativeTextBinding | null;
    state: { visible: boolean; enabled: boolean; readonly: boolean; backend_supported: boolean } | null;
    /** Exact current native query text (may be empty). No normalization. */
    value: string | null;
  } | null;
  submit: {
    observed: boolean;
    identity: NativeControlIdentity | null;
    state: { visible: boolean; enabled: boolean; readonly: boolean; admitted: boolean } | null;
  } | null;
  identity_guards: Array<{ node_id: string; attribute: string; observed: boolean; value: string | null }>;
  correlation: { attribute: string; observed: boolean; value: string | null } | null;
}

/** Search-side DOM helpers, mirroring the commit discipline, built ON the
 * canonical native-text helpers (wbName/wbScope/wbFormFact/wbEnabled/
 * wbReadonly/wbTextRendered/wbReadText/wbBindingMatches/wbBackendSupported). */
const NATIVE_SEARCH_DOM_HELPERS = `
  const wbSearchState = () => window[Symbol.for('webbridge.visible-dom.v2')];
  const wbSearchObservedId = el => { const s = wbSearchState(); const id = s && s.ids ? s.ids.get(el) : null; return typeof id === 'string' ? id : null; };
  const wbSearchById = id => { const s = wbSearchState(); if (!s || !s.ids || typeof id !== 'string') return null;
    for (const el of document.querySelectorAll('[data-wb-id]')) if (s.ids.get(el) === id) return el;
    return null; };
  const wbSearchInputType = el => 'type' in el && typeof el.type === 'string' ? el.type : el.getAttribute('type') || '';
  const wbSearchIdentity = el => { const s = wbSearchState(); const idOf = n => { const v = s && s.ids ? s.ids.get(n) : null; return typeof v === 'string' ? v : null; };
    const scope = wbScope(el); const form = 'form' in el ? el.form : null;
    return { id: idOf(el), label: wbName(el).label, dom_id: el.id || '', name: el.name || '', role: el.getAttribute('role') || '',
      tag: el.tagName.toLowerCase(), input_type: wbSearchInputType(el),
      owner: scope ? wbScopeFact(scope, idOf) : null, form: form ? wbFormFact(form, idOf) : null }; };
  const wbSearchFactMatches = (actual, expected, fields) => { if ((actual === null) !== (expected === null)) return false;
    if (actual === null || expected === null) return true;
    return fields.every(k => typeof expected[k] === 'string' && actual[k] === expected[k]); };
  const wbSearchIdentityMatches = (el, expected) => { if (!expected || typeof expected !== 'object') return false;
    const actual = wbSearchIdentity(el);
    for (const k of ['id','label','dom_id','name','role','tag','input_type']) if (typeof expected[k] !== 'string' || actual[k] !== expected[k]) return false;
    if (!wbSearchFactMatches(actual.owner, expected.owner, ['id','label','role','dom_id','source'])) return false;
    return wbSearchFactMatches(actual.form, expected.form, ['id','label','dom_id','name']); };
  const wbSearchAdmitted = el => el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && ['submit','button'].includes(String(el.type || '')));
  const wbSearchAttrName = name => typeof name === 'string' && /^data-[a-z0-9-]+$/i.test(name) && name.toLowerCase() !== 'data-wb-id';
  const wbSearchFieldOk = (el, expected) => !!el && wbSearchObservedId(el) !== null && wbBindingMatches(el, expected)
    && wbTextRendered(el) && wbEnabled(el) && !wbReadonly(el) && wbBackendSupported(el);
  const wbSearchSubmitOk = (el, expected) => !!el && wbSearchObservedId(el) !== null && wbSearchIdentityMatches(el, expected)
    && wbTextRendered(el) && wbEnabled(el) && !wbReadonly(el) && wbSearchAdmitted(el);
  const wbSearchGuardsOk = guards => Array.isArray(guards) && guards.every(g => {
    const el = wbSearchById(g.node_id);
    return !!el && wbSearchObservedId(el) === g.node_id && el.getAttribute(g.attribute) === g.value; });
  // Prototype-resolved native method lookup. Instance own properties are
  // deliberately skipped; overrides are detected by the caller instead of
  // being trusted. toString is never called and never trusted.
  const wbSearchNativeMethod = (obj, name) => { for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name); if (d && typeof d.value === 'function') return d.value; } return null; };
  // Exactly-one-activation plan: prefer HTMLFormElement.prototype.requestSubmit
  // (submits through the form like a real submit button, running validation);
  // fall back to HTMLElement.prototype.click. An instance-level shadow of the
  // resolved method is an override and is refused BEFORE the query write.
  const wbSearchActivation = submit => {
    const form = 'form' in submit ? submit.form : null;
    if (form) { const fn = wbSearchNativeMethod(form, 'requestSubmit');
      if (fn) return Object.hasOwn(form, 'requestSubmit') ? { refused: 'search_activation_overridden' } : { call: () => fn.call(form, submit) }; }
    const click = wbSearchNativeMethod(submit, 'click');
    if (click) return Object.hasOwn(submit, 'click') ? { refused: 'search_activation_overridden' } : { call: () => click.call(submit) };
    return { refused: 'search_activation_unavailable' };
  };
`;

/** Guarded native search submit as ONE Runtime.evaluate expression. The
 * requested query text is a call parameter bound to the frozen operation; it
 * is excluded from nothing and invented by nobody. Valid plain JavaScript —
 * no TypeScript-only syntax appears inside this string. */
export function nativeSearchSubmitExpression(fieldId: string, submitId: string, query: string, binding: unknown, deadlineAtMs: number, operationRef?: string): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${NATIVE_SEARCH_DOM_HELPERS}
    const fieldId=${JSON.stringify(fieldId)}, submitId=${JSON.stringify(submitId)}, query=${JSON.stringify(query)},
      expected=${JSON.stringify(binding)}, deadline=${JSON.stringify(deadlineAtMs)}, opRef=${JSON.stringify(operationRef ?? null)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const refuse = reason => ({ submitted: false, reason });
    // 1. binding shape — fail closed on anything malformed.
    if (!object(expected) || expected.schema !== 'native-search-binding/1.1'
      || typeof expected.document_ref !== 'string' || typeof expected.url !== 'string'
      || !object(expected.query_field) || !object(expected.query_field.binding) || !object(expected.submit) || !object(expected.submit.control)) return refuse('search_binding_malformed');
    if (expected.query_field.id !== fieldId || expected.submit.id !== submitId) return refuse('search_binding_id_mismatch');
    if (expected.query_field.binding.schema !== 'native-text-binding/1.1') return refuse('search_binding_malformed');
    if (!Array.isArray(expected.identity_guards) || expected.identity_guards.length < 1 || expected.identity_guards.length > 32) return refuse('search_binding_malformed');
    for (const g of expected.identity_guards) if (!object(g) || typeof g.node_id !== 'string' || !wbSearchAttrName(g.attribute) || typeof g.value !== 'string') return refuse('search_binding_malformed');
    const corr = expected.correlation_attribute === undefined ? null : expected.correlation_attribute;
    if (corr !== null && !wbSearchAttrName(corr)) return refuse('search_binding_malformed');
    if (corr !== null && expected.identity_guards.some(g => g.node_id === submitId && g.attribute.toLowerCase() === corr.toLowerCase())) return refuse('search_correlation_overlaps_identity');
    if (corr !== null && (typeof opRef !== 'string' || opRef === '' || opRef.length > 256)) return refuse('search_correlation_ref_missing');
    // 2. requested query + absolute deadline, refused before any write.
    if (typeof query !== 'string' || query === '' || query.length > 2048) return refuse('search_query_invalid');
    if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline)) return refuse('search_deadline_invalid');
    if (Date.now() >= deadline) return refuse('search_deadline_expired');
    // 3. document identity.
    const state = wbSearchState();
    if (!state || typeof state.prefix !== 'string' || state.prefix !== expected.document_ref) return refuse('search_document_ref_changed');
    if (window.location.href !== expected.url) return refuse('search_url_changed');
    // 4. observed query-field and submit identities, visibility/enabled state,
    //    readonly/inert ancestors, editor support, admitted submit kind.
    const field = wbSearchById(fieldId), submit = wbSearchById(submitId);
    if (!field || wbSearchObservedId(field) !== fieldId) return refuse('search_field_not_observed');
    if (!submit || wbSearchObservedId(submit) !== submitId) return refuse('search_submit_not_observed');
    if (!wbSearchFieldOk(field, expected.query_field.binding)) return refuse('search_field_state');
    if (!wbSearchSubmitOk(submit, expected.submit.control)) return refuse('search_submit_state');
    if (!wbSearchGuardsOk(expected.identity_guards)) return refuse('search_guard_drift');
    // An instance-level interceptor of the field's value property would shadow
    // the native setter/read contract; refuse rather than write through it.
    if (Object.hasOwn(field, 'value')) return refuse('search_field_value_intercepted');
    // 5. resolve the exactly-one activation BEFORE writing text: overrides are
    //    refused before any mutation of the page.
    const activation = wbSearchActivation(submit);
    if (activation.refused) return refuse(activation.refused);
    // 6. guarded set of the EXACT requested query (no normalization) through
    //    the prototype-native value setter with beforeinput/input/change.
    const correlation = { attribute: corr, injected: false, restored: false };
    const prev = corr === null ? null : { present: submit.hasAttribute(corr), value: submit.getAttribute(corr) };
    try {
      if (wbEditorKind(field) === 'contenteditable') {
        field.focus();
        const selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(field); selection.removeAllRanges(); selection.addRange(range);
        const ok = document.execCommand('insertText', false, query);
        if (!ok && wbReadText(field) !== query) return { submitted: false, effect_unknown: true, reason: 'search_insert_rejected', observed_field_value: wbReadText(field), correlation };
      } else {
        const proto = field.tagName === 'TEXTAREA' ? (typeof HTMLTextAreaElement !== 'undefined' && HTMLTextAreaElement.prototype) : (typeof HTMLInputElement !== 'undefined' && HTMLInputElement.prototype);
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (!setter || typeof setter.set !== 'function') return { submitted: false, reason: 'search_setter_unavailable', correlation };
        const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: query });
        if (!field.dispatchEvent(event)) return { submitted: false, effect_unknown: true, reason: 'search_beforeinput_rejected', correlation };
        setter.set.call(field, query);
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: query }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (e) {
      return { submitted: false, effect_unknown: true, reason: 'search_set_threw', cause: String(e && e.message || e), correlation };
    }
    // 7. FRESH recheck AFTER the event handlers and BEFORE the single
    //    activation: deadline, document, full field identity/state/value,
    //    submit identity/state, guards. A handler that reverted the text,
    //    disabled the control or moved the page makes the effect unknown —
    //    it NEVER activates the submit.
    if (Date.now() >= deadline) return { submitted: false, effect_unknown: true, reason: 'search_deadline_expired_after_set', correlation };
    if (wbSearchState().prefix !== expected.document_ref || window.location.href !== expected.url)
      return { submitted: false, effect_unknown: true, reason: 'search_document_changed_during_set', correlation };
    if (!wbSearchFieldOk(field, expected.query_field.binding) || wbSearchById(fieldId) !== field)
      return { submitted: false, effect_unknown: true, reason: 'search_field_drifted_after_set', correlation };
    const valueAfterSet = wbReadText(field);
    if (valueAfterSet !== query)
      return { submitted: false, effect_unknown: true, reason: 'search_field_value_mutated_after_set', observed_field_value: valueAfterSet, correlation };
    if (!wbSearchSubmitOk(submit, expected.submit.control) || wbSearchById(submitId) !== submit)
      return { submitted: false, effect_unknown: true, reason: 'search_submit_drifted_after_set', correlation };
    if (!wbSearchGuardsOk(expected.identity_guards))
      return { submitted: false, effect_unknown: true, reason: 'search_guard_drifted_after_set', correlation };
    // 8. exactly ONE synchronous submit activation (isTrusted stays false).
    try {
      if (corr !== null) { correlation.injected = true; submit.setAttribute(corr, opRef); }
      activation.call();
    } catch (e) {
      return { submitted: false, effect_unknown: true, reason: 'search_submit_threw', cause: String(e && e.message || e), correlation };
    } finally {
      if (correlation.injected) try { if (prev.present) submit.setAttribute(corr, prev.value); else submit.removeAttribute(corr); correlation.restored = true; } catch (_) {}
    }
    // 9. honest post-dispatch check. Identity/document drift during the
    //    activation makes the effect unknown; the query field may legitimately
    //    be cleared by the submit and its VALUE is never re-compared after it.
    try {
      if (wbSearchState().prefix !== expected.document_ref || window.location.href !== expected.url)
        return { submitted: true, effect_unknown: true, reason: 'search_document_changed_during_submit', correlation };
      if (wbSearchById(fieldId) !== field || !wbSearchFieldOk(field, expected.query_field.binding))
        return { submitted: true, effect_unknown: true, reason: 'search_field_drifted_during_submit', correlation };
      if (wbSearchById(submitId) !== submit || !wbSearchSubmitOk(submit, expected.submit.control))
        return { submitted: true, effect_unknown: true, reason: 'search_submit_drifted_during_submit', correlation };
      if (!wbSearchGuardsOk(expected.identity_guards))
        return { submitted: true, effect_unknown: true, reason: 'search_guard_drifted_during_submit', correlation };
      if (correlation.injected && !correlation.restored)
        return { submitted: true, effect_unknown: true, reason: 'search_correlation_restore_failed', correlation };
    } catch (e) {
      return { submitted: true, effect_unknown: true, reason: 'search_post_submit_check_failed', cause: String(e && e.message || e), correlation };
    }
    return { submitted: true, effect_unknown: false, reason: 'native_search_submit_completed', observed_field_value: wbReadText(field), correlation };
  })()`;
}

/** Independent capture: observed query-field binding and current exact value
 * (declared encodings only; may be empty), submit identity/state, guard
 * attribute values, document_ref/url. Only observed (WeakMap-present) IDs
 * resolve; malformed specs, opaque/unsupported editors and unrendered nodes
 * fail closed. Takes no requested query input, performs no writes and no
 * submit. The installed trusted search profile builds the final binding from
 * this read; this helper claims nothing about results. */
export function nativeSearchReadExpression(fieldId: string, submitId: string, identityGuards: ReadonlyArray<NativeSearchGuardSpec>, correlationAttribute?: string): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
${NATIVE_SEARCH_DOM_HELPERS}
    const fieldId=${JSON.stringify(fieldId)}, submitId=${JSON.stringify(submitId)}, guards=${JSON.stringify(identityGuards)}, corrAttr=${JSON.stringify(correlationAttribute ?? null)};
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fail = reason => ({ schema: 'native-search-read/1.1', ok: false, reason, document_ref: null, url: null, field: null, submit: null,
      identity_guards: [], correlation: corrAttr === null ? null : { attribute: corrAttr, observed: false, value: null } });
    if (typeof fieldId !== 'string' || typeof submitId !== 'string' || !Array.isArray(guards) || guards.length > 32) return fail('search_read_malformed');
    for (const g of guards) if (!object(g) || typeof g.node_id !== 'string' || !wbSearchAttrName(g.attribute)) return fail('search_read_malformed');
    if (corrAttr !== null && !wbSearchAttrName(corrAttr)) return fail('search_read_malformed');
    const state = wbSearchState();
    if (!state || typeof state.prefix !== 'string') return fail('search_document_unobserved');
    const fieldEl = wbSearchById(fieldId), submitEl = wbSearchById(submitId);
    const field = { observed: !!fieldEl,
      identity: fieldEl ? wbCurrentBinding(fieldEl) : null,
      state: fieldEl ? { visible: wbTextRendered(fieldEl), enabled: wbEnabled(fieldEl), readonly: wbReadonly(fieldEl), backend_supported: wbBackendSupported(fieldEl) } : null,
      value: fieldEl ? wbReadText(fieldEl) : null };
    const submit = { observed: !!submitEl,
      identity: submitEl ? wbSearchIdentity(submitEl) : null,
      state: submitEl ? { visible: wbTextRendered(submitEl), enabled: wbEnabled(submitEl), readonly: wbReadonly(submitEl), admitted: wbSearchAdmitted(submitEl) } : null };
    const guardResults = guards.map(g => { const el = wbSearchById(g.node_id);
      return { node_id: g.node_id, attribute: g.attribute, observed: !!el, value: el ? el.getAttribute(g.attribute) : null }; });
    const ok = !!fieldEl && !!submitEl && !!field.identity && field.value !== null && guardResults.every(g => g.observed);
    return { schema: 'native-search-read/1.1', ok, ...(ok ? {} : { reason: !fieldEl ? 'search_field_not_observed' : !submitEl ? 'search_submit_not_observed' : field.value === null ? 'search_field_value_unreadable' : undefined }),
      document_ref: state.prefix, url: window.location.href, field, submit, identity_guards: guardResults,
      correlation: corrAttr === null ? null : { attribute: corrAttr, observed: !!submitEl, value: submitEl ? submitEl.getAttribute(corrAttr) : null } };
  })()`;
}
