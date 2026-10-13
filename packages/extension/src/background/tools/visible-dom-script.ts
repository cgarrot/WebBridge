/** Document-local opaque identities survive repeated reads, insertion and reorder.
 * Scope is visible interactive controls plus options owned by visible selects. */
import { nativeScrollScopesExpression,nativeMediaObserveExpression,NATIVE_TEXT_DOM_HELPERS } from '@webbridge/shared';
const visibleDomScript = (includeContext: boolean, semanticContext = false) => `
(() => {
  const includeContext = ${includeContext};
  const semanticContext = ${semanticContext};
  ${NATIVE_TEXT_DOM_HELPERS}
  const key = Symbol.for('webbridge.visible-dom.v2');
  const state = window[key] ?? (window[key] = { ids: new WeakMap(), next: 0, prefix: 'n-' + crypto.randomUUID() });
  const INTERACTIVE = semanticContext ? 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="textbox"],[contenteditable],[onclick],[tabindex]' : 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick],[tabindex]';
  const seen = new Set();
  const nodes = [];
  const forms = new Map();
  const owners = new Map();
  const idOf = el => {
    let id = state.ids.get(el);
    if (!id) { id = state.prefix + '-' + (++state.next); state.ids.set(el, id); }
    el.setAttribute('data-wb-id', id);
    return id;
  };
  const append = (el, rect, selectRef) => {
    if (seen.has(el)) return;
    if (semanticContext && (el.tagName === 'FORM' || el.isContentEditable === true && !el.hasAttribute('contenteditable') && !['INPUT','TEXTAREA'].includes(el.tagName))) return;
    seen.add(el);
    const id = idOf(el);
    const tag = el.tagName.toLowerCase();
    const owner = includeContext && 'form' in el ? el.form : null;
    if (owner && !forms.has(owner)) forms.set(owner, { id: idOf(owner), tag: 'form',
      label: semanticContext ? wbName(owner).label : owner.getAttribute('aria-label') || owner.name || owner.id || '', dom_id: owner.id || '', name: owner.name || '' });
    const label = semanticContext ? wbName(el).label : includeContext ? Array.from(el.labels ?? []).map(x => (x.textContent || '').trim()).join(' ')
      || el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim() || el.name || el.id || '' : undefined;
    const selectOwner = includeContext && selectRef ? el.closest('select') : null;
    const scope = semanticContext ? wbScope(el) : null;
    if (scope && !owners.has(scope)) owners.set(scope, wbScopeFact(scope,idOf));
    const editorKind = semanticContext ? wbEditorKind(el) : null;
    nodes.push({ id, tag, text: (el.textContent || '').trim().substring(0, 80) || undefined,
      role: el.getAttribute('role') || undefined, href: el.getAttribute('href') || undefined,
      type: el.getAttribute('type') || undefined, placeholder: el.getAttribute('placeholder') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      value: semanticContext && editorKind ? wbReadText(el) ?? undefined : 'value' in el ? (includeContext ? String(el.value) : String(el.value).substring(0, 80)) : undefined,
      ...(includeContext ? { label, dom_id: el.id || '', name: el.name || '',
        enabled: !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && !(selectOwner && selectOwner.disabled),
        readonly: el.readOnly === true || el.getAttribute('aria-readonly') === 'true',
        ...('form' in el ? { form_ref: owner ? idOf(owner) : null } : {}),
        submits: !!owner && (tag === 'button' || tag === 'input') && el.type === 'submit' } : {}),
      ...(semanticContext ? { document_ref: state.prefix, owner_ref: scope ? idOf(scope) : null,
        form_ref: owner ? idOf(owner) : null, enabled: wbEnabled(el) && !(selectOwner && selectOwner.disabled),
        ...(tag === 'select' ? {selected_values:Array.from(el.options || []).filter(o=>o.selected===true).map(o=>String(o.value)).sort()} : {}),
        ...(tag === 'input' && el.type === 'checkbox' ? {checked:el.checked===true} : {}),
        ...(editorKind ? { editor_kind: editorKind, read_kind: wbReadKind(el), editor_backend_supported: wbBackendSupported(el) } : {}) } : {}),
      ...(selectRef ? { select_ref: selectRef } : {}),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
  };
  document.querySelectorAll(INTERACTIVE).forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
    append(el, rect);
    if (el.tagName === 'SELECT') for (const option of Array.from(el.options)) append(option, rect, idOf(el));
  });
  return includeContext ? { schema: semanticContext ? 'visible-dom/3.0' : 'visible-dom/2.0', nodes, forms: Array.from(forms.values()),
    ...(semanticContext ? { owners: Array.from(owners.values()) } : {}),
    page: { document_ref: state.prefix, url: window.location.href, title: document.title,
      ...(semanticContext ? {ready_state:document.readyState} : {}) } } : nodes;
})()
`;

export const GET_VISIBLE_DOM_SCRIPT = visibleDomScript(false);
export const GET_VISIBLE_DOM_CONTEXT_SCRIPT = visibleDomScript(true);
export const GET_VISIBLE_DOM_SEMANTIC_SCRIPT = visibleDomScript(true,true);

/** All reads execute synchronously in one task on the same document. */
export const GET_VISIBLE_DOM_BEHAVIOR_SCRIPT = `(() => {const base=(${GET_VISIBLE_DOM_SEMANTIC_SCRIPT});const scroll=(${nativeScrollScopesExpression()});const media=(${nativeMediaObserveExpression()});if(base.page.document_ref!==scroll.document_ref||base.page.document_ref!==media.document_ref||base.page.url!==scroll.url||base.page.url!==media.url)throw Error('behavior_document_incoherent');return {...base,schema:'visible-dom/4.0',scroll_scopes:scroll,media};})()`;
