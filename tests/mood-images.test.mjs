import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommonsService,validateImage,trustedUrl,parseBingImages,within,networkError,imageMatchesQuery,visualQuery} from '../plugins/mood-qzone/network.js';

const jpeg=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(40)]);
const picture=(name='sample')=>({index:1,imageinfo:[{mime:'image/jpeg',
  thumburl:'https://thumb.wikimedia.org/'+name+'.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:'+name,
  extmetadata:{Artist:{value:'<b>Test Author</b>'},LicenseShortName:{value:'CC BY-SA 4.0'}}}]});
const response=(data,contentType='application/json')=>({status:200,buffer:Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data)),contentType});
function fixture({lock={enabled:false,allowed:true},...overrides}={}) {
  const calls=[];
  const request=async raw=>{calls.push(raw);return new URL(raw).hostname==='commons.wikimedia.org'
    ? response({query:{pages:{1:picture()}}}):response(jpeg,'image/jpeg');};
  const service=createCommonsService({safeFetchBinary:async()=>{throw new Error('fake-IP DNS');},
    checkLock:()=>lock,nativeRequest:request,requestProxy:async()=>{throw new Error('No proxy');},...overrides});
  return {service,calls,lock};
}

test('无代理时系统网络取图，支持新缩略图主机、英文检索和许可元数据',async()=>{
  const {service,calls}=fixture();const result=await service.image('深蓝色海洋',null,{fallbackQuery:'blue sea'});
  assert.equal(calls.length,2);
  assert.equal(new URL(calls[0]).searchParams.get('gsrsearch'),'blue sea filetype:bitmap');
  assert.equal(result.data,'base64://'+jpeg.toString('base64'));
  assert.equal(result.credit,'Test Author');assert.equal(result.license,'CC BY-SA 4.0');
  assert.equal(trustedUrl(result.source).hostname,'thumb.wikimedia.org');
});
test('直连成功时不走备用网络',async()=>{
  let fallback=0;
  const {service}=fixture({safeFetchBinary:async raw=>new URL(raw).hostname==='commons.wikimedia.org'
    ?response({query:{pages:{1:picture()}}}):response(jpeg,'image/jpeg'),nativeRequest:async()=>{fallback++;throw Error('unexpected');}});
  await service.image('sea');assert.equal(fallback,0);
});
test('开启浏览锁定时不走备用通道',async()=>{
  for(const allowed of [true,false]){
    const {service,calls}=fixture({lock:{enabled:true,allowed}});
    await assert.rejects(service.image('sea'));assert.equal(calls.length,0);
  }
});
test('搜索期间开启锁定，不继续下载',async()=>{
  const lock={enabled:false,allowed:true};let calls=0;
  const {service}=fixture({lock,nativeRequest:async()=>{calls++;lock.enabled=true;lock.allowed=false;return response({query:{pages:{1:picture()}}});}});
  await assert.rejects(service.image('sea'));assert.equal(calls,1);
});
test('每一跳验证重定向，禁止外站和本机',async()=>{
  for(const redirect of ['https://127.0.0.1/a','https://evil.test/a','http://thumb.wikimedia.org/a']){
    let requests=0;
    const {service}=fixture({nativeRequest:async()=>{requests++;return {status:302,redirect};}});
    await assert.rejects(service.image('sea'),/只允许固定/);assert.equal(requests,1);
  }
});
test('支持 Wikimedia 域名之间的逐跳重定向',async()=>{
  const calls=[];
  const {service}=fixture({nativeRequest:async raw=>{
    calls.push(raw);
    if(new URL(raw).hostname==='commons.wikimedia.org')return response({query:{pages:{1:picture()}}});
    if(new URL(raw).hostname==='thumb.wikimedia.org')return {status:302,redirect:'https://upload.wikimedia.org/a.jpg'};
    return response(jpeg,'image/jpeg');
  }});
  assert.match((await service.image('sea')).data,/^base64:\/\//);assert.equal(calls.length,3);
});
test('取消任务立即停止，不再尝试下一张或代理',async()=>{
  const controller=new AbortController();let calls=0;
  const {service}=fixture({nativeRequest:async()=>{calls++;controller.abort(Error('已停用'));throw Error('network');}});
  await assert.rejects(service.image('sea',controller.signal),/已停用/);assert.equal(calls,1);
});
test('候选图无效时继续尝试下一张',async()=>{
  const {service}=fixture({safeFetchBinary:async raw=>{
    if(new URL(raw).hostname==='commons.wikimedia.org')return response({query:{pages:{1:picture('bad'),2:{...picture('good'),index:2}}}});
    return response(raw.includes('bad')?Buffer.from('not really an image but a failure page'):jpeg,'image/jpeg');
  }});
  assert.match((await service.image('sea')).source,/good.jpg/);
});
test('英文无结果时尝试原始关键词',async()=>{
  const terms=[];
  const {service}=fixture({safeFetchBinary:async raw=>{
    const u=new URL(raw);if(u.hostname!=='commons.wikimedia.org')return response(jpeg,'image/jpeg');
    terms.push(u.searchParams.get('gsrsearch'));
    return response(terms.length===1?{}:{query:{pages:{1:picture()}}});
  }});
  await service.image('海洋',null,{fallbackQuery:'ocean'});assert.deepEqual(terms,['ocean filetype:bitmap','海洋 filetype:bitmap']);
});
test('假图片、不支持格式和达到大小上限的图片被拒绝',()=>{
  for(const value of [response(Buffer.alloc(30),'image/png'),response(jpeg,'text/html'),
    response(Buffer.alloc(5*1024*1024),'image/jpeg'),response(Buffer.alloc(10),'image/jpeg')])assert.throws(()=>validateImage(value));
  assert.equal(validateImage(response(jpeg,'image/jpeg')),jpeg);
});

const bingTag=(thumbnail='https://ts3.mm.bing.net/th?id=OIP.test&pid=15.1',title='rain window 雨天窗边')=>'<a m="'+JSON.stringify({murl:'https://external.example/never-download.jpg',turl:thumbnail,purl:'https://example.org/photo',t:title})
  .replaceAll('&','&amp;').replaceAll('"','&quot;')+'">图</a>';
test('解析超过宿主50KB上限的图片专用结果页',()=>{
  const r=parseBingImages('x'.repeat(60000)+bingTag());
  assert.equal(r.length,1);assert.equal(r[0].thumbnail,'https://ts3.mm.bing.net/th?id=OIP.test&pid=15.1');
});
test('Bing缩略图拒绝外站地址、错误属性，并且去重',()=>{
  const html=bingTag()+bingTag()+bingTag('https://127.0.0.1/private')+bingTag('https://ts3.mm.bing.net.evil.test/a')+'<a m="broken">';
  assert.equal(parseBingImages(html).length,1);
});
test('Bing实际取图只下载固定CDN，不下载外站原图',async()=>{
  const requested=[];
  const {service}=fixture({safeFetchBinary:async()=>{throw Error('fake IP');},nativeRequest:async raw=>{
    requested.push(raw);
    return new URL(raw).hostname==='cn.bing.com'?response(Buffer.from(bingTag()),'text/html'):response(jpeg,'image/jpeg');
  }});
  const result=await service.bingImage('雨天窗边');
  assert.equal(result.provider,'Bing 图片');assert.equal(result.query,'雨天窗边');
  assert.deepEqual(requested.map(raw=>new URL(raw).hostname),['cn.bing.com','ts3.mm.bing.net']);
});
test('Bing空结果和浏览锁定不会偷偷使用外站图源',async()=>{
  const {service}=fixture({safeFetchBinary:async()=>response(Buffer.from('<html>captcha</html>'),'text/html')});
  await assert.rejects(service.bingImage('rain'),/没有返回候选图/);
  const locked=fixture({lock:{enabled:true,allowed:false}});
  await assert.rejects(locked.service.bingImage('rain'),/浏览锁定/);assert.equal(locked.calls.length,0);
});
test('宿主下载卡住会超时，以便继续备用连接',async()=>{
  await assert.rejects(within(new Promise(()=>{}),null,10),/宿主安全下载超时/);
});
test('等待宿主下载时取消会立即结束',async()=>{
  const controller=new AbortController();
  const pending=within(new Promise(()=>{}),controller.signal,1000);
  controller.abort(Error('主程序已停用'));
  await assert.rejects(pending,/主程序已停用/);
});
test('保留curl真实错误，不用长命令掩盖超时原因',()=>{
  assert.equal(networkError({code:28,stderr:'curl: (28) Connection timed out',message:'Command failed: lots of arguments'}),
    'curl 28: curl: (28) Connection timed out');
});
test('不把与主题无关的标题当成匹配配图',()=>{
  assert.equal(imageMatchesQuery('DeepL Translator','deep blue ocean'),false);
  assert.equal(imageMatchesQuery('米粉和红烧肉','雨天窗边'),false);
  assert.equal(imageMatchesQuery('深蓝SL03汽车','深蓝色海洋'),false);
  assert.equal(imageMatchesQuery('党史军史上的今天','雨天窗边玻璃上的雨滴'),false);
  assert.equal(imageMatchesQuery('Ocean waves on a coast','deep blue ocean'),true);
  assert.equal(imageMatchesQuery('Looping Rain On Window','rainy window'),true);
});
test('冗长英文配图词压缩为具体事物，保留雨窗组合',()=>{
  assert.equal(visualQuery('deep blue ocean'),'ocean');
  assert.equal(visualQuery('rain drops window glass'),'rain window');
  assert.equal(visualQuery('autumn rain window'),'rain window');
  assert.equal(visualQuery('ocean waves calm sea coastline'),'ocean waves');
});
test('不下载不相关的搜索结果，并且英文空格用百分号编码',async()=>{
  const requested=[];
  const {service}=fixture({safeFetchBinary:async raw=>{requested.push(raw);return response(Buffer.from(bingTag(undefined,'Chinese noodles')),'text/html');}});
  await assert.rejects(service.bingImage('rain window'),/标题与检索词无关/);
  assert.equal(requested.length,1);assert.match(requested[0],/q=rain%20window/);
});
