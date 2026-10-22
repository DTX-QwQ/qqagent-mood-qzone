import fs from 'node:fs';
import path from 'node:path';

function json(file) {
  try {
    if (fs.statSync(file).size > 32*1024*1024) return null;
    return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  } catch { return null; }
}
function entries(dir) {
  try { return fs.readdirSync(dir,{withFileTypes:true}); } catch { return []; }
}
function files(dir,regex) {
  return entries(dir).filter(e=>e.isFile() && regex.test(e.name)).map(e=>path.join(dir,e.name))
    .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
}

/** Reads only explicitly attributed users; unknown authors and bot replies are excluded. */
export function readMemories({dataDir,userIds,memoryHours,redact,now=Date.now(),fromTs,untilTs,includeImpressions=true}) {
  const users = new Set(userIds), recent = [], impressions = [];
  if (!users.size) return {recent,impressions};
  const cutoff = fromTs ?? now-memoryHours*3600000;
  const end = untilTs ?? now;
  for (const file of files(path.join(dataDir,'messages'),/^(group|private)_\d+\.json$/)) {
    const messages = json(file)?.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages.filter(m=>!m?.self && users.has(String(m?.senderId ?? '')) && Number(m.ts)>=cutoff && Number(m.ts)<=end && m.text).slice(-50)) {
      recent.push({ts:Number(m.ts),self:false,text:redact(m.text).slice(0,400)});
    }
  }
  if (!includeImpressions) return {recent:recent.sort((a,b)=>a.ts-b.ts).slice(-60),impressions};
  const memoryDir = path.join(dataDir,'memory');
  for (const entry of entries(memoryDir).filter(e=>e.isDirectory() && /^(group|private)_\d+$/.test(e.name))) {
    for (const file of files(path.join(memoryDir,entry.name),/^(?!_meta).*\.json$/)) {
      const mem = json(file);
      // Names, chat IDs and file names are never substitutes for the member's userId.
      if (!users.has(String(mem?.userId ?? ''))) continue;
      for (const imp of (Array.isArray(mem?.impressions)?mem.impressions:[]).slice(-3)) {
        if (imp?.content) impressions.push({ts:Number(imp.createdAt)||0,text:redact(imp.content).slice(0,240)});
      }
    }
  }
  return {recent:recent.sort((a,b)=>a.ts-b.ts).slice(-60),
    impressions:impressions.sort((a,b)=>a.ts-b.ts).slice(-30)};
}
