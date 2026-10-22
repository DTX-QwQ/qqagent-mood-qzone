import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MoodEngine,configOf,nextDue,nextDiaryDue,localDay,atomicJson,redact,memoryPolicy} from '../plugins/mood-qzone/engine.js';
import {readMemories} from '../plugins/mood-qzone/archives.js';

const at = time=>Date.parse(time+'+08:00');
const START=at('2026-10-22T00:00:00'), TEN=at('2026-10-22T22:00:00');
function fixture(t,settings={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mood-diary-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f={now:TEN,raw:{diaryEnabled:true,userWhitelist:'10001',signatureDailyLimit:0,postDailyLimit:0,
    activeHours:'09:00-22:00',allowWebSearch:true,...settings},sent:[],prompts:[],systems:[],contexts:[],searches:0};
  const opts={dir,getConfig:()=>f.raw,now:()=>f.now,context:c=>{
    f.contexts.push(c);
    return {persona:{botName:'测试角色'},webEnabled:true,memories:{recent:[
      {ts:START-1,text:'YESTERDAY'}, {ts:START,text:'TODAY'}, {ts:TEN+1,text:'FUTURE'}],
      impressions:[{text:'OLD_IMPRESSION'}]}};
  },complete:async messages=>{
    f.systems.push(messages[0].content);
    f.prompts.push(JSON.parse(messages[1].content));
    return f.prompts.length%2 ? '{"mood":"平静","searchQuery":"新闻"}' :
      JSON.stringify({text:localDay(f.now)+'\n今天的交流让我有些新的感想。',mood:'平静'});
  },search:async()=>{f.searches++;return {};},
  send:async(kind,draft,c)=>{f.sent.push({kind,draft,c});return {tid:'test'};}};
  const e=new MoodEngine(opts);e.running=true;
  t.after(()=>{e.running=false;});
  return {e,f,opts,dir};
}

test('日记严格从 UTC+8 的 22 点触发，关闭后无计划，普通任务不受影响',()=>{
  const c=configOf({diaryEnabled:true}),state={history:[]};
  assert.equal(nextDiaryDue(c,state,TEN-1),TEN);
  assert.equal(nextDiaryDue(c,state,TEN),TEN);
  assert.equal(nextDiaryDue(c,state,TEN+1),TEN+1);
  assert.equal(nextDiaryDue({...c,diaryEnabled:false},state,TEN),null);
  assert.equal(nextDiaryDue({...c,enabled:false},state,TEN),null);
  assert.equal(configOf({}).diaryEnabled,false);
  assert.throws(()=>configOf({diaryEnabled:'true'}));
  const ordinary=nextDue(c,state,'post',TEN-3600000);
  assert.equal(nextDue(c,{history:[{kind:'diary',day:'2026-10-22',ts:TEN-1000,status:'success'}]},'post',TEN-3600000),ordinary);
});

test('开关关闭或 22 点前不读记忆、不调 AI；到点不受普通时段、零配额和冷却阻拦',async t=>{
  const {e,f}=fixture(t,{diaryEnabled:false});
  await e.tick();assert.equal(f.contexts.length,0);
  f.raw.diaryEnabled=true;f.now=TEN-1;
  await e.tick();assert.equal(f.prompts.length,0);
  f.now=TEN;e.state.retryAt.post=TEN+86400000;
  e.state.history=[{kind:'post',trigger:'timer',status:'success',day:'2026-10-22',ts:TEN-1000}];e.persist();
  assert.equal((await e.tick()).ok,true);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].kind,'diary');
});

test('日记只用当天聊天和当天生成历史，不联网添加经历，也不受 memoryHours 缩短影响',async t=>{
  const {e,f}=fixture(t,{memoryHours:1});
  const policy=memoryPolicy({...configOf(f.raw),memoryUserIds:['10001']});
  e.state.history=[{ts:START-1,kind:'post',day:'2026-10-21',status:'success',text:'OLD_POST',memoryPolicy:policy}];e.persist();
  await e.tick();
  assert.equal(f.contexts[0].memoryFrom,START);assert.equal(f.contexts[0].memoryUntil,TEN);
  assert.deepEqual(f.contexts[0].memoryUserIds,['10001']);assert.equal(f.searches,0);
  assert.ok(f.systems.every(s=>s.includes('不是今天发生的事实') && s.includes('不能据此断言今天没人说话')));
  for (const p of f.prompts) {
    assert.equal(p.diaryDate,'2026-10-22');
    assert.deepEqual(p.memories.recent.map(m=>m.text),['TODAY']);assert.deepEqual(p.memories.impressions,[]);
    assert.doesNotMatch(JSON.stringify(p),/YESTERDAY|FUTURE|OLD_IMPRESSION|OLD_POST/);
  }
});

test('归档在截取前筛选当天且只读白名单，不读取长期印象',t=>{
  const {dir}=fixture(t);
  atomicJson(path.join(dir,'messages/group_90001.json'),{messages:[
    {senderId:'10001',ts:START-1,text:'OLD'}, {senderId:'10001',ts:START,text:'MIDNIGHT'},
    {senderId:'10002',ts:TEN,text:'OTHER'}, {senderId:'10001',ts:TEN,self:true,text:'SELF'},
    {ts:TEN,text:'UNKNOWN'}, {senderId:'10001',ts:TEN,text:'NOW'},
    ...Array.from({length:70},()=>({senderId:'10001',ts:TEN+1,text:'FUTURE'}))]});
  atomicJson(path.join(dir,'memory/group_90001/10001.json'),{userId:'10001',impressions:[{content:'MEMORY',createdAt:TEN}]});
  const args={dataDir:dir,userIds:['10001'],memoryHours:1,redact,now:TEN,fromTs:START,untilTs:TEN,includeImpressions:false};
  assert.deepEqual(readMemories(args),{recent:[{ts:START,self:false,text:'MIDNIGHT'},{ts:TEN,self:false,text:'NOW'}],impressions:[]});
  assert.deepEqual(readMemories({...args,userIds:[]}),{recent:[],impressions:[]});
});

test('重复检查、关闭再开和重启都不重复发布，次日获得新的日记计划',async t=>{
  const {e,f,opts}=fixture(t);
  await e.tick();await e.tick();f.raw.diaryEnabled=false;await e.tick();f.raw.diaryEnabled=true;await e.tick();
  const restored=new MoodEngine(opts);restored.running=true;
  await restored.tick();assert.equal(f.sent.length,1);
  assert.equal(restored.status().nextDiaryAt,at('2026-10-23T22:00:00'));
  f.now=at('2026-10-23T00:00:00');await restored.tick();assert.equal(f.sent.length,1);
  f.now=at('2026-10-23T22:00:00');await restored.tick();assert.equal(f.sent.length,2);
});

test('22 点后仅补当日日记，不补前一天；生成跨午夜取消',async t=>{
  const {e,f}=fixture(t);f.now=at('2026-10-22T23:40:00');
  const original=e.complete;
  e.complete=async(...args)=>{const result=await original(...args);f.now=at('2026-10-23T00:00:00');return result;};
  await e.tick();assert.equal(f.sent.length,0);assert.equal(e.state.history.length,0);
  e.complete=original;await e.tick();assert.equal(f.sent.length,0);
  f.now=at('2026-10-23T22:10:00');await e.tick();
  assert.equal(e.state.history.at(-1).day,'2026-10-23');assert.equal(f.sent.length,1);
});

test('生成期间关闭日记开关、修改白名单或停用取消发布',async t=>{
  for (const change of [f=>{f.raw.diaryEnabled=false;},f=>{f.raw.userWhitelist='';},(f,e)=>e.stop()]) {
    const {e,f}=fixture(t),original=e.complete;
    e.complete=async(...args)=>{const result=await original(...args);change(f,e);return result;};
    assert.equal((await e.tick()).ok,false);assert.equal(f.sent.length,0);assert.equal(e.state.history.length,0);
  }
});

test('日记发布先预占，结果未确认不重发，崩溃恢复保留预占',async t=>{
  const {e,f,opts,dir}=fixture(t);let calls=0;
  e.send=async()=>{calls++;assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).history.at(-1).status,'sending');throw new Error('timeout');};
  assert.equal((await e.tick()).uncertain,true);f.now+=31*60000;await e.tick();assert.equal(calls,1);
  const saved=e.state;saved.history[0].status='sending';atomicJson(path.join(dir,'state.json'),saved);
  const restored=new MoodEngine(opts);restored.start();
  try {
    await restored.tick();assert.equal(restored.state.history[0].status,'uncertain');assert.equal(f.sent.length,0);
  } finally {restored.stop();}
});

test('日记生成失败半小时后重试，但不跨天补发',async t=>{
  const {e,f}=fixture(t);const original=e.complete;
  e.complete=async()=>{throw new Error('model unavailable');};
  await e.tick();assert.equal(e.state.history.length,0);assert.equal(e.state.retryAt.diary,TEN+30*60000);
  e.complete=original;await e.tick();assert.equal(f.prompts.length,0);
  f.now+=30*60000;await e.tick();assert.equal(f.sent.length,1);
  assert.equal(nextDiaryDue(configOf(f.raw),{history:[],retryAt:{diary:at('2026-10-23T00:10:00')}},at('2026-10-22T23:50:00')),at('2026-10-23T22:00:00'));
});

test('日记预览不调用 QQ、不占真实名额；可见范围和必须配图沿用现有设置',async t=>{
  const {e,f}=fixture(t,{previewOnly:true,visibility:'仅自己可见',imageMode:'必须配图'});
  e.image=async()=>({data:'base64://dGVzdA==',source:'https://example.org/test.png'});
  // Add image keywords to the AI stub without changing the diary body.
  const original=e.complete;e.complete=async(...args)=>JSON.stringify({...JSON.parse(await original(...args)),imageQuery:'星空'});
  await e.tick();await e.tick();assert.equal(f.sent.length,0);assert.equal(e.state.history.length,1);
  f.raw.previewOnly=false;await e.tick();assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].c.visibility,'仅自己可见');assert.ok(f.sent[0].draft.media);
});

test('同时到点优先日记，并发检查只生成一份；日记不占普通说说名额',async t=>{
  const {e,f}=fixture(t,{activeHours:'',postDailyLimit:1});
  await Promise.all([e.tick(),e.tick(),e.tick()]);assert.equal(f.sent.length,1);assert.equal(f.sent[0].kind,'diary');
  await e.tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1].kind,'post');
});
