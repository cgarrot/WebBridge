/** Native text protocol shared by observation, guarded edits and fresh proof.
 * Identity maps contain DOM identities only; values are always read from DOM. */
export interface NativeTextBinding {
  schema: 'native-text-binding/1.1'; document_ref: string; url: string;
  target: {id:string;label:string;dom_id:string;name:string;role:string};
  editor_kind: 'native_input' | 'native_textarea' | 'contenteditable'; read_kind: 'value' | 'innerText';
  owner: { id: string; label: string; role: string; dom_id: string; source: string } | null;
  form: { id: string; label: string; dom_id: string; name: string } | null;
}
export const NATIVE_TEXT_DOM_HELPERS = String.raw`
  const wbName = el => {
    const refs = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (refs.length) {
      const parts = refs.map(id => document.getElementById(id));
      if (parts.every(Boolean)) return { label: parts.map(n => (n.textContent || '').trim()).join(' '), source: 'aria-labelledby' };
    }
    const label = el.getAttribute('aria-label');
    if (label !== null && label !== '') return { label, source: 'aria-label' };
    const labels = Array.from(el.labels || []).map(n => (n.textContent || '').trim()).join(' ');
    if (labels) return { label: labels, source: 'native-labels' };
    if (el.tagName === 'FORM') return { label: el.name || el.id || '', source: 'native-form-name' };
    if (['BUTTON','A','OPTION'].includes(el.tagName) || ['button','link','tab','menuitem'].includes(el.getAttribute('role')))
      return {label:(el.textContent||'').trim() || el.name || el.id || '',source:'native-control-text'};
    return { label: el.getAttribute('placeholder') || el.name || el.id || '', source: 'native-control-name' };
  };
  const wbScope = el => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const role = p.getAttribute('role') || (['ARTICLE','SECTION','FORM','MAIN'].includes(p.tagName) ? p.tagName.toLowerCase() : '');
      if (!['dialog','region','article','group','listitem','form','main','section'].includes(role)) continue;
      // A nearer dialog/article/form is an ownership boundary even unnamed.
      // Do not borrow a surrounding thread name across that boundary.
      if (wbName(p).label || ['dialog','article','form'].includes(role)) return p;
    }
    return null;
  };
  const wbScopeFact = (el, idOf) => {
    const name = wbName(el);
    return { id: idOf(el), label: name.label, role: el.getAttribute('role') || el.tagName.toLowerCase(), dom_id: el.id || '', source: name.source };
  };
  const wbFormFact = (el, idOf) => ({ id: idOf(el), label: wbName(el).label, dom_id: el.id || '', name: el.name || '' });
  const wbEditorKind = el => el.tagName === 'INPUT' ? 'native_input' : el.tagName === 'TEXTAREA' ? 'native_textarea'
    : el.isContentEditable === true ? 'contenteditable'
    : el.getAttribute('role') === 'textbox' || el.hasAttribute('contenteditable') ? 'opaque' : null;
  const wbReadKind = el => {
    const kind = wbEditorKind(el);
    return kind === 'native_input' || kind === 'native_textarea' ? 'value' : kind === 'contenteditable' ? 'innerText' : 'none';
  };
  const wbBackendSupported = el => wbEditorKind(el) === 'native_textarea'
    || wbEditorKind(el) === 'contenteditable' && !el.querySelector?.('[contenteditable],img,video,audio,canvas,[role="textbox"],[role="combobox"]')
    || wbEditorKind(el) === 'native_input' && ['text','search','email','url','tel'].includes(el.type || 'text');
  const wbTextRendered = el => {
    if(!el.isConnected)return false;
    const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
    return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && style.opacity!=='0';
  };
  const wbReadText = el => {
    const kind = wbReadKind(el);
    if (kind === 'value' && 'value' in el) return String(el.value);
    if (kind === 'innerText' && wbTextRendered(el) && typeof el.innerText === 'string') {
      // A browser's empty editing placeholder can contain BR/paragraph nodes.
      // Preserve all actual whitespace/text; collapse only a truly textless host.
      return el.textContent === '' && !el.querySelector?.('img,video,audio,canvas,[contenteditable="false"]') ? '' : el.innerText;
    }
    return null;
  };
  const wbEnabled = el => {
    if (el.matches(':disabled')) return false;
    for (let p = el; p; p = p.parentElement) if (p.getAttribute('aria-disabled') === 'true' || p.hasAttribute('inert')) return false;
    return true;
  };
  const wbReadonly = el => el.readOnly === true || el.getAttribute('aria-readonly') === 'true';
  const wbCurrentBinding = el => {
    const state = window[Symbol.for('webbridge.visible-dom.v2')];
    if (!state?.prefix || !state.ids?.get(el)) return null;
    const idOf = n => state.ids.get(n) || null;
    const scope = wbScope(el), form = 'form' in el ? el.form : null;
    return { schema: 'native-text-binding/1.1', document_ref: state.prefix, url: window.location.href,
      target:{id:idOf(el),label:wbName(el).label,dom_id:el.id||'',name:el.name||'',role:el.getAttribute('role')||''},
      editor_kind: wbEditorKind(el), read_kind: wbReadKind(el),
      owner: scope ? wbScopeFact(scope,idOf) : null, form: form ? wbFormFact(form,idOf) : null };
  };
  const wbBindingMatches = (el, expected) => {
    const actual = wbCurrentBinding(el);
    if (!actual || !expected || expected.schema !== 'native-text-binding/1.1') return false;
    for (const k of ['schema','document_ref','url','editor_kind','read_kind']) if (typeof expected[k] !== 'string' || actual[k] !== expected[k]) return false;
    for (const [key, fields] of [['target',['id','label','dom_id','name','role']],['owner',['id','label','role','dom_id','source']],['form',['id','label','dom_id','name']]]) {
      if (actual[key] === null || expected[key] === null) { if (actual[key] !== expected[key]) return false; continue; }
      if (!actual[key] || !expected[key]) return false;
      for (const k of fields) if (typeof expected[key][k] !== 'string' || actual[key][k] !== expected[key][k]) return false;
    }
    return true;
  };
`;
export function nativeTextReadExpression(nodeId: string, binding: unknown): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
    const id=${JSON.stringify(nodeId)}, expected=${JSON.stringify(binding)};
    const el=document.querySelector('[data-wb-id="'+CSS.escape(id)+'"]');
    return JSON.stringify({present:el!==null,value:el?wbReadText(el):null,binding_matches:!!el&&wbBindingMatches(el,expected)});
  })()`;
}
/** Guard and edit occur in one native call, with a second guard after focus. */
export function nativeTextEditExpression(nodeId: string, text: string, binding: unknown): string {
  return `(() => { ${NATIVE_TEXT_DOM_HELPERS}
    const id=${JSON.stringify(nodeId)}, expected=${JSON.stringify(binding)}, text=${JSON.stringify(text)};
    const lookup=()=>document.querySelector('[data-wb-id="'+CSS.escape(id)+'"]');
    const el=lookup();
    const admissible=()=>el&&wbTextRendered(el)&&lookup()===el&&wbBindingMatches(el,expected)&&wbEnabled(el)&&!wbReadonly(el)&&wbBackendSupported(el);
    if(!admissible())return {written:false,reason:'native_text_binding_changed'};
    if(wbEditorKind(el)==='contenteditable'){
      el.focus();
      if(!admissible()||document.activeElement!==el)return {written:false,reason:'native_text_focus_changed'};
      const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);
      if(!admissible()||document.activeElement!==el)return {written:false,reason:'native_text_focus_changed'};
      const ok=text===''?document.execCommand('delete',false,null):document.execCommand('insertText',false,text);
      if(!ok&&wbReadText(el)!==text)return {written:false,effect_unknown:true,reason:'native_text_insert_rejected'};
    }else{
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(!setter)return {written:false,reason:'native_text_setter_unavailable'};
      const event=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertReplacementText',data:text});
      if(!el.dispatchEvent(event))return {written:false,reason:'native_text_beforeinput_rejected'};
      if(!admissible())return {written:false,reason:'native_text_binding_changed'};
      setter.call(el,text);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:text}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    const bindingMatches=wbBindingMatches(el,expected);
    if(!admissible())return {written:true,value:wbReadText(el),binding_matches:bindingMatches,effect_unknown:true,reason:'native_text_context_changed_after_write'};
    return {written:true,value:wbReadText(el),binding_matches:bindingMatches};
  })()`;
}
