import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoalRunner } from '../dist/goal/loop.js';
import { authorizeGoalAction, parseGoalSafety } from '../dist/goal/safety.js';
const safety = { version: 1, allowedOrigins: ['https://example.com'], allowCart: true };
const config = { jevApiKey: 'test', jevModel: 'test', jevBaseUrl: '', jevTimeoutMs: 1000, jevMinConfidence: .5, jevMaxCandidates: 60, goalTriageMinElements: 0 };
function answer(q, choice, confidence=.95, probs=null) {
  const keys = Object.keys(q.criteria);
  assert(keys.includes(choice), `${choice} not offered`);
  const probabilities = probs ?? Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0]));
  return { choice, confidence, probabilities };
}
function model(decide) { return { disabled: false, async ask(state, qs) { return { ok: true, answers: Object.fromEntries(Object.entries(qs).map(([id,q]) => { const pick = decide(id,state); return [id, answer(q, typeof pick === 'string' ? pick : pick.choice, pick.confidence, pick.probs)]; })), tookMs: 1, cached: false }; } }; }
function fixture(t, opts={}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-safe-'));
  t.after(() => fs.rmSync(dir,{ recursive:true,force:true }));
  const calls=[];
  let marker='m1';
  const action = { id:'a1',node:'a1',kind:opts.fill?'fill':'click',label:opts.label||'Article',rect:{x:1,y:1,w:30,h:20},role:opts.fill?'textbox':'link' };
  const observation = () => ({ok:true,url:'https://example.com',title:'Page',text:'Article',marker,actions:[action]});
  const jev = opts.jev || model(id => ({ operation:opts.fill?'TYPE_TEXT':'CLICK',click_target:'1',type_text_target:'1',effect:opts.fill?'edit':'browse' }[id]));
  const runner = new GoalRunner({config,jev,goalsDir:dir,sleep:async()=>{},textHelper:opts.textHelper});
  const call = async (name,args) => {
    calls.push({name,args});
    if(opts.call) { const r=await opts.call(name,args);if(r!==undefined)return r; }
    if(name==='action_space') return observation();
    if(name==='element_info') return {found:true,element:{wbId:'a1'}};
    if(name==='click_element') { marker='m2'; return {ok:true}; }
    if(name==='evaluate') return {value:1};
    throw new Error(name);
  };
  return {runner,call,calls,setMarker:m=>{marker=m;}};
}

test('safety protocol validates scope and fails closed', () => {
  assert.throws(()=>parseGoalSafety({version:1,allowedOrigins:['http://example.com'],allowCart:true}));
  assert.throws(()=>parseGoalSafety({version:2,allowedOrigins:['https://example.com'],allowCart:true}));
});

test('cart permission never permits checkout, credentials or cookie consent', async () => {
  const jev=model(()=> 'browse');
  for(const label of ['Proceed to checkout','Payer','Password','Tout accepter','Buy now']) {
    const result=await authorizeGoalAction(jev,{goal:'Add to cart',url:'https://example.com',action:{id:'a',kind:'click',label},safety});
    assert.equal(result.ok,false,label);
  }
  assert.equal((await authorizeGoalAction(jev,{goal:'x',url:'https://other.com',action:{id:'a',kind:'click',label:'Article'},safety})).ok,false);
});

test('semantic effect: safe-union mass decides; risky mass always denies', async () => {
  const input={goal:'Read',url:'https://example.com',action:{id:'a',kind:'click',label:'Add item'},safety:{...safety,allowCart:false}};
  assert.equal((await authorizeGoalAction(model(()=> 'cart'),input)).ok,false,'cart without allowCart');
  assert.equal((await authorizeGoalAction(model(()=>({choice:'browse',confidence:.6})),input)).ok,true,'clear browse passes');
  // Hésitation INTERNE aux classes sûres (edit 0.59 / browse 0.40, mesuré live) : autorisé.
  const safeSplit=model(()=>({choice:'edit',confidence:.49,probs:{edit:.59,browse:.40,cart:0,commit:0,sensitive:0,unknown:.01}}));
  assert.equal((await authorizeGoalAction(safeSplit,input)).ok,true,'safe-internal split passes');
  // Masse risqué non négligeable : refus, même si le choix est sûr.
  const risky=model(()=>({choice:'browse',confidence:.4,probs:{browse:.4,commit:.35,edit:.2,cart:0,sensitive:.05,unknown:0}}));
  assert.equal((await authorizeGoalAction(risky,input)).ok,false,'risk mass denies');
  // Cart exige l'autorité ET la masse panier dominante.
  const cartInput={...input,safety};
  assert.equal((await authorizeGoalAction(model(()=>({choice:'cart',confidence:.5,probs:{cart:.5,browse:.4,edit:0,commit:0,sensitive:0,unknown:.1}})),cartInput)).ok,true,'cart with authority passes');
});

test('runner gates target confidence as well as operation confidence', async t => {
  const f=fixture(t,{jev:model(id=>id==='click_target'?{choice:'1',confidence:.2}:id==='operation'?'CLICK':'browse')});
  const start=await f.runner.start(f.call,{goal:'Open article',tabId:1,safety});
  const end=await f.runner.wait(start.runId,1000);
  assert.equal(end.lastPause.reason,'low_confidence');
  assert.equal(f.calls.some(c=>c.name==='click_element'),false);
});

test('runner blocks a payment before dispatch', async t => {
  const f=fixture(t,{label:'Place your order'});
  const start=await f.runner.start(f.call,{goal:'Add to cart',tabId:1,safety});
  const end=await f.runner.wait(start.runId,1000);
  assert.equal(end.lastPause.reason,'authorization_required');
  assert.equal(f.calls.some(c=>c.name==='click_element'),false);
});

test('stop during text generation prevents subsequent typing', async t => {
  let release;
  let entered;
  const began=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{fill:true,textHelper:async()=>{entered();return new Promise(resolve=>{release=()=>resolve({ok:true,text:'hello',meta:{model:'fake'}});});}});
  const start=await f.runner.start(f.call,{goal:'Write hello',tabId:1,safety});
  await began;
  f.runner.stop(start.runId);
  release();
  const end=await f.runner.wait(start.runId,1000);
  assert.equal(end.status,'stopped');
  assert.equal(f.calls.some(c=>c.name==='evaluate'&&c.args.expression!=='1'),false);
});

test('page change during helper generation discards the old target', async t => {
  let first=true;
  let f;
  const jev=model(id=>({operation:first?'TYPE_TEXT':'BLOCKED',type_text_target:'1',effect:'edit'}[id]));
  f=fixture(t,{fill:true,jev,textHelper:async()=>{first=false;f.setMarker('new');return {ok:true,text:'hello',meta:{model:'fake'}};}});
  const start=await f.runner.start(f.call,{goal:'Write hello',tabId:1,safety});
  const end=await f.runner.wait(start.runId,1000);
  assert.equal(end.status,'blocked');
  assert.equal(f.calls.some(c=>c.name==='evaluate'&&c.args.expression!=='1'),false);
});

test('guarded native fill verifies the exact observed value', async t => {
  const f=fixture(t,{fill:true,textHelper:async()=>({ok:true,text:'2',meta:{model:'fake'}}),call:(name,args)=>name==='evaluate'&&args.expression!=='1'?{value:{found:true,value:'1'}}:undefined});
  const start=await f.runner.start(f.call,{goal:'Set quantity 2',tabId:1,safety});
  const end=await f.runner.wait(start.runId,1000);
  assert.equal(end.lastPause.reason,'execution_error');
  assert.match(end.lastPause.detail.message,/field_value_not_verified/);
});

test('start request is idempotent and tab is single-owner', async t => {
  let release;
  let entered;
  const began=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{fill:true,textHelper:async()=>{entered();return new Promise(resolve=>{release=()=>resolve({ok:false,error:'stop'});});}});
  const request={goal:'Write hello',tabId:1,safety,requestId:'test-request'};
  const a=await f.runner.start(f.call,request);
  await began;
  const b=await f.runner.start(f.call,request);
  assert.equal(a.runId,b.runId);
  await assert.rejects(()=>f.runner.start(f.call,{...request,requestId:'other'}),/goal_tab_busy/);
  f.runner.stop(a.runId);release();await f.runner.wait(a.runId,1000);
});

test('tryAdmitOrigin admits https hosts named in the goal', async () => {
  const { tryAdmitOrigin, isAllowedGoalPage } = await import('../dist/goal/safety.js');
  const s = { version: 1, allowedOrigins: ['https://www.google.com'], allowCart: true };
  const admitted = tryAdmitOrigin(s, 'Va sur Nike et mets deux chaussures au panier', 'https://www.nike.com/fr/');
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.token, 'nike');
  assert.equal(isAllowedGoalPage('https://www.nike.com/fr/', s), true);
  const t = { version: 1, allowedOrigins: ['https://www.google.com'], allowCart: true };
  assert.equal(tryAdmitOrigin(t, 'Va sur YouTube', 'https://evil.example/').admitted, false);
  const u = { version: 1, allowedOrigins: ['https://www.google.com'], allowCart: true };
  assert.equal(tryAdmitOrigin(u, 'restore the tab', 'https://store.example/').admitted, false);
});
