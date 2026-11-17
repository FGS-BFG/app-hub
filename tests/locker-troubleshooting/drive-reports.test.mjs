import test from 'node:test';
import assert from 'node:assert/strict';
import {DriveReportClient,DriveReportError,buildReportPayload,isReportPortalOrigin,validateSaveResult} from '../../locker-troubleshooting/drive-reports.js';

const ENDPOINT='https://script.google.com/macros/s/DEPLOYMENT_ID/exec';
const ORIGIN='https://example-script.googleusercontent.com';
const REPORT_ID='751b6fa0-636a-4d43-b7de-448e42d60ee1';
const FILE_ID='1_saved_report_file_123456789';
const report=()=>({id:REPORT_ID,savedAt:'2026-11-17T17:00:00.000Z',reportText:'MCI 304 LOCKER FIELD GUIDE\nA: responded\n',title:'Locker field report',location:'Site A',technician:'Operator 1'});
const receipt=()=>({fileId:FILE_ID,url:`https://drive.google.com/file/d/${FILE_ID}/view`,reportId:REPORT_ID,name:'Locker field report.txt',savedAt:'2026-11-17T17:00:01.000Z',alreadyCreated:false});
const code=expected=>error=>error instanceof DriveReportError&&error.code===expected;

class Clock{
  time=0;next=0;pending=new Map();
  setTimeout(callback,ms){assert.ok(this instanceof Clock,'timer receiver is preserved');const id=this.next++;this.pending.set(id,{callback,at:this.time+ms});return id;}
  clearTimeout(id){assert.ok(this instanceof Clock,'timer receiver is preserved');this.pending.delete(id);}
  advance(ms){
    const end=this.time+ms;
    for(let count=0;;count++){
      assert.ok(count<10000,'timer loop is bounded');
      const next=[...this.pending.entries()].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;
      this.time=next[1].at;this.pending.delete(next[0]);next[1].callback();
    }
    this.time=end;
  }
}

function frame(children=[]){
  const item={frames:children,messages:[],closed:false,closeCalls:0,
    postMessage(data,targetOrigin){assert.equal(this,item);item.messages.push({data:structuredClone(data),targetOrigin});},
    close(){item.closeCalls++;item.closed=true;},
  };
  Object.defineProperty(item,'location',{get(){throw new Error('Cross-origin location access is forbidden');}});
  Object.defineProperty(item,'document',{get(){throw new Error('Cross-origin document access is forbidden');}});
  return item;
}

function setup({endpoint=ENDPOINT,popup=frame(),blocked=false,...options}={}){
  const clock=new Clock(),listeners=new Set(),opened=[];
  let sequence=0;
  const crypto={randomUUID(){assert.equal(this,crypto);return `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;}};
  const browser={crypto,
    open(url,target,features){assert.equal(this,browser);opened.push({url,target,features});return blocked?null:popup;},
    addEventListener(type,listener){assert.equal(this,browser);assert.equal(type,'message');listeners.add(listener);},
    removeEventListener(type,listener){assert.equal(this,browser);assert.equal(type,'message');listeners.delete(listener);},
    setTimeout(callback,ms){assert.equal(this,browser);return clock.setTimeout(callback,ms);},
    clearTimeout(id){assert.equal(this,browser);clock.clearTimeout(id);},
  };
  const client=new DriveReportClient({endpoint,window:browser,now:()=>clock.time,...options});
  const emit=(source,origin,data)=>{for(const listener of [...listeners])listener({source,origin,data});};
  const hello=()=>popup.messages.find(x=>x.data.type==='mci-field-reports-hello').data;
  const ready=(source=popup,origin=ORIGIN,overrides={})=>emit(source,origin,{type:'mci-field-reports-ready',nonce:hello().nonce,...overrides});
  const request=(source=popup)=>source.messages.find(x=>x.data.type==='mci-field-reports-request')?.data;
  const respond=(source=popup,origin=ORIGIN,overrides={})=>{
    const current=request(source)||request();
    emit(source,origin,{type:'mci-field-reports-response',nonce:hello().nonce,requestId:current?.requestId,ok:true,result:receipt(),...overrides});
  };
  const start=(value=report())=>{const promise=client.save(value);promise.catch(()=>{});return promise;};
  const clean=()=>{assert.equal(listeners.size,0);assert.equal(clock.pending.size,0);assert.equal(popup.closeCalls,0);};
  return{client,clock,popup,browser,listeners,opened,emit,hello,ready,request,respond,start,clean};
}

test('opens the auth popup synchronously and sends no report until a verified portal is ready',async()=>{
  const run=setup(),pending=run.start();
  assert.equal(run.opened.length,1);
  const url=new URL(run.opened[0].url);
  assert.equal(url.origin,'https://script.google.com');
  assert.equal(url.searchParams.get('nonce'),run.hello().nonce);
  assert.equal(url.searchParams.has('report'),false);
  assert.equal(run.popup.messages.length,1);
  assert.deepEqual(run.popup.messages[0],{data:{type:'mci-field-reports-hello',nonce:run.hello().nonce},targetOrigin:'*'});
  run.ready();
  const sent=run.popup.messages.at(-1);
  assert.equal(sent.targetOrigin,ORIGIN);
  assert.equal(sent.data.action,'save');
  assert.deepEqual(sent.data.report,buildReportPayload(report()));
  run.respond();
  assert.deepEqual(await pending,receipt());
  run.clean();
});

test('discovers child frames and sends actual content only to the exact authenticated child origin',async()=>{
  const portal=frame(),auth=frame(),popup=frame([auth,frame([portal])]);
  const run=setup({popup}),pending=run.start();
  for(const known of [popup,auth,popup.frames[1],portal]){
    assert.equal(known.messages.length,1);
    assert.equal(known.messages[0].targetOrigin,'*');
    assert.deepEqual(Object.keys(known.messages[0].data).sort(),['nonce','type']);
  }
  run.ready(auth,'https://accounts.google.com');
  assert.equal(run.request(auth),undefined);
  run.ready(portal);
  assert.equal(run.request(),undefined);
  assert.equal(run.request(auth),undefined);
  assert.equal(portal.messages.at(-1).targetOrigin,ORIGIN);
  run.respond(portal);await pending;run.clean();
});

test('retries discovery every 250 ms when the Google portal iframe appears later',async()=>{
  const run=setup(),pending=run.start(),portal=frame();
  run.popup.frames.push(portal);
  run.clock.advance(249);assert.equal(portal.messages.length,0);
  run.clock.advance(1);assert.equal(portal.messages.length,1);
  run.ready(portal);run.respond(portal);await pending;run.clean();
});

test('frame enumeration is bounded to 30 windows and three child levels',async()=>{
  const children=Array.from({length:50},()=>frame()),wide=setup({popup:frame(children)}),pending=wide.start();
  assert.equal([wide.popup,...children].filter(x=>x.messages.length).length,30);
  wide.ready();wide.respond();await pending;wide.clean();
  const tooDeep=frame(),level3=frame([tooDeep]),level2=frame([level3]),level1=frame([level2]);
  const deep=setup({popup:frame([level1])}),other=deep.start();
  assert.equal(level3.messages.length,1);
  assert.equal(tooDeep.messages.length,0);
  deep.ready(level3);deep.respond(level3);await other;deep.clean();
});

test('only Google Apps Script content origins are eligible to receive the report',()=>{
  for(const origin of ['https://script.googleusercontent.com',ORIGIN])assert.equal(isReportPortalOrigin(origin),true,origin);
  for(const origin of ['null','http://script.googleusercontent.com','https://script.google.com','https://accounts.google.com',
    'https://evil.googleusercontent.com','https://script.googleusercontent.com.evil.test',`${ORIGIN}/path`,`${ORIGIN}:444`]){
    assert.equal(isReportPortalOrigin(origin),false,origin);
  }
});

test('wrong nonce, wrong origin, and an unrelated window cannot claim to be the report portal',async()=>{
  const run=setup(),pending=run.start(),stranger=frame();
  run.ready(run.popup,ORIGIN,{nonce:'wrong'});
  run.ready(run.popup,'https://accounts.google.com');
  run.ready(stranger);
  assert.equal(run.request(),undefined);
  assert.equal(stranger.messages.length,0);
  run.ready();run.respond();await pending;run.clean();
});

test('responses require the chosen source, exact origin, nonce and request ID',async()=>{
  const child=frame(),run=setup({popup:frame([child])}),pending=run.start();let resolved=false;
  pending.then(()=>{resolved=true;});
  run.ready();
  run.respond(run.popup,ORIGIN,{nonce:'wrong'});
  run.respond(run.popup,ORIGIN,{requestId:'wrong'});
  run.respond(run.popup,'https://script.googleusercontent.com');
  const request=run.request();
  run.emit(child,ORIGIN,{type:'mci-field-reports-response',nonce:request.nonce,requestId:request.requestId,ok:true,result:receipt()});
  await Promise.resolve();assert.equal(resolved,false);
  run.ready(child);
  assert.equal(run.request(child),undefined);
  run.respond();await pending;run.clean();
});

test('ignores an otherwise plausible response before completing the portal handshake',async()=>{
  const run=setup(),pending=run.start();
  run.respond();
  assert.equal(run.listeners.size,1);
  assert.equal(run.request(),undefined);
  run.ready();run.respond();await pending;run.clean();
});

test('no message sent to a wildcard target ever contains report text or other report fields',async()=>{
  const child=frame(),run=setup({popup:frame([child])}),pending=run.start();
  run.clock.advance(1000);run.ready(child);run.respond(child);await pending;
  for(const message of [...run.popup.messages,...child.messages]){
    if(message.targetOrigin==='*'){
      assert.deepEqual(Object.keys(message.data).sort(),['nonce','type']);
      assert.equal(message.data.type,'mci-field-reports-hello');
      assert.equal(JSON.stringify(message.data).includes(report().reportText),false);
    }
  }
  run.clean();
});

test('rejects concurrent saves while preserving the original pending request',async()=>{
  const run=setup(),first=run.start();
  await assert.rejects(run.client.save(report()),code('BUSY'));
  assert.equal(run.opened.length,1);
  run.ready();run.respond();await first;run.clean();
});

test('missing or untrusted endpoint configuration fails before opening a popup',async()=>{
  for(const endpoint of [undefined,'','not a URL','http://script.google.com/macros/s/ID/exec',
    'https://evil.test/macros/s/ID/exec','https://script.google.com/macros/s/ID/dev']){
    const run=setup({endpoint});
    // Passing undefined through setup uses its default, so explicitly clear it here.
    run.client.endpoint=endpoint;
    await assert.rejects(run.client.save(report()),code('CONFIG'));
    assert.equal(run.opened.length,0);run.clean();
  }
});

test('blocked popup reports a clear failure without leaving listeners or timers',async()=>{
  const run=setup({blocked:true});
  await assert.rejects(run.client.save(report()),code('POPUP_BLOCKED'));
  run.clean();
});

test('a closed popup rejects the save and cleans up without reporting success',async()=>{
  const run=setup(),pending=run.start(),rejection=assert.rejects(pending,code('POPUP_CLOSED'));
  run.popup.closed=true;run.clock.advance(250);
  await rejection;run.clean();
});

test('authentication and receipt waiting is capped at eight minutes even with a longer option',async()=>{
  const run=setup({timeoutMs:9999999}),pending=run.start(),rejection=assert.rejects(pending,code('TIMEOUT'));
  run.clock.advance(479999);assert.equal(run.listeners.size,1);
  run.clock.advance(1);await rejection;run.clean();
});

test('server rejection cleans up and does not close the report portal',async()=>{
  const run=setup(),pending=run.start(),rejection=assert.rejects(pending,error=>code('REJECTED')(error)&&/not authorized/.test(error.message));
  run.ready();run.respond(run.popup,ORIGIN,{ok:false,error:'This account is not authorized.'});
  await rejection;run.clean();assert.equal(run.popup.closed,false);
});

test('invalid receipts never confirm a saved report',async()=>{
  for(const changed of [
    {fileId:'bad'},
    {reportId:'another-report'},
    {url:`https://evil.test/file/d/${FILE_ID}/view`},
    {url:`https://drive.google.com.evil.test/file/d/${FILE_ID}/view`},
    {url:`http://drive.google.com/file/d/${FILE_ID}/view`},
    {url:'javascript:alert(1)'},
    {url:'https://drive.google.com/file/d/a_different_file_12345/view'},
  ]){
    const run=setup(),pending=run.start(),rejection=assert.rejects(pending,code('INVALID_RECEIPT'));
    run.ready();run.respond(run.popup,ORIGIN,{result:{...receipt(),...changed}});
    await rejection;run.clean();
  }
});

test('valid Drive and Google Docs receipt URLs must identify the same file',()=>{
  assert.equal(validateSaveResult(receipt(),REPORT_ID).fileId,FILE_ID);
  for(const url of [`https://docs.google.com/document/d/${FILE_ID}/edit`,`https://drive.google.com/open?id=${FILE_ID}`]){
    assert.equal(validateSaveResult({...receipt(),url},REPORT_ID).url,url);
  }
});

test('retrying the same report preserves its ID and content and uses a fresh bridge nonce',async()=>{
  const run=setup(),original=report(),before=structuredClone(original),first=run.start(original);
  const firstNonce=run.hello().nonce;
  const rejected=assert.rejects(first,code('REJECTED'));
  run.ready();const firstPayload=run.request().report;
  run.respond(run.popup,ORIGIN,{ok:false,error:'Please retry.'});await rejected;run.clean();
  run.popup.messages=[];
  const second=run.start(original);
  assert.notEqual(run.hello().nonce,firstNonce);
  run.ready();assert.deepEqual(run.request().report,firstPayload);
  run.respond(run.popup,ORIGIN,{result:{...receipt(),alreadyCreated:true}});
  assert.equal((await second).alreadyCreated,true);
  assert.deepEqual(original,before);run.clean();
});

test('the library opens a normal authenticated popup with no report or bridge traffic',()=>{
  const run=setup({endpoint:ENDPOINT+'?nonce=old'});
  assert.equal(run.client.openLibrary(),run.popup);
  const url=new URL(run.opened[0].url);
  assert.equal(url.searchParams.get('mode'),'library');
  assert.equal(url.searchParams.has('nonce'),false);
  assert.deepEqual(run.popup.messages,[]);run.clean();
});

test('report validation requires a stable UUID, canonical timestamp and valid text before opening',async()=>{
  for(const changed of [
    {id:''},{id:'not-a-uuid'},{reportId:'abc',id:REPORT_ID},
    {savedAt:'yesterday'},{savedAt:'2026-11-17T17:00:00Z'},{reportText:' '},
    {title:''},{technician:undefined},{location:'bad\u0000name'},{title:'x'.repeat(161)},
  ]){
    const run=setup();
    await assert.rejects(run.client.save({...report(),...changed}),code('INVALID_REPORT'));
    assert.equal(run.opened.length,0);run.clean();
  }
  assert.equal(buildReportPayload({...report(),id:REPORT_ID.toUpperCase()}).reportId,REPORT_ID);
});

test('injected timer methods retain their receiver too',async()=>{
  const timers=new Clock(),run=setup({timers,now:()=>timers.time,timeoutMs:250}),pending=run.start();
  const rejected=assert.rejects(pending,code('TIMEOUT'));
  timers.advance(250);await rejected;
  assert.equal(timers.pending.size,0);run.clean();
});
