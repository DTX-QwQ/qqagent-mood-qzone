import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogue,rankMemes,createMemeService} from '../plugins/mood-qzone/memes.js';
import {createCommonsService} from '../plugins/mood-qzone/network.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=','base64');
const item=(id,title='开心摸鱼')=>({original:`https://img.aigengtu.com/meme/${id}.webp`,alt:title});
const data={gallery:{a:{images:[item('1'),item('2'),item('3','委屈难过'),item('1')]}}};
test('解析真实索引形状，去掉重复和外站原图',()=>{
  const items=catalogue(data);assert.equal(items.length,3);
  assert.equal(rankMemes(items,'开心', [items[0].source])[0].source,items[1].source);
  assert.throws(()=>catalogue({gallery:{a:{images:[{original:'https://evil.test/meme/1.webp'}]}}}));
});
test('原图返回HTML即使伪称image/webp也跳过，下载原图而非preview',async()=>{
  const requested=[];
  const s=createMemeService({trustedFetch:async url=>{
    requested.push(url);
    if(url.endsWith('.json'))return data;
    return {buffer:url.endsWith('/1.webp')?Buffer.from('<html>404 missing image</html>'):png,contentType:'image/webp'};
  }});
  const m=await s.image('开心');assert.match(m.source,/2.webp$/);assert.match(m.data,/^base64:\/\//);
  assert.equal(m.hash.length,64);assert.ok(requested.every(x=>!x.includes('preview')));
  await assert.rejects(s.image('开心',null,{excluded:[m.source],excludedHashes:[m.hash]}),/无效或已使用/);
});
test('模型只可选索引内编号，拒绝无关候选',async()=>{
  for(const selected of [-1,99,'0']) {
    let downloads=0;
    const s=createMemeService({choose:async()=>selected,trustedFetch:async url=>{
      if(url.endsWith('.json'))return data;downloads++;throw Error('unexpected');
    }});
    await assert.rejects(s.image('开心'),/没有贴合/);assert.equal(downloads,0);
  }
});
test('取消不继续下载下一张',async()=>{
  const c=new AbortController();
  const s=createMemeService({trustedFetch:async url=>{
    if(url.endsWith('.json'))return data;
    c.abort(Error('cancelled'));throw Error('bad image');
  }});
  await assert.rejects(s.image('开心',c.signal),/cancelled/);
});
test('索引超过1MB仍完整读取；假JSON走备用传输',async()=>{
  let cap,attempts=0;
  const service=createCommonsService({checkLock:()=>({allowed:true,enabled:false}),
    safeFetchBinary:async(url,max)=>{cap=max;return {buffer:Buffer.from('<html>error</html>')};},
    nativeRequest:async()=>{attempts++;return {status:200,buffer:Buffer.from(JSON.stringify(data))};},
    requestProxy:null});
  assert.deepEqual(await service.trustedFetch('https://aigengtu.com/gallery-index.json'),data);
  assert.ok(cap>1228441);assert.equal(attempts,1);
});
