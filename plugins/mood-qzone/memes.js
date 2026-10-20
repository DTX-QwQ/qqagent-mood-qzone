import crypto from 'node:crypto';
import {validateImage} from './network.js';

const INDEX='https://aigengtu.com/gallery-index.json';
const STOP=new Set(['表情','情包','梗图','配图','图片','一张','一个','今天','自己','觉得','有点']);
function words(text) {
  const out=new Set(String(text||'').toLowerCase().match(/[a-z0-9]{2,}/g)||[]);
  for(const chunk of String(text||'').match(/[\u4e00-\u9fff]+/g)||[])
    for(let i=0;i<chunk.length-1;i++)if(!STOP.has(chunk.slice(i,i+2)))out.add(chunk.slice(i,i+2));
  return [...out];
}
export function catalogue(data) {
  if(!data?.gallery || typeof data.gallery!=='object')throw Error('梗鲸索引格式无效');
  const seen=new Set(),out=[];
  for(const group of Object.values(data.gallery))for(const item of group?.images||[]) {
    try {
      const u=new URL(item.original);
      if(u.origin!=='https://img.aigengtu.com'||!/^\/meme\/[\w-]+\.(webp|png|jpe?g|gif)$/i.test(u.pathname)||seen.has(u.href))continue;
      seen.add(u.href);
      out.push({source:u.href,title:String(item.alt||item.name||'').slice(0,200),
        category:String(item.category||group.name||''),story:String(item.story?.zh||'').slice(0,700)});
    }catch{}
  }
  if(!out.length)throw Error('梗鲸索引没有有效原图');
  return out;
}
export function rankMemes(items,query,excluded=[]) {
  const terms=words(query),skip=new Set(excluded);
  return items.filter(x=>!skip.has(x.source)).map(item=>{
    const title=(item.title+' '+item.category).toLowerCase(),story=item.story.toLowerCase();
    return {...item,score:terms.reduce((n,w)=>n+(title.includes(w)?4:story.includes(w)?1:0),0)};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
}
export function createMemeService({trustedFetch,choose}) {
  let cache,expires=0;
  async function image(query,signal,{excluded=[],excludedHashes=[]}={}) {
    signal?.throwIfAborted();
    if(!cache||Date.now()>=expires) {
      cache=catalogue(await trustedFetch(INDEX,{signal}));expires=Date.now()+3600000;
    }
    let candidates=rankMemes(cache,query,excluded).slice(0,20);
    if(!candidates.length)throw Error('梗鲸没有贴合主题且尚未使用的表情包');
    if(choose) {
      const selected=await choose(query,candidates,signal);
      if(!Number.isInteger(selected)||selected<0||selected>=candidates.length)throw Error('没有贴合当前正文的梗鲸表情包');
      candidates=[candidates[selected],...candidates.filter((_,i)=>i!==selected)];
    }
    const errors=[];
    for(const item of candidates.slice(0,8)) {
      signal?.throwIfAborted();
      try {
        const r=await trustedFetch(item.source,{binary:true,signal,validate:validateImage});
        validateImage(r);
        const hash=crypto.createHash('sha256').update(r.buffer).digest('hex');
        if(excludedHashes.includes(hash))continue;
        return {data:'base64://'+r.buffer.toString('base64'),source:item.source,title:item.title,
          hash,provider:'梗鲸',page:'https://aigengtu.com/',query};
      }catch(e){signal?.throwIfAborted();errors.push(e.message);}
    }
    throw Error('梗鲸候选原图无效或已使用：'+errors.join('；').slice(0,300));
  }
  return {image};
}
