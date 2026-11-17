import test from 'node:test';
import assert from 'node:assert/strict';
import {GuidedConnection, shouldProceed} from '../../locker-troubleshooting/guided-connection.js';

const validReply=()=>({status:'responded',board:'C',bits:'0000000011111111'});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

class FakeClock{
  time=0;
  sequence=0;
  timers=new Map();
  now=()=>this.time;
  setTimer=(callback,ms)=>{const id=++this.sequence;this.timers.set(id,{callback,at:this.time+Math.max(0,ms)});return id;};
  clearTimer=id=>this.timers.delete(id);
  async advance(ms){
    const end=this.time+ms;
    for(let runs=0;;runs++){
      assert.ok(runs<10000,'timer loop must make progress');
      const next=[...this.timers.entries()].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;
      const[id,timer]=next;this.time=timer.at;this.timers.delete(id);timer.callback();await flush();
    }
    this.time=end;await flush();
  }
}

function setup(t,{connected=false,probe=async()=>validReply(),...options}={}){
  const clock=new FakeClock(),calls=[],changes=[],events=[];
  let link=connected;
  const guide=new GuidedConnection({
    isConnected:()=>link,
    probe:()=>{calls.push(clock.time);return probe(calls.length);},
    onChange:s=>changes.push(structuredClone(s)),onEvent:e=>events.push(e),
    now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,
    connectionWaitMs:60000,stabilityMs:60000,pollMs:3000,...options,
  });
  t.after(()=>guide.stop());
  return{guide,clock,calls,changes,events,setConnected(value){link=value;guide.notifyConnection(value);}};
}

test('timer adapters do not bind strict injected functions to the guide instance',()=>{
  const timers=new Map();let sequence=0,cleared=0;
  function setTimer(callback,ms){
    assert.equal(this,undefined,'schedule must call the timer as a plain function');
    const id=sequence++;timers.set(id,{callback,ms});return id;
  }
  function clearTimer(id){
    assert.equal(this,undefined,'cancel must call the timer as a plain function');
    cleared++;timers.delete(id);
  }
  const guide=new GuidedConnection({
    isConnected:()=>false,probe:async()=>validReply(),now:()=>0,setTimer,clearTimer,
  });
  guide.start();
  assert.equal(timers.size,1);
  guide.retry();
  assert.equal(timers.size,1);
  guide.stop();
  assert.equal(timers.size,0);
  assert.equal(cleared,2);
});

test('waits up to 60 seconds for USB and prompts when the connection remains unavailable',async t=>{
  const{guide,clock,calls}=setup(t);
  assert.equal(guide.snapshot().phase,'stopped');
  assert.equal(shouldProceed(guide.snapshot()),false);
  guide.start();await flush();
  assert.equal(guide.snapshot().phase,'waiting');
  assert.equal(guide.snapshot().remainingSeconds,60);
  await clock.advance(59000);
  assert.equal(guide.snapshot().phase,'waiting');
  assert.equal(guide.snapshot().remainingSeconds,1);
  await clock.advance(1000);
  assert.equal(guide.snapshot().phase,'attention');
  assert.ok(guide.snapshot().reason);
  assert.equal(guide.snapshot().remainingSeconds,0);
  assert.equal(shouldProceed(guide.snapshot()),false);
  assert.deepEqual(calls,[]);
});

test('opening a port is not proof of a reply and a reply arriving after the waiting deadline is ignored',async t=>{
  const pending=deferred();
  const{guide,clock}=setup(t,{connected:true,probe:()=>pending.promise});
  guide.start();await flush();
  assert.equal(guide.snapshot().connected,true);
  assert.equal(guide.snapshot().phase,'waiting');
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(guide.snapshot().verifiedAt,null);
  await clock.advance(60000);
  assert.equal(guide.snapshot().phase,'attention');
  pending.resolve(validReply());await flush();
  assert.equal(guide.snapshot().phase,'attention');
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(shouldProceed(guide.snapshot()),false);
});

test('only a valid binary input-status reply addressed to master C starts the stability watch',async t=>{
  for(const reply of [
    {status:'responded',board:'A',bits:'0'.repeat(16)},
    {status:'responded',board:'C',bits:'0'.repeat(15)},
    {status:'responded',board:'C',bits:'000000000000000X'},
    {status:'responded',board:'C'},
    {status:'no-response',board:'C',bits:'0'.repeat(16)},
    null,
  ]){
    const{guide,clock}=setup(t,{connected:true,probe:async()=>reply});
    guide.start();await flush();
    assert.ok(['waiting','attention'].includes(guide.snapshot().phase),JSON.stringify(reply));
    assert.equal(guide.snapshot().goodReplyCount,0);
    assert.equal(guide.snapshot().verifiedAt,null);
    await clock.advance(60000);
    assert.equal(guide.snapshot().phase,'attention');
    assert.equal(shouldProceed(guide.snapshot()),false);
    guide.stop();
  }
});

test('the first valid C reply starts a full 60-second watch from the time of that reply',async t=>{
  const first=deferred();
  const{guide,clock}=setup(t,{connected:true,probe:n=>n===1?first.promise:Promise.resolve(validReply())});
  guide.start();await flush();
  await clock.advance(10000);
  first.resolve(validReply());await flush();
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(guide.snapshot().remainingSeconds,60);
  assert.equal(guide.snapshot().goodReplyCount,1);
  assert.equal(guide.snapshot().lastReplyAt,10000);
  assert.equal(shouldProceed(guide.snapshot()),false);
  await clock.advance(59000);
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(guide.snapshot().remainingSeconds,1);
  await clock.advance(1000);
  assert.equal(guide.snapshot().phase,'ready');
  assert.ok(guide.snapshot().verifiedAt>=70000);
  assert.equal(shouldProceed(guide.snapshot()),true);
});

test('the watch countdown reaching zero requires a new successful probe before showing ready',async t=>{
  const final=deferred();let clock;
  const run=setup(t,{connected:true,probe:()=>clock.time>=60000?final.promise:Promise.resolve(validReply())});
  clock=run.clock;const{guide,calls}=run;
  guide.start();await flush();
  await clock.advance(60000);
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(guide.snapshot().remainingSeconds,0);
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.equal(shouldProceed(guide.snapshot()),false);
  assert.ok(calls.at(-1)>=60000);
  final.resolve(validReply());await flush();
  assert.equal(guide.snapshot().phase,'ready');
  assert.equal(shouldProceed(guide.snapshot()),true);
});

test('a probe started before the watch deadline cannot serve as the fresh final verification',async t=>{
  const earlier=deferred(),final=deferred();let clock;
  const run=setup(t,{connected:true,probe:()=>clock.time>=60000?final.promise:clock.time>=57000?earlier.promise:Promise.resolve(validReply())});
  clock=run.clock;const{guide,calls}=run;
  guide.start();await flush();
  await clock.advance(61000);
  assert.equal(calls.at(-1),57000);
  assert.equal(guide.snapshot().phase,'watching');
  earlier.resolve(validReply());await flush();await clock.advance(3000);
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.ok(calls.at(-1)>=60000);
  final.resolve(validReply());await flush();
  assert.equal(guide.snapshot().phase,'ready');
});

test('slow probes never overlap while waiting or watching',async t=>{
  const first=deferred(),second=deferred();
  const{guide,clock,calls}=setup(t,{connected:true,probe:n=>n===1?first.promise:second.promise});
  guide.start();await flush();
  await clock.advance(20000);
  assert.deepEqual(calls,[0]);
  first.resolve(validReply());await flush();
  await clock.advance(20000);
  assert.equal(calls.length,2);
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(shouldProceed(guide.snapshot()),false);
});

test('a failed probe during the watch resets proof and requests attention',async t=>{
  const{guide,clock}=setup(t,{connected:true,probe:async n=>n===1?validReply():{status:'no-response',board:'C'}});
  guide.start();await flush();
  assert.equal(guide.snapshot().phase,'watching');
  await clock.advance(3000);
  assert.equal(guide.snapshot().phase,'attention');
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(shouldProceed(guide.snapshot()),false);
});

test('a thrown USB error during the watch cannot produce a green result',async t=>{
  const{guide,clock}=setup(t,{connected:true,probe:async n=>{
    if(n===1)return validReply();
    throw Object.assign(new Error('USB disconnected'),{code:'DISCONNECTED'});
  }});
  guide.start();await flush();
  await clock.advance(3000);
  assert.equal(guide.snapshot().phase,'attention');
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(shouldProceed(guide.snapshot()),false);
});

test('a physical disconnect resets the watch and reconnecting requires an explicit fresh retry',async t=>{
  const{guide,clock,setConnected}=setup(t,{connected:true});
  guide.start();await flush();await clock.advance(30000);
  setConnected(false);await flush();
  assert.equal(guide.snapshot().phase,'attention');
  assert.equal(guide.snapshot().connected,false);
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(guide.snapshot().verifiedAt,null);
  setConnected(true);await flush();
  assert.equal(guide.snapshot().phase,'attention');
  assert.equal(shouldProceed(guide.snapshot()),false);
  guide.retry();await flush();
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(guide.snapshot().remainingSeconds,60);
});

test('continued checks revoke ready if the master subsequently fails to reply',async t=>{
  let fail=false;
  const{guide,clock}=setup(t,{connected:true,probe:async()=>fail?{status:'no-response',board:'C'}:validReply()});
  guide.start();await flush();await clock.advance(60000);
  assert.equal(guide.snapshot().phase,'ready');
  fail=true;await clock.advance(3000);
  assert.equal(guide.snapshot().phase,'attention');
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(shouldProceed(guide.snapshot()),false);
});

test('retry ignores an old asynchronous reply and waits for the old transaction before probing again',async t=>{
  const old=deferred(),fresh=deferred();
  const{guide,clock,calls}=setup(t,{connected:true,probe:n=>n===1?old.promise:fresh.promise});
  guide.start();await flush();await clock.advance(10000);
  guide.retry();await flush();await clock.advance(10000);
  assert.equal(calls.length,1);
  assert.equal(guide.snapshot().phase,'waiting');
  old.resolve(validReply());await flush();await clock.advance(3000);
  assert.equal(calls.length,2);
  assert.equal(guide.snapshot().phase,'waiting');
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(guide.snapshot().verifiedAt,null);
  fresh.resolve(validReply());await flush();
  assert.equal(guide.snapshot().phase,'watching');
  assert.equal(guide.snapshot().goodReplyCount,1);
  assert.equal(guide.snapshot().remainingSeconds,60);
});

test('stop cancels timers and ignores pending replies and later connection notifications',async t=>{
  const pending=deferred();
  const{guide,clock,calls,setConnected}=setup(t,{connected:true,probe:()=>pending.promise});
  guide.start();await flush();
  guide.stop();
  assert.equal(guide.snapshot().phase,'stopped');
  assert.equal(clock.timers.size,0);
  pending.resolve(validReply());await flush();setConnected(false);setConnected(true);
  await clock.advance(120000);
  assert.equal(guide.snapshot().phase,'stopped');
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.equal(guide.snapshot().goodReplyCount,0);
  assert.equal(calls.length,1);
  assert.equal(clock.timers.size,0);
  assert.equal(shouldProceed(guide.snapshot()),false);
});

test('stopping synchronously after start prevents even the first deferred USB probe',async t=>{
  const{guide,clock,calls}=setup(t,{connected:true});
  guide.start();guide.stop();await flush();await clock.advance(60000);
  assert.deepEqual(calls,[]);
  assert.equal(guide.snapshot().phase,'stopped');
  assert.equal(guide.snapshot().verifiedAt,null);
  assert.equal(clock.timers.size,0);
});

test('proceeding requires ready, a connected port and completed verification',()=>{
  const ready={phase:'ready',connected:true,verifiedAt:60000};
  assert.equal(shouldProceed(ready),true);
  assert.equal(shouldProceed({...ready,phase:'watching'}),false);
  assert.equal(shouldProceed({...ready,connected:false}),false);
  assert.equal(shouldProceed({...ready,verifiedAt:null}),false);
  assert.equal(shouldProceed({phase:'waiting',connected:true}),false);
});
