/** Additive bounded facts from ONE visible-dom/4.0 native read. */
import type {NativeMediaBinding,NativeScrollBinding} from './native-behavior.js';
export interface BehaviorTarget {kind:'SCROLL'|'MEDIA';binding:NativeScrollBinding|NativeMediaBinding}
interface Projected {entities:Array<{id:string;type:string;attrs:Record<string,unknown>}>;relations:Array<{subj:string;pred:string;obj:string}>;candidates:Array<{action:string;arg:string|null}>;limits:any;goal:{pred:string;args:{view:string}}}
const obj=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fact=(v:any)=>obj(v)&&['id','tag','label','name_source','role','dom_id'].every(k=>typeof v[k]==='string')&&!!v.id;
const owner=(v:any)=>v===null||obj(v)&&['id','label','role','dom_id','source'].every(k=>typeof v[k]==='string')&&!!v.id;
export function addBehaviorContext(d:any,tabId:number,base:Projected,maxEntities:number,maxCandidates:number):{projected:Projected;targets:Map<string,BehaviorTarget>} {
 const bad=()=>{throw Error('primitive_observe: invalid coherent behavior context');};
 const scroll=d.scroll_scopes,media=d.media;
 if(d.schema!=='visible-dom/4.0'||!obj(scroll)||scroll.schema!=='native-scroll-scopes/1.0'||scroll.document_ref!==d.page.document_ref||scroll.url!==d.page.url||!Array.isArray(scroll.containers)||scroll.containers.length>32||typeof scroll.truncated!=='boolean'||!Number.isInteger(scroll.scanned)||scroll.scanned<0
  ||!obj(media)||media.schema!=='native-media-observation/1.0'||media.document_ref!==d.page.document_ref||media.url!==d.page.url||!Array.isArray(media.media)||media.media.length>64||typeof media.truncated!=='boolean'||!Number.isInteger(media.total)||media.total<media.media.length)bad();
 const entities=base.entities,relations=base.relations,candidates=base.candidates.filter(c=>c.action!=='STOP'),targets=new Map<string,BehaviorTarget>();
 let truncated=scroll.truncated||media.truncated;
 const extra:any[]=[...(scroll.document?[scroll.document]:[]),...scroll.containers,...media.media];
 const ids=new Set<string>();let possible=0;
 for(const item of extra){
  const isMedia=item.schema==='native-media/1.0',isScroll=item.schema==='native-scroll-scope/1.0';
  if(!isMedia&&!isScroll||typeof item.rendered!=='boolean'||!owner(item.owner)||['tag','label','name_source','role','dom_id'].some(k=>typeof item[k]!=='string'))bad();
  if(isScroll&&(!['document','container'].includes(item.scope_kind)||typeof item.scrollable!=='boolean'||typeof item.overflow_y!=='string'||!['scroll_top','scroll_height','client_height'].every(k=>typeof item[k]==='number'&&Number.isFinite(item[k]))||item.scroll_height<0||item.client_height<0||item.scope_kind==='document'&&item.id!==null||item.scope_kind==='container'&&!fact(item)))bad();
  if(isMedia&&(!fact(item)||!['video','audio'].includes(item.tag)||!obj(item.source)||typeof item.source.current_src!=='string'||typeof item.source.src_attr!=='string'||typeof item.paused!=='boolean'||typeof item.ended!=='boolean'||!Number.isInteger(item.ready_state)||item.ready_state<0||item.ready_state>4||typeof item.connected!=='boolean'||typeof item.muted!=='boolean'))bad();
  const id=isScroll&&item.scope_kind==='document'?`web:tab:${tabId}:scroll-document`:item.id+(isMedia?'::media':'::scroll');
  if(ids.has(id)||entities.some(e=>e.id===id))bad();ids.add(id);possible++;
  const ownerId=item.owner?.id??null,existing=ownerId?entities.find(e=>e.id===ownerId):undefined;
  if(existing&&['label','dom_id'].some(k=>existing.attrs[k]!==item.owner[k])||existing&&['scope_role','scope_source'].some((k,i)=>existing.attrs[k]!==item.owner[i===0?'role':'source']))bad();
  if(entities.length+1+(ownerId&&!existing?1:0)>maxEntities){truncated=true;continue;}
  if(ownerId&&!existing){entities.push({id:ownerId,type:'semantic_scope',attrs:{label:item.owner.label,dom_id:item.owner.dom_id,scope_role:item.owner.role,scope_source:item.owner.source,document_ref:d.page.document_ref}});}
  const attrs={id,native_id:item.id,document_ref:d.page.document_ref,tag:item.tag,label:item.label,name_source:item.name_source,role:item.role,dom_id:item.dom_id,owner_ref:ownerId,form_ref:null,
   ...(isMedia?{current_src:item.source.current_src,src_attr:item.source.src_attr,source_present:item.source.current_src!==''||item.source.src_attr!=='',paused:item.paused,ended:item.ended,ready_state:item.ready_state,muted:item.muted,rendered:item.rendered,connected:item.connected}:
    {scope_kind:item.scope_kind,scrollable:item.scrollable,rendered:item.rendered,overflow_y:item.overflow_y,scroll_top:item.scroll_top,scroll_height:item.scroll_height,client_height:item.client_height})};
  entities.push({id,type:isMedia?'media':'scroll_scope',attrs});if(ownerId)relations.push({subj:id,pred:'in_scope',obj:ownerId});
  const nativeFact={id:item.id,tag:item.tag,label:item.label,name_source:item.name_source,role:item.role,dom_id:item.dom_id,owner:item.owner};
  const binding:NativeScrollBinding|NativeMediaBinding=isMedia?{schema:'native-media-binding/1.0',document_ref:d.page.document_ref,url:d.page.url,media:nativeFact as NativeMediaBinding['media'],source:item.source}:
   {schema:'native-scroll-binding/1.0',document_ref:d.page.document_ref,url:d.page.url,scope_kind:item.scope_kind,container:item.scope_kind==='document'?null:nativeFact};
  targets.set(id,{kind:isMedia?'MEDIA':'SCROLL',binding});
  if(candidates.length<maxCandidates-1)candidates.push({action:isMedia?'MEDIA':'SCROLL',arg:id});else truncated=true;
 }
 candidates.push({action:'STOP',arg:null});
 const limits={...base.limits,truncated:{entities:base.limits.truncated.entities||truncated,candidates:base.limits.truncated.candidates||truncated},counts:{entities:base.limits.counts.entities+possible,candidates:base.limits.counts.candidates+possible},applied:{max_entities:maxEntities,max_candidates:maxCandidates},scope:'explicit_tab_visible_controls_and_bounded_scroll_media'};
 return {projected:{...base,entities,relations,candidates,limits},targets};
}
