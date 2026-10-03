import {isDeepStrictEqual} from 'node:util';
/**
 * WebBridgePrimitiveClient — unitary world primitives for the Zoma harness.
 * Review-5 B2 ruling: the HARNESS owns the loop; the daemon provides ONLY
 * observe/act/prove/is_applied/status as side-tools. No goal/flow/safety here.
 *
 * M1: basic wrappers (DOM → snapshot, click/type → action, re-read → prove).
 * M2: lease/epoch, atomic reservation, execution fence, value-aware prove.
 */

import {nativeScrollExpression,nativeMediaActExpression,nativeScrollReadExpression,nativeMediaReadExpression,evaluateScrollProof,evaluateMediaProof,mapScrollActionResult,mapMediaActionResult,nativeTextReadExpression } from '@webbridge/shared';

import {addBehaviorContext,type BehaviorTarget} from '@webbridge/shared';

// SideToolHandler type (inlined from daemon — semantic pkg doesn't import daemon)
export type SideToolHandler = (
  args: Record<string, unknown>,
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>
) => Promise<unknown>;

// ---- territory / lease state (M2) ----
interface LeaseState {
  lease_id: string;
  territory: string;     // tab id
  owner: string;
  epoch: number;
  acquired_at: number;
  snapshot_revision?: number;
  semantic_context?: boolean;
  behavior_context?: boolean;
  behavior_targets?:Map<string,BehaviorTarget>;
  behavior_results?:Map<string,unknown>;
}
const leases = new Map<string, LeaseState>();      // territory → lease
const reservations = new Map<string, string>();     // operation_id → action_id (in-flight)
const opsApplied = new Map<string, boolean | null>(); // null = effect unknown, do not retry
let epochCounter = 1;
let snapshotCounter = Date.now();
function tabOf(territory: string): number {
  const match = /^web:tab:([1-9]\d*)$/.exec(territory);
  const id = Number(match?.[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('primitive: explicit web:tab:<tabId> required');
  return id;
}

// ---- helpers ----
function leaseFor(territory: string): LeaseState | null {
  return leases.get(territory) ?? null;
}
function assertLease(territory: string, leaseId: string): void {
  const l = leases.get(territory);
  if (!l || l.lease_id !== leaseId)
    throw new Error(`lease_expired: territory=${territory} lease=${leaseId}`);
}

// ---- M1: observe (DOM snapshot → WorldSnapshot) ----
const primitiveObserve: SideToolHandler = async (args: Record<string, unknown>, call: (n: string, a?: Record<string, unknown>) => Promise<unknown>) => {
  const territory = String(args.territory ?? "");
  const leaseId = String(args.lease_id ?? "");
  if (!territory || !leaseId) throw new Error("primitive_observe: {territory, lease_id} required");
  assertLease(territory, leaseId);

  if (args.semantic_context !== undefined && typeof args.semantic_context !== 'boolean') throw Error('primitive_observe: invalid semantic context option');
  const semantic = args.semantic_context === true;
  if(args.behavior_context!==undefined&&typeof args.behavior_context!=='boolean'||args.behavior_context===true&&!semantic)throw Error('primitive_observe: invalid behavior context option');
  const behavior=args.behavior_context===true;
  const observation = args.observation as Record<string, unknown> | undefined;
  const capEntities = Number(process.env.WEBBRIDGE_PRIMITIVE_MAX_ENTITIES ?? 128);
  const capCandidates = Number(process.env.WEBBRIDGE_PRIMITIVE_MAX_CANDIDATES ?? 129);
  const maxEntities = Number(observation?.max_entities ?? (semantic ? Math.min(128,capEntities) : 14));
  const maxCandidates = Number(observation?.max_candidates ?? (semantic ? Math.min(129,capCandidates) : 21));
  if ((observation && observation.schema !== 'observation-request/1.0')
    || !Number.isSafeInteger(maxEntities) || maxEntities < 1 || maxEntities > capEntities
    || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > capCandidates)
    throw new Error('primitive_observe: invalid observation budget/schema');

  // R7-3: ALWAYS pass tabId (territory binding — never let the extension pick the active tab)
  const tabId = tabOf(territory);
  const dom = await call("get_visible_dom", { tabId, includeContext: true, ...(semantic ? { includeSemanticContext: true } : {}),...(behavior?{includeBehaviorContext:true}:{}) });
  if (!dom || (dom as any).error) throw new Error(`primitive_observe: dom_unavailable`);
  if (semantic && (dom as any).schema !== (behavior?'visible-dom/4.0':'visible-dom/3.0')) throw Error('semantic_context_unavailable');

  // Compile the raw DOM into a WorldSnapshot (entities + candidates)
  const d = dom as any;
  // get_visible_dom returns a RAW ARRAY of nodes (not {nodes:[...]}) — accept both
  const rawNodes: any[] = Array.isArray(d) ? d : (d.nodes ?? []);
  if ((!Array.isArray(d) && !Array.isArray(d.nodes)) || !Array.isArray(rawNodes) || rawNodes.some(n => typeof n.id !== 'string' || !n.id)
    || new Set(rawNodes.map(n => n.id)).size !== rawNodes.length) throw new Error('primitive_observe: ambiguous DOM identity');
  // Older extensions ignore the opt-in flag. Keep their historical shape and
  // never invent page/form facts from an array or an unversioned envelope.
  if (!Array.isArray(d) && d.schema !== undefined) {
    if (d.schema !== (behavior?'visible-dom/4.0':semantic ? 'visible-dom/3.0' : 'visible-dom/2.0')) throw new Error('primitive_observe: unknown DOM context schema');
    let projected = projectNativeContext(behavior?{...d,schema:'visible-dom/3.0'}:d, tabId, maxEntities, maxCandidates);
    let behaviorTargets:Map<string,BehaviorTarget>|undefined;
    if(behavior){const result=addBehaviorContext(d,tabId,projected,maxEntities,maxCandidates);projected=result.projected;behaviorTargets=result.targets;}
    const revision = ++snapshotCounter;
    assertLease(territory, leaseId);
    leases.get(territory)!.snapshot_revision = revision;
    leases.get(territory)!.semantic_context = semantic;
    leases.get(territory)!.behavior_context=behavior;leases.get(territory)!.behavior_targets=behaviorTargets;
    return { schema: behavior?'web/5.0':semantic ? 'web/3.0' : 'web/2.2', snapshot_revision: revision, ...projected };
  }
  const entities = rawNodes.slice(0, maxEntities).map((n: any) => ({
    id: n.id,
    type: mapTagToType(n.tag ?? n.tagName ?? ""),
    attrs: { label: n.text ?? n.label ?? "", ...(n.value ? { value: String(n.value) } : {}),
         },
  }));
  // Candidates only reference admitted entities; STOP always has its own slot.
  const candidates = rawNodes.slice(0, Math.min(maxEntities, maxCandidates - 1)).map((n: any) => ({
    action: n.tag === "input" || n.tag === "textarea" ? "TYPE" : "CLICK",
    arg: n.id ?? null,
  }));
  candidates.push({ action: "STOP", arg: null });

  // DOM property vs attribute (R8): get_visible_dom reads ATTRIBUTES (initial HTML),
  // but typed values live in the VALUE PROPERTY. Re-read via JS evaluation.
  try {
    const valueRead = await call("evaluate", { tabId, expression:
      "(() => { const out = {}; document.querySelectorAll('[data-wb-id]').forEach(el => { if ('value' in el && el.value !== '') out[el.getAttribute('data-wb-id')] = String(el.value); }); return JSON.stringify(out); })()"
    });
    if (valueRead) {
      const liveValues = JSON.parse(String(valueRead));
      for (const e of entities) {
        if (e.type === "field" && liveValues[e.id] !== undefined) {
          (e.attrs as any).value = liveValues[e.id];
        }
      }
    }
  } catch { /* value re-read is best-effort — snapshot still valid without it */ }

  const revision = ++snapshotCounter;
  assertLease(territory, leaseId); // a late observation must not update a new owner's lease
  leases.get(territory)!.snapshot_revision = revision;
  leases.get(territory)!.semantic_context = false;
  return {
    schema: "web/2.1",
    snapshot_revision: revision,
    entities,
    relations: [],
    candidates,
    limits: { truncated: { entities: d.truncated === true || rawNodes.length > entities.length, candidates: d.truncated === true || rawNodes.length + 1 > candidates.length },
      counts: { entities: rawNodes.length, candidates: rawNodes.length + 1 },
      applied: { max_entities: maxEntities, max_candidates: maxCandidates },
      scope: 'visible_interactive_controls_and_select_options' },
    goal: { pred: "VIEW", args: { view: entities[0]?.id ?? "page" } },
  };
};

/** Bounded reference closure: tab + admitted controls + their native owners.
 * Context entities count against max_entities; forms never become click targets. */
function projectNativeContext(d: any, tabId: number, maxEntities: number, maxCandidates: number) {
  const semantic = d.schema === 'visible-dom/3.0';
  const invalid = () => { throw new Error('primitive_observe: invalid native DOM context'); };
  if (d.tabId !== tabId || !d.page || typeof d.page.document_ref !== 'string' || !d.page.document_ref
    || typeof d.page.url !== 'string' || typeof d.page.title !== 'string' || !Array.isArray(d.forms)) invalid();
  const viewId = `web:tab:${tabId}:view`;
  const all = [...d.nodes, ...d.forms];
  if (all.some(n => !n || typeof n.id !== 'string' || !n.id || n.id === viewId)
    || new Set(all.map(n => n.id)).size !== all.length) invalid();
  const forms = new Map<string, any>(d.forms.map((f: any) => [f.id, f]));
  const nodeById = new Map<string, any>(d.nodes.map((n: any) => [n.id, n]));
  if (semantic && !Array.isArray(d.owners)) invalid();
  if(semantic&&!['loading','interactive','complete'].includes(d.page.ready_state))invalid();
  const owners = new Map<string, any>(semantic ? d.owners.map((o: any) => [o?.id,o]) : []);
  if (semantic && owners.size !== d.owners.length) invalid();
  for (const o of owners.values()) {
    if (!o || typeof o.id !== 'string' || !o.id || o.id === viewId
      || ['label','role','dom_id','source'].some(k => typeof o[k] !== 'string') || !o.source
      || !['dialog','region','article','group','listitem','form','main','section'].includes(o.role)) invalid();
    const form = forms.get(o.id);
    if (form && (form.label !== o.label || form.dom_id !== o.dom_id)) invalid();
  }
  for (const f of d.forms) if (f.tag !== 'form' || typeof f.label !== 'string'
    || typeof f.dom_id !== 'string' || typeof f.name !== 'string') invalid();
  for (const n of d.nodes) {
    if (typeof n.tag !== 'string' || n.tag === 'form' || typeof n.label !== 'string'
      || typeof n.dom_id !== 'string' || typeof n.name !== 'string' || typeof n.enabled !== 'boolean'
      || typeof n.readonly !== 'boolean' || typeof n.submits !== 'boolean'
      || (n.value !== undefined && typeof n.value !== 'string')
      || (n.selected_values !== undefined && (n.tag !== 'select'||!Array.isArray(n.selected_values)||n.selected_values.some((v:unknown)=>typeof v!=='string')))
      || (n.checked !== undefined && (n.tag !== 'input'||n.type !== 'checkbox'||typeof n.checked !== 'boolean'))
      || (n.form_ref !== undefined && n.form_ref !== null && !forms.has(n.form_ref))
      || (n.submits && (!forms.has(n.form_ref) || !['input', 'button'].includes(n.tag)))
      || (n.select_ref !== undefined && (n.tag !== 'option' || nodeById.get(n.select_ref)?.tag !== 'select'))) invalid();
    if (semantic && (n.document_ref !== d.page.document_ref || n.owner_ref !== null && !owners.has(n.owner_ref)
      || n.form_ref !== null && !forms.has(n.form_ref))) invalid();
    if (semantic && n.editor_kind !== undefined && (!['native_input','native_textarea','contenteditable','opaque'].includes(n.editor_kind)
      || !['value','innerText','none'].includes(n.read_kind) || typeof n.editor_backend_supported !== 'boolean'
      || n.editor_kind === 'native_input' && n.tag !== 'input' || n.editor_kind === 'native_textarea' && n.tag !== 'textarea'
      || n.editor_kind === 'opaque' && (n.editor_backend_supported !== false || n.read_kind !== 'none')
      || n.editor_kind === 'contenteditable' && n.read_kind !== 'innerText'
      || ['native_input','native_textarea'].includes(n.editor_kind) && n.read_kind !== 'value')) invalid();
  }
  const entities: Array<{ id: string; type: string; attrs: Record<string, unknown> }> = [{ id: viewId, type: 'view',
    attrs: { label: `Tab ${tabId}`, tab_id: tabId, ...d.page } }];
  const relations: Array<{ subj: string; pred: string; obj: string }> = [];
  const admitted = new Set([viewId]);
  const candidates: Array<{ action: string; arg: string | null }> = [];
  if (maxCandidates > 1) candidates.push({ action: 'NAVIGATE', arg: viewId });
  const contextEntity = (ref: string) => {
    const form = forms.get(ref), scope = owners.get(ref);
    return { id:ref,type:form?'form':'semantic_scope',attrs:{ ...(form ? {label:form.label,dom_id:form.dom_id,name:form.name} : {label:scope.label,dom_id:scope.dom_id}),
      ...(scope ? {scope_role:scope.role,scope_source:scope.source} : {}), ...(semantic ? {document_ref:d.page.document_ref} : {}) } };
  };
  const controls = semantic ? d.nodes.filter((n: any) => !owners.has(n.id)) : d.nodes;
  for (const n of controls) {
    const owner = n.form_ref ? forms.get(n.form_ref) : undefined;
    const contextRefs = [...new Set([...(owner ? [owner.id] : []), ...(semantic && n.owner_ref ? [n.owner_ref] : [])])].filter(ref => !admitted.has(ref));
    if (entities.length + 1 + contextRefs.length > maxEntities) break;
    // Selects precede their options in the native reader. Never orphan an option.
    if (n.select_ref && !admitted.has(n.select_ref)) invalid();
    for (const ref of contextRefs) { entities.push(contextEntity(ref));admitted.add(ref); }
    const mapped = mapTagToType(n.tag);
    const type = semantic && ['contenteditable','opaque'].includes(n.editor_kind) ? 'editor' : n.tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(n.type) ? 'button'
      : n.role === 'button' ? 'button' : n.role === 'link' ? 'link' : mapped === 'view' ? 'element' : mapped;
    const { id: _id, tag: _tag, rect: _rect, text: _text, ...attrs } = n;
    entities.push({ id: n.id, type, attrs }); admitted.add(n.id);
    if (owner) relations.push({ subj: n.id, pred: 'part_of', obj: owner.id });
    if (n.submits) relations.push({ subj: n.id, pred: 'submits', obj: owner.id });
    if (semantic && n.owner_ref) relations.push({subj:n.id,pred:'in_scope',obj:n.owner_ref});
    if (candidates.length < maxCandidates - 1) candidates.push({ action: type === 'field' || type === 'editor' ? 'TYPE' : 'CLICK', arg: n.id });
  }
  candidates.push({ action: 'STOP', arg: null });
  const totalEntities = semantic ? 1 + new Set([...controls.map((n: any) => n.id),...forms.keys(),...owners.keys()]).size : 1 + d.nodes.length + d.forms.length;
  const totalCandidates = 2 + controls.length;
  return { entities, relations, candidates, goal: { pred: 'VIEW', args: { view: viewId } },
    limits: { truncated: { entities: d.truncated === true || entities.length < totalEntities || semantic&&d.page.ready_state!=='complete',
      candidates: d.truncated === true || candidates.length < totalCandidates || semantic&&d.page.ready_state!=='complete' },
      counts: { entities: totalEntities, candidates: totalCandidates },
      applied: { max_entities: maxEntities, max_candidates: maxCandidates },
      scope: semantic ? 'explicit_tab_visible_controls_and_observed_semantic_scopes' : 'explicit_tab_and_visible_controls_with_native_form_owners' } };
}

function mapTagToType(tag: string): string {
  const t = tag.toLowerCase();
  if (t === "input" || t === "textarea") return "field";
  if (t === "button") return "button";
  if (t === "select") return "select";
  if (t === "option") return "option";
  if (t === "form") return "form";
  if (t === "a") return "link";
  return "view";
}

/** Only validate transport shape here; actual identity/state is rechecked in the native call. */
function validTextBinding(binding: any, target: unknown): boolean {
  const strings = (v: any, keys: string[]) => !!v && keys.every(k => typeof v[k] === 'string');
  return strings(binding,['schema','document_ref','url','editor_kind','read_kind'])
    && binding.schema==='native-text-binding/1.1' && !!binding.document_ref && !!binding.url
    && strings(binding.target,['id','label','dom_id','name','role']) && binding.target.id===target
    && ['native_input','native_textarea','contenteditable'].includes(binding.editor_kind)
    && binding.read_kind===(binding.editor_kind==='contenteditable'?'innerText':'value')
    && (binding.owner===null || strings(binding.owner,['id','label','role','dom_id','source']) && !!binding.owner.id)
    && (binding.form===null || strings(binding.form,['id','label','dom_id','name']) && !!binding.form.id);
}

// ---- M1+M2: act (unitary, with reservation + fence) ----
const primitiveAct: SideToolHandler = async (args: Record<string, unknown>, call: (n: string, a?: Record<string, unknown>) => Promise<unknown>) => {
  const territory = String(args.territory ?? "");
  const leaseId = String(args.lease_id ?? "");
  assertLease(territory, leaseId);
  const a = args.action as any;
  if (!a || !a.kind || !a.operation_id) throw new Error("primitive_act: {action:{kind,operation_id,...}} required");

  // Scope operation identity to THIS territory (R2-2: dedup is per-territory)
  const scopedOp = `${territory}::${a.operation_id}`;
  const revision = leases.get(territory)!.snapshot_revision;
  // Positive is insufficient: the request must bind the last observation of this lease.
  if (revision === undefined || a.valid_under_snapshot !== revision)
    return { action_id: a.action_id, status: "not_executed",
      error: { kind: "StaleSnapshot", have: a.valid_under_snapshot, want: revision ?? 0 } };
  const boundType=a.kind==='TYPE' && (a.params?.binding!==undefined || leases.get(territory)!.semantic_context===true);
  if(boundType && leases.get(territory)!.semantic_context!==true)
    return {action_id:a.action_id,status:'not_executed',error:{kind:'NativeTextContextUnavailable'}};
  if(boundType && !validTextBinding(a.params?.binding,a.target_ref))
    return {action_id:a.action_id,status:'not_executed',error:{kind:'NativeTextBindingInvalid'}};
  const boundBehavior=a.kind==='SCROLL'||a.kind==='MEDIA';
  const behaviorTarget=leases.get(territory)!.behavior_targets?.get(a.target_ref);
  if(boundBehavior&&(!leases.get(territory)!.behavior_context||!behaviorTarget||behaviorTarget.kind!==a.kind|| !isDeepStrictEqual(behaviorTarget.binding,a.params?.binding)||!Number.isSafeInteger(a.params?.deadline_at_ms)||Date.now()>=a.params.deadline_at_ms||a.kind==='SCROLL'&&!['down','up'].includes(a.params?.direction)||a.kind==='MEDIA'&&!['playing','paused'].includes(a.params?.desired)))return {action_id:a.action_id,status:'not_executed',error:{kind:'BehaviorBindingInvalidOrExpired'}};
  const boundCommit=a.kind==='COMMIT';
  if(boundCommit && (leases.get(territory)!.semantic_context!==true || a.params?.commit_binding?.schema!=='native-commit-binding/1.0'
    ||a.params.commit_binding.control_id!==a.target_ref||!Number.isSafeInteger(a.params?.deadline_at_ms)))
    return {action_id:a.action_id,status:'not_executed',error:{kind:'NativeCommitBindingInvalid'}};
  if(boundCommit&&Date.now()>=a.params.deadline_at_ms)return {action_id:a.action_id,status:'not_executed',error:{kind:'NativeCommitExpired'}};
  // M2: atomic reservation (concurrent same-op → conflict)
  const holder = reservations.get(scopedOp);
  if (holder)
    return { action_id: a.action_id, status: "not_executed",
      error: { kind: "ReservationConflict", operation_id: a.operation_id, holder } };
  reservations.set(scopedOp, a.action_id);

  // R2-2 dedup: keyed by scoped operation_id ONLY (content hash = verification, never identity)
  const prior = opsApplied.get(scopedOp);
  if(boundCommit && prior===false){reservations.delete(scopedOp);return {action_id:a.action_id,status:'not_executed',state_revision:0,snapshot_revision:revision,proofs:[],error:{kind:'NativeCommitClosed'}};}
  if (opsApplied.has(scopedOp) && prior === null) {
    reservations.delete(scopedOp);
    return { action_id: a.action_id, status: "effect_unknown", state_revision: 0, snapshot_revision: revision, proofs: [],
      error: { kind: "ActionTimeout", action_id: a.action_id, executed: null } };
  }
  if (prior === true) {
    reservations.delete(scopedOp);
    return { action_id: a.action_id, status: "executed", state_revision: 0, snapshot_revision: 0, proofs: [], duplicate: true };
  }

  // R7-2: fence BEFORE the extension call (deadline_ms:0 must NEVER execute)
  if (typeof a.deadline_ms === "number" && a.deadline_ms <= 0) {
    reservations.delete(scopedOp);
    return { action_id: a.action_id, status: "not_executed",
      error: { kind: "Fenced", action_id: a.action_id, deadline_ms: a.deadline_ms } };
  }

  // Dispatch to the extension's native tools — R7-3: ALWAYS pass tabId (territory binding)
  const tabId = tabOf(territory);
  try {
    let result: any;
    switch (a.kind) {
      case "TYPE":
        // R7 Chrome: focus:false = SET_VALUE_EXPRESSION path (atomic clear+set in ONE JS call,
        // no keyboard simulation, no focus race). The earlier "didn't land" report was a stale daemon.
        // R11 (Phase 4): honor params.focus for framework-managed inputs (YouTube Polymer combobox
        // resets programmatic sets → ActionTimeout). Default stays false (R8 semantics unchanged).
        const wantFocus = a.params?.focus === true;
        result = await call("type_element", { tabId, nodeId: String(a.target_ref), text: String(a.params?.text ?? ""), clearFirst: true, focus: wantFocus,
          ...(a.params?.binding !== undefined ? { binding: a.params.binding } : {}) });
        if (a.params?.binding !== undefined && (!result || !['executed','not_executed','effect_unknown'].includes(result.status))) throw Error('native_text_status_unobserved');
        if(boundType && result.status==='executed' && (result.written!==true || result.binding_matches!==true))
          result={...result,status:'effect_unknown',reason:'native_text_ack_context_unproven'};
        if (a.params?.binding !== undefined && result.status !== 'executed') {
          reservations.delete(scopedOp);opsApplied.set(scopedOp,result.status==='effect_unknown'?null:false);
          return { action_id:a.action_id,status:result.status,state_revision:0,snapshot_revision:revision,proofs:[],error:{kind:result.reason??'NativeTextNotExecuted'} };
        }
        break;
      case "CLICK":
        result = await call("click_element", { tabId, nodeId: a.target_ref });
        break;
      case 'COMMIT':
        result=await call('click_element',{tabId,nodeId:a.target_ref,commitBinding:a.params.commit_binding,
          deadlineAtMs:a.params.deadline_at_ms,operationRef:a.operation_id});
        if(!result||!['executed','not_executed','effect_unknown'].includes(result.status))throw Error('native_commit_status_unobserved');
        if(result.status==='executed'&&result.dispatched!==true||result.status==='not_executed'&&result.dispatched!==false)
          result={...result,status:'effect_unknown',reason:'native_commit_ack_unproven'};
        if(result.status!=='executed'){
          reservations.delete(scopedOp);opsApplied.set(scopedOp,result.status==='effect_unknown'?null:false);
          return {action_id:a.action_id,status:result.status,state_revision:0,snapshot_revision:revision,proofs:[],error:{kind:result.reason??'NativeCommitNotExecuted'}};
        }
        break;
      case 'SCROLL': case 'MEDIA': {
        const binding=behaviorTarget!.binding as any;
        if(a.kind==='SCROLL'&&!['down','up'].includes(a.params?.direction)||a.kind==='MEDIA'&&!['playing','paused'].includes(a.params?.desired))throw Error('behavior_semantic_parameter_invalid');
        const expression=a.kind==='SCROLL'?nativeScrollExpression(binding.container?.id??null,binding,a.params.direction,a.params.deadline_at_ms):nativeMediaActExpression(binding.media.id,binding,a.params.desired,a.params.deadline_at_ms);
        const raw:any=await call('evaluate',{tabId,expression});result=typeof raw?.value==='string'?JSON.parse(raw.value):raw?.value??raw;
        const mapped=a.kind==='SCROLL'?mapScrollActionResult(result):mapMediaActionResult(result);
        const stored=leases.get(territory)!;stored.behavior_results??=new Map();stored.behavior_results.set(a.operation_id,result);
        if(mapped.status!=='executed'){reservations.delete(scopedOp);opsApplied.set(scopedOp,mapped.status==='effect_unknown'?null:false);return {action_id:a.action_id,status:mapped.status,state_revision:0,snapshot_revision:revision,proofs:[{kind:'native',detail:{behavior_result:result}}],error:{kind:mapped.reason}};}
        break;
      }
      case "SELECT":
        result = await call("click_element", { tabId, nodeId: a.params?.option_ref ?? a.target_ref });
        break;
      case "NAVIGATE":
        result = await call("navigate", { tabId, url: a.params?.url ?? "" });
        break;
      case "STOP":
        reservations.delete(scopedOp);
        return { action_id: a.action_id, status: "not_executed", state_revision: 0, snapshot_revision: 0, proofs: [] };
      default:
        reservations.delete(scopedOp);
        opsApplied.set(scopedOp, false);
        return { action_id: a.action_id, status: "not_executed",
          error: { kind: "OriginMismatch" } };
    }

    // R7-2: no post-execution fence reversal (the call already happened —
    // report the HONEST status; reconciliation is the harness's job)
    opsApplied.set(scopedOp, true);
    reservations.delete(scopedOp);
    return {
      action_id: a.action_id, status: "executed",...(boundBehavior?{mutated:result.dispatched===true}:{}),
      state_revision: Date.now(), snapshot_revision: Date.now(),
      proofs: [{ kind: "native", detail: { applied: a.kind, target: a.target_ref,...(boundBehavior?{behavior_result:result}: {}) } }],
    };
  } catch (e) {
    opsApplied.set(scopedOp, null);
    reservations.delete(scopedOp);
    return { action_id: a.action_id, status: "effect_unknown", state_revision: 0, snapshot_revision: revision, proofs: [],
      error: boundType||boundCommit ? {kind:boundCommit?'NativeCommitProviderError':'NativeTextProviderError',cause:e instanceof Error?e.message:String(e),action_id:a.action_id,executed:null}
        : { kind: "ActionTimeout", action_id: a.action_id, executed: null } };
  }
};

// ---- M1: prove (value-aware re-read) ----
const primitiveProve: SideToolHandler = async (args: Record<string, unknown>, call: (n: string, a?: Record<string, unknown>) => Promise<unknown>) => {
  const territory = String(args.territory ?? "");
  const leaseId = String(args.lease_id ?? "");
  assertLease(territory, leaseId);
  const pc = args.postcondition as any;
  if (!pc || !pc.pred) throw new Error("primitive_prove: {postcondition:{pred,args,...}} required");

  const fieldArg = pc.args?.target ?? pc.args?.field;
  const fieldRef = fieldArg?.ref ?? fieldArg;
  const expected = pc.expected_value ?? pc.args?.value?.value;

  if(pc.behavior_context){
    const c=pc.behavior_context,target=leases.get(territory)!.behavior_targets?.get(fieldRef),unknown=(reason:string)=>({kind:'native',detail:{post_id:pc.post_id,verdict:'UNKNOWN',reason}});
    if(!target||c.schema!=='behavior-proof-context/1.0'||target.kind!==c.kind||!isDeepStrictEqual(target.binding,c.binding)||typeof c.operation_id!=='string')return unknown('behavior_proof_binding_unavailable');
    const read=async()=>{const b=c.binding;const expression=c.kind==='SCROLL'?nativeScrollReadExpression(b.container?.id??null,b):nativeMediaReadExpression(b.media.id,b);const raw:any=await call('evaluate',{tabId:tabOf(territory),expression});return typeof raw?.value==='string'?JSON.parse(raw.value):raw?.value??raw;};
    try{
      const action_result=leases.get(territory)!.behavior_results?.get(c.operation_id);
      const earlier_read=await read();let fresh_read=earlier_read;
      if(c.kind==='MEDIA'&&c.desired==='playing'){await new Promise(r=>setTimeout(r,160));assertLease(territory,leaseId);fresh_read=await read();}
      const verdict=c.kind==='SCROLL'?evaluateScrollProof(c.direction,action_result,fresh_read):evaluateMediaProof(c.desired,fresh_read,earlier_read);
      return {kind:'native',detail:{post_id:pc.post_id,...verdict,satisfied:verdict.verdict==='SATISFIED',binding_matches:fresh_read?.binding_matches===true,operation_id:c.operation_id,action_result,earlier_read,fresh_read}};
    }catch{return unknown('behavior_fresh_read_failed');}
  }
  if (pc.pred !== "SET") return null;

  // Semantic edits require a fresh, independently guarded DOM read. No cache
  // and no legacy proof fallback when the provider cannot read the binding.
  const tabId = tabOf(territory);
  if(pc.native_context){
    try{
      const result:any=await call('evaluate',{tabId,expression:nativeTextReadExpression(String(fieldRef),pc.native_context)});
      const observed=typeof result?.value==='string'?JSON.parse(result.value):null;
      if(!observed || typeof observed.present!=='boolean'||typeof observed.binding_matches!=='boolean'
        || !(observed.value===null||typeof observed.value==='string'))throw Error('native_context_unobserved');
      const satisfied=observed.present && observed.binding_matches && (expected===undefined?observed.value!==null&&observed.value!=='':observed.value===String(expected));
      return {kind:'native',detail:{post_id:pc.post_id,satisfied,field:String(fieldRef),observed:observed.value,binding_matches:observed.binding_matches}};
    }catch{return {kind:'native',detail:{post_id:pc.post_id,verdict:'UNKNOWN',reason:'native_context_unobserved'}};}
  }
  // Value-aware: re-read the field from the DOM
  try {
    const el = await call("get_visible_dom", { tabId });
    // R7-1: INDEPENDENT DOM read — no request-side value cache exists.
    // If the node is absent from the DOM, observed stays undefined = NOT satisfied.
    const nodes = (Array.isArray(el) ? el : ((el as any)?.nodes ?? [])) as any[];
    const node = nodes.find((n: any) => n.id === fieldRef);
    const observed = node?.value;  // No fallback to the requested value
    const filled = observed !== undefined && observed !== "";
    let valueOk: boolean;
    if (expected === undefined) valueOk = true;
    else if (observed === undefined) valueOk = false;
    else valueOk = String(observed) === String(expected);

    return { kind: "native", detail: { post_id: pc.post_id, satisfied: filled && valueOk,
      field: String(fieldRef), value_ok: valueOk, observed: observed ?? null } };
  } catch {
    return { kind: "native", detail: { post_id: pc.post_id, satisfied: false,
      reason: "field_not_found", field: String(fieldRef) } };
  }
};

// ---- M1: isApplied ----
const primitiveIsApplied: SideToolHandler = async (args: Record<string, unknown>) => {
  const op = String(args.operation_id ?? "");
  const territory = String(args.territory ?? "");
  assertLease(territory, String(args.lease_id ?? ""));
  const key = `${territory}::${op}`;
  if (reservations.has(key)) return null;
  if (opsApplied.has(key)) return opsApplied.get(key)!;
  return false;
};

// ---- M1: status ----
const primitiveStatus: SideToolHandler = async () => {
  return { state: "active", epoch: epochCounter,
    pending_actions: [...reservations.values()], leases: [...leases.keys()] };
};

// ---- M2: acquire / release ----
const primitiveAcquire: SideToolHandler = async (args: Record<string, unknown>) => {
  const territory = String(args.territory ?? "");
  const owner = String(args.owner ?? "run:1");
  if (!territory) throw new Error("primitive_acquire: {territory} required");
  tabOf(territory);
  if (leases.has(territory)) return { kind: "TerritoryBusy" };
  const lease: LeaseState = { lease_id: crypto.randomUUID(), territory, owner,
    epoch: epochCounter, acquired_at: Date.now() };
  leases.set(territory, lease);
  return lease;
};

const primitiveRelease: SideToolHandler = async (args: Record<string, unknown>) => {
  const territory = String(args.territory ?? "");
  const leaseId = String(args.lease_id ?? "");
  assertLease(territory, leaseId);
  leases.delete(territory);
};

// ---- cancel (port contract: stop an in-flight action) ----
const primitiveCancel: SideToolHandler = async (args: Record<string, unknown>) => {
  const territory = String(args.territory ?? "");
  const leaseId = String(args.lease_id ?? "");
  assertLease(territory, leaseId);
  const actionId = String(args.action_id ?? "");
  if (!actionId) throw new Error("primitive_cancel: {action_id} required");
  // Extension calls cannot currently be interrupted. Keep their reservation and
  // report unknown until they settle; cancellation must never free a retry slot.
  const isPending = [...reservations].some(([op, holder]) => op.startsWith(`${territory}::`) && holder === actionId);
  if (isPending) {
    return "unknown";
  }
  return "executed_then_cancelled";
};

// ---- registration ----
export function registerPrimitiveSideTools(sideTools: Map<string, SideToolHandler>): void {
  sideTools.set("primitive_observe", primitiveObserve);
  sideTools.set("primitive_act", primitiveAct);
  sideTools.set("primitive_prove", primitiveProve);
  sideTools.set("primitive_is_applied", primitiveIsApplied);
  sideTools.set("primitive_status", primitiveStatus);
  sideTools.set("primitive_cancel", primitiveCancel);
  
  sideTools.set("primitive_acquire", primitiveAcquire);
  sideTools.set("primitive_release", primitiveRelease);
}
