// Scoped fallback for Windows system proxies with fake-IP DNS. It can only contact
// these fixed Wikimedia services; it never tunnels arbitrary model-supplied URLs.
import {execFileSync} from 'node:child_process';
const TRUSTED = new Set(['zh.wikipedia.org','commons.wikimedia.org','upload.wikimedia.org']);
export function trustedUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !TRUSTED.has(u.hostname)) {
    throw new Error('代理备用通道只允许固定的 Wikimedia HTTPS 服务');
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
async function trustedFetch(raw,{binary=false,signal=null}={}) {
  const proxy=systemProxy();
  if (!proxy) throw new Error('没有可用的系统 HTTP 代理');
  const {fetch,ProxyAgent}=await import('undici');
  const agent=new ProxyAgent(proxy);
  let response;
  try {
    let url=trustedUrl(raw);
    for(let hop=0;hop<4;hop++) {
      response=await fetch(url,{dispatcher:agent,redirect:'manual',
        headers:{'user-agent':'QQAgent-Mood/1.0 (personal assistant)','accept':binary?'image/*':'application/json'},
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
      if ([301,302,303,307,308].includes(response.status)) {
        const loc=response.headers.get('location');
        await response.body?.cancel();response=null;
        if (!loc) throw new Error('备用网络重定向缺少目标');
        url=trustedUrl(new URL(loc,url)); continue;
      }
      if (!response.ok) throw new Error('备用 Wikimedia 服务 HTTP '+response.status);
      const cap=binary?5*1024*1024:1024*1024;
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
      return binary?{buffer,contentType:response.headers.get('content-type') || ''}:JSON.parse(buffer.toString('utf8'));
    }
    throw new Error('备用网络重定向过多');
  } finally {
    try {await response?.body?.cancel();} catch {}
    await agent.close();
  }
}
function apiUrl(host,params) {return 'https://'+host+'/w/api.php?'+new URLSearchParams({action:'query',format:'json',...params});}
function plain(s) {return String(s || '').replace(/<[^>]*>/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
export async function proxySearch(query,signal) {
  const data=await trustedFetch(apiUrl('zh.wikipedia.org',{list:'search',srsearch:query,srlimit:'4',srprop:'snippet'}),{signal});
  const results=(data.query?.search || []).map(r=>({title:r.title,url:'https://zh.wikipedia.org/wiki/'+encodeURIComponent(r.title),snippet:plain(r.snippet)}));
  if (!results.length) throw new Error('维基百科没有匹配话题');
  return {query,provider:'系统代理备用：维基百科',results};
}
export async function proxyImage(query,signal) {
  const data=await trustedFetch(apiUrl('commons.wikimedia.org',{
    generator:'search',gsrnamespace:'6',gsrsearch:query+' filetype:bitmap',gsrlimit:'5',
    prop:'imageinfo',iiprop:'url|mime|extmetadata',iiurlwidth:'1200'
  }),{signal});
  const errors=[];
  for (const page of Object.values(data.query?.pages || {})) {
    const info=page.imageinfo?.[0];
    if (!info || !/^image\/(jpeg|png|gif|webp)$/.test(info.mime)) continue;
    try {
      const url=info.thumburl || info.url;
      const {buffer,contentType}=await trustedFetch(url,{binary:true,signal});
      if (!/^image\//i.test(contentType) || buffer.length<20) throw new Error('备用源未返回图片');
      return {data:'base64://'+buffer.toString('base64'),source:url,
        page:info.descriptionurl,credit:plain(info.extmetadata?.Artist?.value),
        license:plain(info.extmetadata?.LicenseShortName?.value),provider:'Wikimedia Commons'};
    } catch(e) {errors.push(e.message);}
  }
  throw new Error('Wikimedia 没有可用配图'+(errors.length?'：'+errors.join('；'):'，可尝试英文配图关键词'));
}
