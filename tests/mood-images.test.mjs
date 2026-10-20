import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommonsService,validateImage,trustedUrl} from '../plugins/mood-qzone/network.js';

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
