import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MoodEngine,configOf,whitelistOf,requesterFromContext,atomicJson,redact,memoryPolicy} from '../plugins/mood-qzone/engine.js';
import {readMemories} from '../plugins/mood-qzone/archives.js';

const NOW=Date.parse('2026-10-20T13:00:00+08:00');
function directory(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mood-whitelist-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
function fixture(t,settings={}) {
  const dir=directory(t), prompts=[], contexts=[], sent=[];
  const raw={userWhitelist:'10001,10002',signatureDailyLimit:1,postDailyLimit:0,activeHours:'',allowWebSearch:false,...settings};
  let calls=0;
  const e=new MoodEngine({dir,getConfig:()=>raw,now:()=>NOW,
    context:c=>{contexts.push(c);return {persona:{botName:'测试'},memories:{recent:[],impressions:[]}};},
    complete:async messages=>{
      prompts.push(JSON.parse(messages[1].content));
      return ++calls%2?'{"mood":"好心情"}':JSON.stringify({text:'今天天气很晴朗第'+calls+'次',mood:'好心情'});
    },
    send:async(kind,draft)=>{sent.push({kind,draft});return {tid:'test'};}});
  e.running=true;
  t.after(()=>{e.running=false;});
  return {e,raw,prompts,contexts,sent,dir};
}

test('白名单支持常见分隔符、去重、稳定排序，拒绝错误 QQ 号',()=>{
  assert.deepEqual(whitelistOf('10002，10001\n10002；10003、10004 10005'),['10001','10002','10003','10004','10005']);
  assert.equal(configOf({}).userWhitelist,'');
  for (const value of ['abc','1234','0','10001,bad','10001/10002','10001;012345','1000000000000000',[],null]) {
    assert.throws(()=>configOf({userWhitelist:value}));
  }
});

test('仅从真实会话解析唯一发起人，不回退到昵称、群号或工具参数',()=>{
  const ctx={kind:'group',chatId:'90001',selfId:'90002',session:{trigger:[{senderId:'10001',text:'请换签名'}]}};
  assert.equal(requesterFromContext(ctx),'10001');
  assert.equal(requesterFromContext({...ctx,session:{trigger:[{senderId:10001},{senderId:'10001'}]}}),'10001');
  for(const trigger of [[],null,[{text:'10001'}],[{senderId:'90002'}],[{senderId:'10001',self:true}],
    [{senderId:'10001'},{senderId:'10002'}],[{senderId:'10001'},{}]]) {
    assert.equal(requesterFromContext({...ctx,session:{trigger},senderId:'10001',requesterId:'10001'}),'');
  }
  assert.equal(requesterFromContext({...ctx,kind:'private',chatId:'10002'}),'');
  assert.equal(requesterFromContext({...ctx,kind:'private',chatId:'10001'}),'10001');
  assert.equal(requesterFromContext({kind:'private',chatId:'10001'}),'');
});

for(const kind of ['signature','post']) {
  test(`${kind} 的空白名单、身份不明和白名单外请求在读取记忆/调用模型前拒绝`,async t=>{
    const {e,raw,contexts,prompts,sent}=fixture(t);
    raw.userWhitelist='';
    assert.match((await e.trigger(kind,{requesterId:'10001'})).reason,/白名单为空/);
    raw.userWhitelist='10001';
    assert.match((await e.trigger(kind)).reason,/唯一发起人/);
    assert.match((await e.trigger(kind,{requesterId:'10002'})).reason,/不在用户白名单/);
    assert.equal(contexts.length,0);assert.equal(prompts.length,0);assert.equal(sent.length,0);
    assert.equal(e.state.history.length,0);
  });
}

test('谁触发就传递谁的记忆范围，定时任务使用完整白名单',async t=>{
  const {e,contexts}=fixture(t);
  assert.equal((await e.trigger('signature',{requesterId:'10001'})).ok,true);
  assert.equal((await e.trigger('post',{requesterId:'10002'})).ok,true);
  await e.tick();
  assert.deepEqual(contexts.map(c=>c.memoryUserIds),[['10001'],['10002'],['10001','10002']]);
});

test('空白名单定时任务仍运行，传入空记忆用户范围',async t=>{
  const {e,contexts,sent}=fixture(t,{userWhitelist:''});
  assert.equal((await e.tick()).ok,true);
  assert.deepEqual(contexts[0].memoryUserIds,[]);
  assert.equal(sent.length,1);
});

test('生成期间删除发起人或清空白名单取消发布且不占次数',async t=>{
  for(const next of ['','10002']) {
    const {e,raw,sent}=fixture(t);
    const original=e.complete;
    e.complete=async(...args)=>{const result=await original(...args);raw.userWhitelist=next;return result;};
    const result=await e.trigger('signature',{requesterId:'10001'});
    assert.equal(result.ok,false);assert.match(result.reason,/配置.*变化/);
    assert.equal(sent.length,0);assert.equal(e.state.history.length,0);
  }
});

test('模型上下文隔离旧版本历史、其他用户、定时混合历史和旧白名单心情',async t=>{
  const {e,raw,prompts}=fixture(t);
  e.state.mood='OLD_GLOBAL_MOOD';
  const record=(text,policy)=>({kind:'signature',ts:NOW-1000,day:'2026-10-20',text,mood:text,status:'success',trigger:'chat',memoryPolicy:policy});
  e.state.history=[record('OLD_HISTORY',undefined),
    record('OTHER_MEMBER',memoryPolicy({...configOf(raw),memoryUserIds:['10002']})),
    record('MIXED_TIMER',memoryPolicy({...configOf(raw),memoryUserIds:['10001','10002']})),
    record('MY_ALLOWED_HISTORY',memoryPolicy({...configOf(raw),memoryUserIds:['10001']}))];
  e.persist();
  assert.equal((await e.trigger('signature',{requesterId:'10001'})).ok,true);
  for(const p of prompts) {
    assert.deepEqual(p.recentPosts.map(r=>r.text),['MY_ALLOWED_HISTORY']);
    assert.equal(p.currentMood,'MY_ALLOWED_HISTORY');
    assert.doesNotMatch(JSON.stringify(p),/OLD_HISTORY|OTHER_MEMBER|MIXED_TIMER|OLD_GLOBAL_MOOD/);
  }
  prompts.length=0;raw.userWhitelist='10001';
  await e.trigger('post',{requesterId:'10001'});
  assert.ok(prompts.every(p=>p.recentPosts.length===0 && p.currentMood===''));
});

test('归属过滤发生在截取前：只选本人聊天及长期记忆，排除机器人和无归属旧数据',t=>{
  const dataDir=directory(t), put=(file,value)=>atomicJson(path.join(dataDir,file),value);
  put('messages/group_90001.json',{messages:[
    {senderId:'10001',ts:NOW,text:'MY_RECENT'},
    {senderId:10001,ts:NOW,text:'MY_NUMERIC_ID'},
    {senderId:'10001',ts:NOW,self:true,text:'BOT_REPLY'},
    {senderId:'10001',ts:NOW-80*3600000,text:'TOO_OLD'},
    ...Array.from({length:80},()=>({senderId:'10002',ts:NOW,text:'OTHER_RECENT'})),
    {ts:NOW,text:'UNKNOWN_AUTHOR'}]});
  put('messages/private_10001.json',{messages:[{senderId:'10002',ts:NOW,text:'NOT_MINE_IN_MY_CHAT'}]});
  put('memory/group_90001/10001.json',{userId:'10001',impressions:[{content:'MY_MEMORY',createdAt:NOW}]});
  put('memory/group_90001/10002.json',{userId:'10002',impressions:[{content:'OTHER_MEMORY'}]});
  put('memory/private_10001/10001.json',{impressions:[{content:'NO_OWNER'}]});
  put('memory/group_90001/_meta.json',{userId:'10001',impressions:[{content:'NOT_MEMBER_MEMORY'}]});
  put('memory/group_90001/_n_legacy.json',{name:'10001',impressions:[{content:'NAME_IS_NOT_ID'}]});
  const args={dataDir,userIds:['10001'],memoryHours:72,redact,now:NOW};
  const mine=readMemories(args);
  assert.deepEqual(mine.recent.map(m=>m.text),['MY_RECENT','MY_NUMERIC_ID']);
  assert.deepEqual(mine.impressions.map(m=>m.text),['MY_MEMORY']);
  assert.deepEqual(readMemories({...args,userIds:[]}),{recent:[],impressions:[]});
  assert.match(JSON.stringify(readMemories({...args,userIds:['10002']})),/OTHER_MEMORY/);
  assert.doesNotMatch(JSON.stringify(readMemories({...args,userIds:['10002']})),/MY_MEMORY|MY_RECENT/);
});
