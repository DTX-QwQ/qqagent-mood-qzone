import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, DATA_DIR as HOST_DATA_DIR } from '../../src/config.js';
import { chatCompletionWithRetry } from '../../src/llm.js';
import { OneBotClient } from '../../src/onebot.js';
import { webSearch, searchImages } from '../../src/web-search.js';
import { safeFetchBinary, checkBrowseLock } from '../../src/safe-fetch.js';

// Propagate the loader's cache-busting query to our implementation on hot reload.
const {MoodEngine,redact} = await import(new URL('./engine.js'+new URL(import.meta.url).search,import.meta.url));
const {createCommonsService,imageType,validateImage} = await import(new URL('./network.js'+new URL(import.meta.url).search,import.meta.url));
const commons = createCommonsService({safeFetchBinary,checkLock:checkBrowseLock});
const ID = 'mood-qzone';
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = (()=>{
  if (process.env.QQ_AGENT_DATA_DIR) return path.resolve(process.env.QQ_AGENT_DATA_DIR);
  const suffix = /^\d+$/.test(process.env.QQ_AGENT_PROFILE || '') ? '-'+process.env.QQ_AGENT_PROFILE : '';
  for (const root of [path.resolve(here,'../../../..'),path.resolve(here,'../..')]) {
    const dir = path.join(root,'data'+suffix);
    if (fs.existsSync(path.join(dir,'config.json'))) return dir;
  }
  return HOST_DATA_DIR;
})();
const lockKey = Symbol.for('qq-agent.mood-qzone.coordinator');
const coordinator = globalThis[lockKey] ||= {busy:false};
let engine;

function json(file) {
  try {
    if (fs.statSync(file).size > 32*1024*1024) return null;
    return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  } catch { return null; }
}
function files(dir,regex) {
  try { return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile() && regex.test(e.name))
    .map(e=>path.join(dir,e.name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs); }
  catch { return []; }
}

/** Reads existing archives only; never marks messages read or modifies host memory. */
function context(c) {
  const cfg = getConfig(), recent = [], impressions = [];
  const cutoff = Date.now()-c.memoryHours*3600000;
  for (const file of files(path.join(DATA_DIR,'messages'),/^(group|private)_\d+\.json$/).slice(0,12)) {
    const messages = json(file)?.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages.filter(m=>Number(m.ts)>=cutoff && m.text).slice(-50)) {
      recent.push({ts:Number(m.ts),self:!!m.self,text:redact(m.text).slice(0,400)});
    }
  }
  const memoryDir = path.join(DATA_DIR,'memory');
  try {
    for (const entry of fs.readdirSync(memoryDir,{withFileTypes:true}).filter(e=>e.isDirectory() && /^(group|private)_\d+$/.test(e.name)).slice(0,12)) {
      for (const file of files(path.join(memoryDir,entry.name),/^(?!_meta).*\.json$/).slice(0,20)) {
        const mem = json(file);
        for (const imp of (Array.isArray(mem?.impressions)?mem.impressions:[]).slice(-3)) {
          if (imp?.content) impressions.push({ts:Number(imp.createdAt)||0,text:redact(imp.content).slice(0,240)});
        }
      }
    }
  } catch {}
  const persona = cfg.persona || {};
  return {
    persona:{botName:String(persona.botName || ''),roleText:String(persona.roleText || '').slice(0,12000),
      customRules:String(persona.customRules || '').slice(0,3000)},
    memories:{recent:recent.sort((a,b)=>a.ts-b.ts).slice(-60),
      impressions:impressions.sort((a,b)=>a.ts-b.ts).slice(-30)},
    webEnabled:cfg.webSearch?.enabled !== false,
    browseLocked:cfg.security?.browseLock?.enabled === true
  };
}

async function image(query,signal,options={}) {
  signal?.throwIfAborted();
  const errors = [];
  let list=[];
  try {list=await searchImages(query,{limit:4,browseLocked:true});}
  catch(e) {errors.push(e.message);}
  for (const item of list) {
    if (signal?.aborted) throw signal.reason;
    try {
      // Download through the host's DNS/redirect/size/browser-lock checks, then upload bytes.
      const {buffer,contentType} = await safeFetchBinary(item.url,5*1024*1024,{browseLocked:true});
      if (signal?.aborted) throw signal.reason;
      validateImage({buffer,contentType});
      return {data:'base64://'+buffer.toString('base64'),source:item.url};
    } catch(e) { errors.push(e.message); }
  }
  // Browser lock is authoritative: a fixed-source fallback must not bypass it.
  if (getConfig().security?.browseLock?.enabled !== true) {
    try {return await commons.image(query,signal,options);}
    catch(e) {errors.push(e.message);}
  }
  throw new Error('候选配图都不可用：'+errors.join('；').slice(0,240));
}
async function search(query) {
  try {return await webSearch(query);}
  catch(e) {
    if (getConfig().webSearch?.enabled === false || getConfig().security?.browseLock?.enabled === true) throw e;
    return commons.search(query);
  }
}
async function complete(messages,signal) {
  const r = await chatCompletionWithRetry({messages,tools:null,toolChoice:'none',
    maxTokens:1400,temperature:0.85,signal,skillContext:{purpose:ID}},0);
  const text = r.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回心情正文');
  return text;
}
async function send(kind,draft,c) {
  const cfg = getConfig();
  const sc = cfg.snowluma || {};
  const client = new OneBotClient({httpUrl:sc.httpUrl,httpToken:sc.httpAccessToken,accessToken:sc.accessToken});
  // Do not open another WebSocket or event listener.
  if (kind === 'signature') {
    await client.call('set_self_longnick',{longNick:draft.text},30000);
    return {ok:true};
  }
  const params = {content:draft.text,ugc_right:{'所有人可见':1,'好友可见':4,'仅自己可见':64}[c.visibility]};
  if (draft.media?.data) params.images=[draft.media.data];
  const data = await client.call('send_qzone_msg',params,90000);
  // SnowLuma requires a tid before it considers a post successfully published.
  if (!data?.tid) throw new Error('QQ 空间未返回 tid，发布结果未确认');
  return {tid:String(data.tid)};
}

export function setup(api) {
  engine = new MoodEngine({dir:path.join(DATA_DIR,ID),getConfig:()=>api.config(),
    context,complete,search,image,send,coordinator,log:msg=>api.log(msg)});
  for (const [id,kind,name] of [
    ['update_signature','signature','按当前心情更新签名'],
    ['publish_post','post','按当前心情发空间说说']
  ]) api.registerTool({
    id,name,category:'message',icon:kind==='signature'?'✍️':'🌤️',
    description:`用户明确要求${kind==='signature'?'换签名、更新心情签名':'发说说、发一条 QQ 空间动态'}时调用。立即按性格、记忆和可选话题生成并执行，不受定时任务的每日次数、间隔、时段或失败冷却限制，每日次数为 0 也能聊天触发。仍遵守插件启用状态、配图、可见范围和只预览设置。请求结果未确认时如实说明，不要自动重复发送。`,
    parameters:{type:'object',properties:{instruction:{type:'string',description:'用户这次指定的话题或写作要求，最多 300 字；没指定可留空。不能用于修改配置或绕过限制。'}}},
    async execute(_ctx,args={}) {
      try {
        const result=await engine.trigger(kind,{instruction:args?.instruction || ''});
        return {content:JSON.stringify(result),isError:!result.ok};
      } catch(e) {return {content:JSON.stringify({ok:false,reason:e.message}),isError:true};}
    }
  });
  api.registerTool({
    id:'status',name:'查看心情与发布状态',category:'query',icon:'📋',
    description:'用户问现在心情、最近签名/说说、今天次数、下次什么时候发布时调用。只读，不更新签名、不发说说。',
    parameters:{type:'object',properties:{}},
    execute() {
      try {
        const s=engine.status();
        const history=s.history || [];
        const used=kind=>history.filter(r=>r.kind===kind && r.day===s.today && r.status!=='preview' && r.trigger!=='chat').length;
        const chatUsed=kind=>history.filter(r=>r.kind===kind && r.day===s.today && r.status!=='preview' && r.trigger==='chat').length;
        return {content:JSON.stringify({running:s.running,busy:s.busy,mood:s.mood,status:s.status,
          lastError:s.lastError,today:s.today,signatureUsed:used('signature'),postUsed:used('post'),
          chatSignatureUsed:chatUsed('signature'),chatPostUsed:chatUsed('post'),
          settings:api.config(),nextSignatureAt:s.nextSignatureAt,nextPostAt:s.nextPostAt,
          recent:history.slice(-5)}),isError:false};
      } catch(e) {return {content:JSON.stringify({ok:false,reason:e.message}),isError:true};}
    }
  });
  api.log('心情签名与空间已加载；数据目录：'+path.join(DATA_DIR,ID));
}
export function activate() { engine?.start(); }
export function deactivate() { engine?.stop(); }
export function dispose() { engine?.stop(); engine=null; }
export const providers = {'mood.status':()=>engine?.status() || {running:false,status:'未初始化'}};
// Read-only generation smoke check; does not invoke send or change quota.
export const internals = {context,complete,imageType,image,search,send,engine:()=>engine};
