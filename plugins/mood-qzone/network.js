// Fixed image-search services and CDNs only; never tunnel arbitrary model-supplied URLs.
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const run=promisify(execFile);
const TRUSTED = new Set(['zh.wikipedia.org','commons.wikimedia.org','upload.wikimedia.org','thumb.wikimedia.org',
  'cn.bing.com','www.bing.com',...['ts','tse'].flatMap(prefix=>[1,2,3,4].map(n=>`${prefix}${n}.mm.bing.net`))]);
export function trustedUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !TRUSTED.has(u.hostname)) {
    throw new Error('备用通道只允许固定的图片搜索 HTTPS 服务');
  }
  return u;
}
let cachedProxy, proxyCheckedAt=0;
export function systemProxy() {
  if (Date.now()-proxyCheckedAt<60000) return cachedProxy;
  proxyCheckedAt=Date.now(); cachedProxy='';
  const env=process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) { cachedProxy=String(env); return cachedProxy; }
  if (process.platform !== 'win32') return '';
  try {
    const text=execFileSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      {encoding:'utf8',windowsHide:true,timeout:2000});
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text)) return '';
    let value=/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(text)?.[1]?.trim() || '';
    if (value.includes('=')) value=/(?:^|;)\s*https=([^;]+)/i.exec(value)?.[1] || /(?:^|;)\s*http=([^;]+)/i.exec(value)?.[1] || '';
    if (value) cachedProxy=/^https?:\/\//i.test(value)?value:'http://'+value;
  } catch {}
  return cachedProxy;
}
export function imageType(buf) {
  if (buf.length>3 && buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff) return 'image/jpeg';
  if (buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (/^GIF8[79]a/.test(buf.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (buf.subarray(0,4).toString()==='RIFF' && buf.subarray(8,12).toString()==='WEBP') return 'image/webp';
  return '';
}
export function validateImage({buffer,contentType}) {
  if (!Buffer.isBuffer(buffer) || buffer.length<20 || buffer.length>=5*1024*1024 ||
      !/^image\//i.test(contentType) || !imageType(buffer)) throw new Error('图片类型不符或达到 5 MB 上限');
  return buffer;
}

// No automatic redirects: the caller validates every next host, including CDN redirects.
async function windowsRequest(raw,{signal,cap}) {
  const marker='\nQQAGENT_HTTP_META\n';
  const proxy=systemProxy();
  // Domestic Bing works directly even when the configured proxy cannot reach it.
  const routes=new URL(raw).hostname.endsWith('bing.com')||new URL(raw).hostname.endsWith('.mm.bing.net')
    ? [...new Set(['',proxy])]:[...new Set([proxy,''])];
  const failures=[];
  for(const route of routes) {
  signal?.throwIfAborted();
  try {
  const {stdout}=await run(path.join(process.env.SystemRoot||'C:\\Windows','System32','curl.exe'),[
    '--disable','--silent','--show-error','--max-time','15','--proto','=https','--max-redirs','0',
    '--proxy',route,
    '--ssl-revoke-best-effort','--max-filesize',String(cap),
    '--user-agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQAgent-Mood/1.1.3',
    '--write-out',marker+'%{http_code}\n%{content_type}\n%{redirect_url}',
    '--url',trustedUrl(raw).href
  ],{encoding:'buffer',windowsHide:true,timeout:18000,maxBuffer:cap+8192,signal});
  const index=stdout.lastIndexOf(Buffer.from(marker));
  if(index<0)throw new Error('系统网络未返回响应状态');
  const [status,contentType,redirect]=stdout.subarray(index+Buffer.byteLength(marker)).toString('utf8').split('\n');
  return {status:Number(status),contentType,redirect,buffer:stdout.subarray(0,index)};
  }catch(e){signal?.throwIfAborted();failures.push(`${route?'系统代理':'直连'}：${networkError(e)}`);}
  }
  throw new Error(failures.join('；'));
}
export function networkError(error) {
  const detail=String(error.stderr||'').trim();
  return detail?`curl ${error.code || ''}: ${detail.slice(0,200)}`:
    `${error.code?error.code+': ':''}${String(error.message||error).split('\n')[0].slice(0,200)}`;
}
export function within(task,signal,milliseconds=4000) {
  return new Promise((resolve,reject)=>{
    const finish=(fn,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);fn(value);};
    const aborted=()=>finish(reject,signal.reason);
    const timer=setTimeout(()=>finish(reject,new Error('宿主安全下载超时，改用系统网络')),milliseconds);
    signal?.addEventListener('abort',aborted,{once:true});
    Promise.resolve(task).then(v=>finish(resolve,v),e=>finish(reject,e));
    if(signal?.aborted)aborted();
  });
}
async function proxyRequest(raw,{signal,cap}) {
  const proxy=systemProxy();
  if (!proxy) throw new Error('没有可用的系统 HTTP 代理');
  const {fetch,ProxyAgent}=await import('undici');
  const agent=new ProxyAgent(proxy);
  let response;
  try {
      response=await fetch(trustedUrl(raw),{dispatcher:agent,redirect:'manual',
        headers:{'user-agent':'QQAgent-Mood/1.1.2 (personal assistant)'},
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
      if ([301,302,303,307,308].includes(response.status)) {
        return {status:response.status,redirect:response.headers.get('location'),buffer:Buffer.alloc(0)};
      }
      const reader=response.body.getReader(),chunks=[];
      let size=0;
      try {
        while(true) {
          const {done,value}=await reader.read();if(done)break;
          size+=value.byteLength;
          if(size>=cap) {await reader.cancel();throw new Error('备用网络内容超出大小限制');}
          chunks.push(Buffer.from(value));
        }
      } finally {reader.releaseLock();}
      const buffer=Buffer.concat(chunks);
      return {buffer,status:response.status,contentType:response.headers.get('content-type') || ''};
  } finally {
    try {await response?.body?.cancel();} catch {}
    await agent.close();
  }
}
function apiUrl(host,params) {return 'https://'+host+'/w/api.php?'+new URLSearchParams({action:'query',format:'json',...params});}
function plain(s) {return String(s || '').replace(/<[^>]*>/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}

export function createCommonsService({safeFetchBinary,checkLock,
  nativeRequest=process.platform==='win32'?windowsRequest:null,requestProxy=proxyRequest}) {
  const allowed=raw=>{
    const lock=checkLock(trustedUrl(raw).href);
    if(!lock.allowed)throw new Error('浏览锁定未允许 Wikimedia 服务');
    return lock;
  };
  async function trustedFetch(raw,{binary=false,signal}={}) {
    let url=trustedUrl(raw);
    const cap=binary?5*1024*1024:1024*1024;
    signal?.throwIfAborted();allowed(url);
    try {
      const r=await within(safeFetchBinary(url.href,cap,{browseLocked:true}),signal);
      signal?.throwIfAborted();allowed(url);
      if(r.buffer.length>=cap)throw new Error('备用网络内容超出大小限制');
      return binary?r:JSON.parse(r.buffer.toString('utf8'));
    }catch(e){
      signal?.throwIfAborted();
      // Alternate transports never bypass an enabled browser lock.
      if(allowed(url).enabled)throw e;
    }
    const errors=[];
    for(const request of [nativeRequest,requestProxy].filter(Boolean)) {
      url=trustedUrl(raw);
      try {
        for(let hop=0;hop<4;hop++) {
          signal?.throwIfAborted();
          if(allowed(url).enabled)throw new Error('浏览锁定已开启，停止备用连接');
          const r=await request(url.href,{cap,signal});
          signal?.throwIfAborted();
          if(allowed(url).enabled)throw new Error('浏览锁定已开启，停止备用连接');
          if([301,302,303,307,308].includes(r.status)) {
            if(!r.redirect)throw new Error('备用网络重定向缺少目标');
            url=trustedUrl(new URL(r.redirect,url));continue;
          }
          if(r.status!==200)throw new Error('Wikimedia 服务 HTTP '+r.status);
          if(r.buffer.length>=cap)throw new Error('备用网络内容超出大小限制');
          return binary?r:JSON.parse(r.buffer.toString('utf8'));
        }
        throw new Error('备用网络重定向过多');
      }catch(e){signal?.throwIfAborted();errors.push(networkError(e));}
    }
    throw new Error(errors.join('；').slice(0,300));
  }
  async function search(query,signal) {
    const data=await trustedFetch(apiUrl('zh.wikipedia.org',{list:'search',srsearch:query,srlimit:'4',srprop:'snippet'}),{signal});
    const results=(data.query?.search || []).map(r=>({title:r.title,url:'https://zh.wikipedia.org/wiki/'+encodeURIComponent(r.title),snippet:plain(r.snippet)}));
    if (!results.length) throw new Error('维基百科没有匹配话题');
    return {query,provider:'Wikimedia 备用：维基百科',results};
  }
  async function image(query,signal,{fallbackQuery=''}={}) {
    const errors=[];
    // Commons metadata is mainly English; prefer the model's concise visual translation.
    const terms=[...new Set([fallbackQuery,query].map(s=>String(s||'').trim()).filter(Boolean))].slice(0,2);
    for(const term of terms) {
      signal?.throwIfAborted();
      try {
        const data=await trustedFetch(apiUrl('commons.wikimedia.org',{
          generator:'search',gsrnamespace:'6',gsrsearch:term+' filetype:bitmap',gsrlimit:'5',
          prop:'imageinfo',iiprop:'url|mime|extmetadata',iiurlwidth:'960'
        }),{signal});
        if(data.error)throw new Error(data.error.info || data.error.code);
        for (const page of Object.values(data.query?.pages || {}).sort((a,b)=>(a.index||0)-(b.index||0))) {
          const info=page.imageinfo?.[0];
          if (!info || !/^image\/(jpeg|png|gif|webp)$/.test(info.mime)) continue;
          try {
            const url=info.thumburl || info.url;
            const {buffer,contentType}=await trustedFetch(url,{binary:true,signal});
            validateImage({buffer,contentType});
            return {data:'base64://'+buffer.toString('base64'),source:url,
              page:info.descriptionurl,credit:plain(info.extmetadata?.Artist?.value),
              license:plain(info.extmetadata?.LicenseShortName?.value),provider:'Wikimedia Commons',query:term};
          } catch(e) {signal?.throwIfAborted();errors.push(e.message);}
        }
      }catch(e){signal?.throwIfAborted();errors.push(e.message);}
    }
    throw new Error('Wikimedia 没有可用配图'+(errors.length?'：'+errors.join('；').slice(0,500):'，可尝试英文配图关键词'));
  }
  async function bingImage(query,signal) {
    const searchQuery=visualQuery(query);
    const url='https://cn.bing.com/images/async?q='+encodeURIComponent(searchQuery)+'&count=6&first=1&adlt=strict';
    const {buffer}=await trustedFetch(url,{binary:true,signal});
    const candidates=parseBingImages(buffer.toString('utf8')).filter(item=>imageMatchesQuery(item.title,searchQuery));
    const errors=[];
    for(const item of candidates.slice(0,6)) {
      signal?.throwIfAborted();
      try {
        // Fetch only Bing's own thumbnails; never pass external origin URLs to curl.
        const r=await trustedFetch(item.thumbnail,{binary:true,signal});
        validateImage(r);
        return {data:'base64://'+r.buffer.toString('base64'),source:item.thumbnail,
          page:item.page,title:item.title,provider:'Bing 图片',query:searchQuery};
      }catch(e){signal?.throwIfAborted();errors.push(e.message);}
    }
    throw new Error(candidates.length?'Bing 缩略图下载失败：'+errors.join('；').slice(0,350):'Bing 图片页没有返回候选图，或结果标题与检索词无关');
  }
  return {search,image,bingImage};
}

function decodeHtml(value) {
  return String(value).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)))
    .replace(/&amp;/g,'&');
}
export function parseBingImages(html) {
  const out=[],seen=new Set();
  for(const match of String(html).matchAll(/\bm\s*=\s*"([^"]+)"/g)) {
    try {
      const item=JSON.parse(decodeHtml(match[1]));
      const thumbnail=trustedUrl(item.turl).href;
      if(!new URL(thumbnail).hostname.endsWith('.mm.bing.net')||seen.has(thumbnail))continue;
      seen.add(thumbnail);
      out.push({thumbnail,page:/^https?:\/\//i.test(item.purl||'')?item.purl:null,title:plain(item.t||item.desc)});
    }catch{}
  }
  return out;
}
const VAGUE=new Set(['deep','blue','calm','soft','beautiful','scene','landscape','photo','photograph','photography','image','picture','the','and','with','light','dark','quiet','peaceful']);
function visualWords(query) {return (String(query).toLowerCase().match(/[a-z]{3,}/g)||[]).filter(w=>!VAGUE.has(w));}
export function visualQuery(query) {
  const words=visualWords(query).map(w=>w==='rainy'?'rain':w);
  if(words.includes('rain')&&words.includes('window'))return 'rain window';
  return words.length?words.slice(0,2).join(' '):query;
}
export function imageMatchesQuery(title,query) {
  const text=String(title||'').toLowerCase();
  const words=visualWords(query);
  if(words.length)return words.filter(w=>new RegExp('\\b'+w.replace(/(?:ing|y|s)$/,'')+'[a-z]*\\b','i').test(text)).length>=Math.min(2,words.length);
  const chinese=String(query).match(/[\u4e00-\u9fff]+/g)||[];
  return chinese.some(part=>part.length>=2 && text.includes(part.slice(-2)));
}
