import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MoodEngine,configOf,windows,nextDue,localDay,atomicJson,validateText} from '../plugins/mood-qzone/engine.js';
import {trustedUrl} from '../plugins/mood-qzone/network.js';

const at = s=>Date.parse(s+'+08:00');
const BASE = at('2026-10-20T13:00:00');
test('系统代理备用通道仅接受固定公共 HTTPS 来源',()=>{
  assert.equal(trustedUrl('https://upload.wikimedia.org/test.png').hostname,'upload.wikimedia.org');
  for(const u of ['http://upload.wikimedia.org/x','https://127.0.0.1/x','https://upload.wikimedia.org.evil.test/x',
    'https://commons.wikimedia.org:444/x','https://user:pass@commons.wikimedia.org/x','file:///C:/data']) assert.throws(()=>trustedUrl(u));
});
function fixture(t,overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mood-qzone-test-'));
  const f={time:BASE,raw:{signatureDailyLimit:1,postDailyLimit:0,activeHours:'',allowWebSearch:false},sent:[],completed:0};
  const options={dir,getConfig:()=>f.raw,now:()=>f.time,
    context:()=>({persona:{botName:'测试角色',roleText:'温柔，喜欢星空'},memories:{recent:[]},webEnabled:true}),
    complete:async()=>{f.completed++;return f.completed%2 ? '{"mood":"轻松","searchQuery":"天文","imageQuery":"星空"}' : '{"text":"今天也把小小的好奇心收进口袋。","mood":"轻松","imageQuery":"星空"}';},
    search:async()=>({results:[{title:'测试资料',snippet:'虚构测试素材'}]}),
    image:async()=>({data:'base64://test',source:'https://example.org/test.jpg'}),
    send:async(kind,draft,c)=>{f.sent.push({kind,draft,c});return {tid:'test-tid'};},...overrides};
  const e=new MoodEngine(options); e.start();
  t.after(()=>{e.stop();fs.rmSync(dir,{recursive:true,force:true});});
  return {e,f,options,dir};
}

test('图片按会话持久去重，重启仍保留，预览不占图片',async t=>{
  let calls=0;
  const {e,f,options}=fixture(t,{complete:async()=>++calls%2?
    '{"mood":"开心","imageQuery":"摸鱼"}':JSON.stringify({text:'快乐摸鱼第'+calls+'回',mood:'开心',imageQuery:'摸鱼'})});
  f.raw.imageMode='必须配图';
  const first=await e.trigger('post',{scope:'private:1'});
  assert.equal(first.ok,true);
  assert.equal((await e.trigger('post',{scope:'private:1'})).ok,false);
  assert.equal((await e.trigger('post',{scope:'private:2'})).ok,true);
  e.stop();
  const restored=new MoodEngine(options);restored.start();
  try {
    assert.equal((await restored.trigger('post',{scope:'private:1'})).ok,false);
    f.raw.previewOnly=true;
    assert.equal((await restored.trigger('post',{scope:'private:3'})).ok,true);
    assert.equal(restored.state.imageUsage['private:3'],undefined);
  }finally{restored.stop();}
});

test('配置的 0 次、跨午夜时段和错误输入',()=>{
  assert.equal(configOf({signatureDailyLimit:0}).signatureDailyLimit,0);
  assert.deepEqual(windows('22:00-02:00'),[[0,120],[1320,1440]]);
  assert.deepEqual(windows(''),[[0,1440]]);
  for(const raw of [{signatureDailyLimit:-1},{postDailyLimit:0.5},{activeHours:'25:00-01:00'},
    {signatureGapMinutes:0},{imageMode:'随便'},{previewOnly:'false'}]) assert.throws(()=>configOf(raw));
});
test('只在时段内运行，按 UTC+8 跨日并保留跨天间隔',()=>{
  const c=configOf({signatureDailyLimit:1,postDailyLimit:0,activeHours:'09:00-22:00',signatureGapMinutes:1000});
  const ts=at('2026-10-20T22:10:00');
  const state={history:[{kind:'signature',ts:at('2026-10-20T21:00:00'),day:'2026-10-20',status:'success'}]};
  assert.equal(localDay(at('2026-10-21T00:01:00')),'2026-10-21');
  assert.equal(nextDue(c,state,'signature',ts),at('2026-10-21T15:30:00'));
  const cross=configOf({signatureDailyLimit:1,activeHours:'22:00-02:00'});
  const next=nextDue(cross,{history:[]},'signature',at('2026-10-20T15:00:00'));
  assert.equal(next,at('2026-10-20T22:00:00'));
});
test('配额和发布记录在重启后保留',async t=>{
  const {e,f,options}=fixture(t);
  await e.tick(); await e.tick();
  assert.equal(f.sent.length,1);
  e.stop();
  const restored=new MoodEngine(options);restored.start();
  await restored.tick();restored.stop();
  assert.equal(f.sent.length,1);
  assert.equal(restored.state.history[0].status,'success');
});
test('0 配额和时段外不会调用 AI',async t=>{
  const {e,f}=fixture(t);f.raw.signatureDailyLimit=0;
  await e.tick();assert.equal(f.completed,0);
  f.raw.signatureDailyLimit=1;f.raw.activeHours='22:00-23:00';
  await e.tick();assert.equal(f.completed,0);
});
test('生成途中保存新配置会取消旧内容，下一轮采用新配置',async t=>{
  const {e,f}=fixture(t);const original=e.complete;
  e.complete=async(...args)=>{const s=await original(...args);if(f.completed===2) f.raw.selfName='新的名字';return s;};
  await e.tick();assert.equal(f.sent.length,0);
  assert.equal(e.state.history.length,0);
  e.complete=original;await e.tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].c.selfName,'新的名字');
});
test('生成跨出允许时段不会发送',async t=>{
  const {e,f}=fixture(t);f.raw.activeHours='09:00-14:00';
  const original=e.complete;
  e.complete=async(...args)=>{const s=await original(...args);if(f.completed===2) f.time=at('2026-10-20T14:00:01');return s;};
  await e.tick();assert.equal(f.sent.length,0);
});
test('停用会中止生成，不能继续发送',async t=>{
  const {e,f}=fixture(t);const original=e.complete;
  e.complete=async(...args)=>{const s=await original(...args);if(f.completed===2)e.stop();return s;};
  await e.tick();assert.equal(f.sent.length,0);assert.equal(e.state.status,'已停用');
});
test('发送前先落配额；超时按未确认处理，不重发',async t=>{
  let calls=0;
  const {e,f,dir}=fixture(t,{send:async()=>{
    calls++;const saved=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
    assert.equal(saved.history.at(-1).status,'sending');throw new Error('timeout');
  }});
  await e.tick();f.time+=3600000;await e.tick();
  assert.equal(calls,1);assert.equal(e.state.history[0].status,'uncertain');
});
test('崩溃遗留 sending 预占配额在恢复时保留',async t=>{
  const {e,f,options,dir}=fixture(t);e.stop();
  atomicJson(path.join(dir,'state.json'),{version:1,history:[{kind:'signature',ts:BASE-1000,day:localDay(BASE),status:'sending'}]});
  const restored=new MoodEngine(options);restored.start();await restored.tick();restored.stop();
  assert.equal(restored.state.history[0].status,'uncertain');assert.equal(f.sent.length,0);
});
test('配图尽量模式降级、必须模式跳过',async t=>{
  const {e,f}=fixture(t,{image:async()=>{throw new Error('没有图片');}});
  f.raw.signatureDailyLimit=0;f.raw.postDailyLimit=1;f.raw.imageMode='必须配图';
  await e.tick();assert.equal(f.sent.length,0);assert.match(e.state.lastError,/必须配图/);
  f.raw.imageMode='尽量配图';f.time+=31*60000;
  await e.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].draft.media,null);
});

test('配置配图词保留原文，英文搜索词传到取图流程',async t=>{
  const {e,f}=fixture(t);f.raw.imageMode='必须配图';f.raw.imageQuery='深蓝色海洋';
  const prompts=[];e.complete=async messages=>{
    const p=JSON.parse(messages[1].content);prompts.push(p);
    return prompts.length===1?JSON.stringify({mood:'平静',imageQuery:'海',imageQueryEn:'blue sea'}):
      JSON.stringify({text:'想听海浪。',mood:'平静',imageQuery:'海洋',imageQueryEn:'deep blue ocean'});
  };
  const calls=[];e.image=async(...args)=>{calls.push(args);return {data:'base64://test',source:'https://example.org/sea.jpg'};};
  assert.equal((await e.trigger('post')).ok,true);
  assert.equal(calls[0][0],'深蓝色海洋');assert.equal(calls[0][2].fallbackQuery,'deep blue ocean');
  assert.ok(prompts.every(p=>p.imageSearchHint==='深蓝色海洋'));
  assert.equal(f.sent[0].draft.media.data,'base64://test');
});
test('预览不调用 QQ，也不占真实发布次数',async t=>{
  const {e,f}=fixture(t);f.raw.previewOnly=true;
  await e.tick();assert.equal(f.sent.length,0);assert.equal(e.state.history[0].status,'preview');
  f.raw.previewOnly=false;await e.tick();assert.equal(f.sent.length,1);
});
test('签名、说说遵守全局间隔，连点 tick 不会并发',async t=>{
  const {e,f}=fixture(t);f.raw.postDailyLimit=1;
  await Promise.all([e.tick(),e.tick(),e.tick()]);assert.equal(f.sent.length,1);
  await e.tick();assert.equal(f.sent.length,1);
  f.time+=11*60000;await e.tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1].kind,'post');
});
test('热重载期间旧请求在途，新实例不重复发送',async t=>{
  let finish;
  const coordinator={busy:false};
  const {e,f,options}=fixture(t,{coordinator,send:async()=>{await new Promise(r=>finish=r);f.sent.push('sent');return {tid:'x'};}});
  const pending=e.tick();
  while(!finish) await new Promise(r=>setImmediate(r));
  e.stop();const next=new MoodEngine(options);next.start();
  await next.tick();assert.equal(f.completed,2);
  finish();await pending;await next.tick();next.stop();
  assert.equal(f.sent.length,1);assert.equal(next.state.history[0].status,'success');
});
test('联网失败照常生成，明确没有搜索来源',async t=>{
  const {e,f}=fixture(t,{search:async()=>{throw new Error('搜索不可用');}});
  f.raw.allowWebSearch=true;await e.tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].draft.sources,null);
  assert.match(f.sent[0].draft.warnings[0],/搜索失败/);
});
test('状态损坏时拒绝清空配额，内容拦截手机号和内部标记',t=>{
  const {e,options,dir}=fixture(t);e.stop();
  fs.writeFileSync(path.join(dir,'state.json'),'{broken');assert.throws(()=>new MoodEngine(options));
  for(const s of ['联系 123456789','[CQ:at,qq=123]','<think>内部</think>','[号码]']) assert.throws(()=>validateText(s,280));
});
test('聊天触发可在定时点之前执行，并传递当次写作要求',async t=>{
  const {e,f}=fixture(t);f.time=at('2026-10-20T10:00:00');
  const prompts=[];const original=e.complete;
  e.complete=async(messages,...rest)=>{prompts.push(JSON.parse(messages[1].content));return original(messages,...rest);};
  await e.tick();assert.equal(f.completed,0);
  const result=await e.trigger('signature',{instruction:'写得轻松一点'});
  assert.equal(result.ok,true);assert.equal(f.sent.length,1);
  assert.equal(e.state.history[0].trigger,'chat');
  assert.ok(prompts.every(p=>p.chatRequest==='写得轻松一点'));
  // Another distinct draft is allowed immediately even with a daily limit of one.
  const complete=e.complete;
  e.complete=async(...args)=>(await complete(...args)).replace('今天也把小小的好奇心收进口袋。','现在想把新的好心情分享出去。');
  assert.equal((await e.trigger('signature')).ok,true);
  assert.equal(f.sent.length,2);
});
test('聊天跳过时段、零配额和失败冷却，仍遵守并发及总开关',async t=>{
  const {e,f}=fixture(t);f.raw.activeHours='22:00-23:00';
  f.raw.signatureDailyLimit=0;
  e.state.retryAt.signature=f.time+3600000;e.persist();
  assert.equal((await e.trigger('signature')).ok,true);
  assert.equal(e.state.retryAt.signature,f.time+3600000);
  e.coordinator.busy=true;
  assert.match((await e.trigger('signature')).reason,/正在处理/);
  e.coordinator.busy=false;e.stop();
  assert.equal((await e.trigger('signature')).ok,false);
  assert.equal(f.sent.length,1);
});
test('聊天在定时配额耗尽和定时最小间隔内仍能执行',async t=>{
  const {e,f}=fixture(t);
  e.state.history=[{kind:'signature',ts:f.time-1000,day:localDay(f.time),status:'success',trigger:'timer',text:'旧签名'}];e.persist();
  assert.equal((await e.trigger('signature')).ok,true);
  const before=f.completed;await e.tick();
  assert.equal(f.completed,before);assert.equal(f.sent.length,1);
});
test('聊天记录不占定时任务的次数和间隔',()=>{
  const c=configOf({signatureDailyLimit:1,postDailyLimit:1,activeHours:''});
  const history=[{kind:'signature',ts:BASE-1,day:localDay(BASE),status:'success',trigger:'chat'}];
  assert.equal(nextDue(c,{history},'signature',BASE),BASE);
  assert.equal(nextDue(c,{history},'post',BASE),BASE);
});
test('聊天发说说遵守预览模式并返回真实执行结果',async t=>{
  const {e,f}=fixture(t);f.raw.signatureDailyLimit=0;f.raw.postDailyLimit=1;f.raw.previewOnly=true;
  const preview=await e.trigger('post');
  assert.equal(preview.ok,true);assert.equal(preview.status,'preview');assert.equal(f.sent.length,0);
  assert.match(preview.message,/未修改 QQ/);
  f.raw.previewOnly=false;
  const result=await e.trigger('post');assert.equal(result.ok,true);
  assert.equal(result.result.tid,'test-tid');assert.equal(result.status,'success');
  await e.tick();assert.equal(f.sent.length,1);
});
test('聊天触发中改配置或 QQ 请求失败不会报成已发布',async t=>{
  const {e,f}=fixture(t);const original=e.complete;
  e.complete=async(...args)=>{const out=await original(...args);if(f.completed===2)f.raw.selfName='新名字';return out;};
  const cancelled=await e.trigger('signature');assert.equal(cancelled.ok,false);assert.equal(f.sent.length,0);
  e.complete=original;e.send=async()=>{throw new Error('QQ timeout');};
  const failed=await e.trigger('signature');assert.equal(failed.ok,false);assert.equal(failed.uncertain,true);
  assert.match(failed.message,/不要立即重发/);
});
