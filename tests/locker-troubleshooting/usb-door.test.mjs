import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../locker-troubleshooting/usb-ui.js',import.meta.url),'utf8')
  .replace(/^import\s+[^\r\n]+;\s*$/gm,'').replace(/\bexport\s+(?=function|class|const)/g,'');
const boards=['A','B','C','D','E'];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const clone=value=>structuredClone(value);
const flush=async()=>{for(let i=0;i<64;i++)await Promise.resolve();};

class Clock{
  now=Date.parse('2026-11-18T12:00:00.000Z');id=0;timers=new Map();
  setTimeout=(callback,ms)=>{const id=this.id++;this.timers.set(id,{callback,at:this.now+ms});return id;};
  clearTimeout=id=>this.timers.delete(id);
  async advance(ms){
    const end=this.now+ms;
    for(let count=0;;count++){
      assert.ok(count<10000,'fake timers make progress');
      const next=[...this.timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;
      this.now=next[1].at;this.timers.delete(next[0]);next[1].callback();await flush();
    }
    this.now=end;await flush();
  }
}

class Element{
  constructor(document){this.document=document;this._html='';this.textContent='';this.value='';this.disabled=false;this.listeners=new Map();this.classList={toggle(){}};}
  set innerHTML(value){this._html=String(value);for(const match of this._html.matchAll(/\bid="([^"]+)"/g))if(!this.document.elements.has(match[1])){const element=new Element(this.document);if(match[1]==='usb-monitor-board')element.value='all';this.document.elements.set(match[1],element);}}
  get innerHTML(){return this._html;}
  querySelector(selector){return selector.startsWith('#')?this.document.elements.get(selector.slice(1))??null:null;}
  addEventListener(type,callback){this.listeners.set(type,callback);}
}

async function setup({query,pulse,cancelPulse,getBoards=()=>boards,getMaster=()=> 'C',requestPort,autoConnect=true}={}){
  const clock=new Clock(),listeners=new Map(),saved=[],instances=[];
  const document={hidden:false,elements:new Map(),addEventListener(type,callback){listeners.set(type,callback);}};
  const root=new Element(document),calls={queries:[],pulses:[],cancel:0,close:0,reset:0,resetTargets:[],open:0,ports:0};
  const at=()=>new Date(clock.now).toISOString();
  const reading=(board,bits='0000000000000000')=>({board,bits,raw:`<${board}>Ex(BIN):${bits.slice(0,8)}:${bits.slice(8)}~`,at:at(),elapsedMs:0});
  const evidence=(board='A',extra={})=>({board,openCommand:'LA0#'+board,offCommand:'LMX#'+board,openSent:true,offSent:true,offConfirmed:false,
    open:{status:'sent',at:at()},lockOff:{status:'sent',at:at()},samples:[{...reading(board,'0000000000000001'),status:'responded'}],...extra});
  class SerialTransport{
    constructor(port,options){this.port=port;this.options=options;this.masterBoard=options.masterBoard;this.connected=false;this.busy=false;this.activationBlocked=false;instances.push(this);}
    async open(){calls.open++;this.connected=true;this.options.onState({connected:true,busy:false});}
    async query(board){calls.queries.push(board);return query?query(board,calls.queries.length,reading):reading(board);}
    async pulseDoor(board,door,options){calls.pulses.push({board,door,options});return pulse?pulse(board,door,evidence):evidence(board,{door,openCommand:'LA'+(door-1).toString(16).toUpperCase()+'#'+board});}
    async cancelDoorPulse(){calls.cancel++;return cancelPulse?.(evidence);}
    async close(){calls.close++;this.connected=false;this.options.onState({connected:false,busy:false});}
    async resetMaster(){calls.reset++;calls.resetTargets.push(this.masterBoard);return{confirmed:false};}
  }
  class FakeDate extends Date{
    constructor(...args){super(...(args.length?args:[clock.now]));}
    static now(){return clock.now;}
  }
  const context=vm.createContext({SerialTransport,document,root,options:{getBoards,getMaster,onSave:value=>saved.push(clone(value))},
    navigator:{serial:{async requestPort(){calls.ports++;return requestPort?requestPort(calls.ports):{};},addEventListener(){}}},
    window:{isSecureContext:true},structuredClone,Date:FakeDate,
    setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    addEventListener(type,callback){listeners.set(type,callback);},
  });
  new vm.Script(source,{filename:'usb-ui.js'}).runInContext(context);
  const panel=vm.runInContext('mountUsbPanel(root,options)',context);
  if(autoConnect)await panel.connect();await flush();
  return{panel,calls,clock,document,saved,instances,reading,evidence,
    hide(){document.hidden=true;listeners.get('visibilitychange')?.();},
    pagehide(){listeners.get('pagehide')?.();},
    async finish(promise){await flush();await clock.advance(11000);return promise;},
  };
}

test('selected-column or master baseline failure prevents any opening pulse',async()=>{
  for(const fail of ['A','C']){
    const run=await setup({query:async(board,index,reading)=>{if(board===fail)throw Object.assign(Error('No baseline reply'),{code:'TIMEOUT'});return reading(board);}});
    const samples=[];
    await assert.rejects(run.panel.openDoorTest(fail==='A'?'A':'D',7,{onSample:(phase,result)=>samples.push({phase,result:clone(result)})}),error=>error.code==='BASELINE');
    assert.equal(run.calls.pulses.length,0);
    assert.equal(samples.at(-1).result.status,'no-response');
    assert.equal(samples.at(-1).result.board,fail);
    assert.equal(run.panel.busy,false);
  }
});

test('one explicit attempt pulses only the chosen bank and door and retains pulse-time samples',async()=>{
  const run=await setup(),samples=[],commands=[];
  const pending=run.panel.openDoorTest('D',11,{onSample:(phase,result)=>samples.push({phase,result:clone(result)}),onCommand:value=>commands.push(clone(value))});
  await run.finish(pending);
  assert.equal(run.calls.pulses.length,1);
  assert.equal(run.calls.pulses[0].board,'D');assert.equal(run.calls.pulses[0].door,11);
  assert.equal(run.calls.pulses[0].options.durationMs,500);
  assert.deepEqual(run.calls.queries.slice(0,6),['D','A','B','C','E','D']);
  assert.equal(commands.length,1);
  assert.ok(samples.some(sample=>sample.phase==='open'&&sample.result.board==='D'&&sample.result.bits==='0000000000000001'));
  assert.equal(samples.filter(sample=>sample.phase==='baseline').length,6);
  assert.deepEqual(run.calls.queries.slice(-4),['A','B','C','E']);
  assert.equal(run.panel.busy,false);
});

test('pulse failure still delivers its sensor evidence and command uncertainty without reopening',async()=>{
  const run=await setup({pulse:async(board,door,evidence)=>{throw Object.assign(Error('Lock-off write not confirmed'),{code:'WRITE',evidence:evidence(board,{lockOff:{status:'error',at:'2026-11-18T12:00:00.000Z',code:'WRITE',error:'Lock-off failed'}})});}});
  const samples=[],commands=[];
  await assert.rejects(run.panel.openDoorTest('B',3,{onSample:(phase,result)=>samples.push({phase,result:clone(result)}),onCommand:value=>commands.push(clone(value))}),/Lock-off write/);
  assert.equal(run.calls.pulses.length,1);assert.equal(run.calls.queries.length,6);
  assert.ok(samples.some(sample=>sample.phase==='open'&&sample.result.board==='B'&&sample.result.bits.endsWith('1')));
  assert.equal(commands.length,1);assert.equal(commands[0].code,'WRITE');
  assert.match(commands[0].error,/Lock-off write not confirmed/);
  await run.clock.advance(60000);assert.equal(run.calls.pulses.length,1);
});

test('the UI operation mutex blocks scan, reset, public reads and other attempts during a held pulse',async()=>{
  const held=deferred(),run=await setup({pulse:()=>held.promise});
  const pending=run.panel.openDoorTest('A',5);pending.catch(()=>{});await flush();
  assert.equal(run.calls.pulses.length,1);assert.equal(run.panel.busy,true);
  assert.equal(run.instances[0].busy,false,'the fake transport does not provide the mutex for this test');
  const reads=run.calls.queries.length;
  for(const operation of [()=>run.panel.scan(),()=>run.panel.reset(),()=>run.panel.check('E'),()=>run.panel.openDoorTest('E',2),()=>run.panel.readDoorTestInputs('B')]){
    await assert.rejects(operation(),/current|finish|wait|busy/i);
  }
  await run.panel.connect();assert.equal(run.calls.ports,1);
  assert.equal(run.calls.queries.length,reads);assert.equal(run.calls.reset,0);assert.equal(run.calls.pulses.length,1);
  held.resolve(run.evidence('A'));await run.finish(pending);
});

test('Stop and a hidden page cancel a held pulse and all remaining reads without automatic reopening',async()=>{
  for(const action of ['stop','hidden']){
    const held=deferred();let current;
    const run=await setup({pulse:()=>held.promise,cancelPulse:evidence=>{held.resolve(evidence('E',{cancelled:true}));}});
    current=run.panel.openDoorTest('E',16);const rejected=assert.rejects(current,error=>error.code==='CANCELLED');await flush();
    const before=run.calls.queries.length;
    if(action==='stop')run.panel.stopDoorTest();else run.hide();
    await rejected;await run.clock.advance(60000);
    assert.equal(run.calls.cancel,1);assert.equal(run.calls.pulses.length,1);
    assert.equal(run.calls.queries.length,before);assert.equal(run.panel.busy,false);
  }
});

test('hiding during the sensor watch prevents remaining cross-bank checks',async()=>{
  const run=await setup();
  const pending=run.panel.openDoorTest('C',8),rejected=assert.rejects(pending,error=>error.code==='CANCELLED');
  await flush();assert.equal(run.calls.pulses.length,1);
  const before=run.calls.queries.length;assert.ok(before>=7);
  run.hide();await run.clock.advance(1000);await rejected;
  assert.equal(run.calls.queries.length,before);
  assert.equal(run.calls.pulses.length,1);assert.equal(run.panel.busy,false);
});

test('closed-input capture reads each bank but never sends an opening pulse',async()=>{
  const run=await setup(),samples=[];
  await run.panel.readDoorTestInputs('B',{onSample:result=>samples.push(clone(result))});
  assert.deepEqual(run.calls.queries,['B','A','C','D','E']);
  assert.deepEqual(samples.map(sample=>sample.board),['B','A','C','D','E']);
  assert.equal(run.calls.pulses.length,0);assert.equal(run.calls.reset,0);assert.equal(run.panel.busy,false);
});

for(const[capacity,targets,chosen,master]of [['32',['A','B'],'A','B'],['64',['A','B','C','D'],'D','C']]){
  test(`${capacity}-bay USB checks, door attempts and closed snapshots use only the installed columns`,async()=>{
    const run=await setup({getBoards:()=>targets,getMaster:()=>master}),samples=[],commands=[];
    assert.equal(run.instances[0].options.masterBoard,master);
    await run.panel.reset();
    assert.deepEqual(run.calls.resetTargets,[master]);
    const select=run.document.elements.get('usb-monitor-board');
    assert.ok(select.innerHTML.includes('value="all"'));
    for(const bank of boards)assert.equal(select.innerHTML.includes(`value="${bank}"`),targets.includes(bank));

    await run.panel.check(chosen);
    const scan=run.panel.scan();await flush();await run.clock.advance(200*(targets.length+1));await scan;
    assert.deepEqual(run.calls.queries,[chosen,...targets]);

    const firstQuery=run.calls.queries.length;
    const pending=run.panel.openDoorTest(chosen,16,{
      onSample:(phase,result)=>samples.push({phase,result:clone(result)}),
      onCommand:value=>commands.push(clone(value)),
    });
    await run.finish(pending);
    assert.deepEqual(run.calls.queries.slice(firstQuery,firstQuery+targets.length+1),[chosen,...targets.filter(bank=>bank!==chosen),chosen]);
    assert.deepEqual(run.calls.queries.slice(-(targets.length-1)),targets.filter(bank=>bank!==chosen));
    assert.equal(samples.filter(sample=>sample.phase==='baseline').length,targets.length+1);
    assert.ok(samples.some(sample=>sample.phase==='open'&&sample.result.board===chosen&&sample.result.bits==='0000000000000001'),'pulse-time input evidence is retained');
    assert.ok(samples.every(sample=>targets.includes(sample.result.board)));
    assert.equal(run.calls.pulses.length,1);assert.equal(run.calls.pulses[0].board,chosen);assert.equal(run.calls.pulses[0].door,16);
    assert.equal(commands.length,1);assert.equal(commands[0].openCommand,'LAF#'+chosen);assert.equal(commands[0].offCommand,'LMX#'+chosen);
    assert.equal(commands[0].offConfirmed,false);

    const beforeClosed=run.calls.queries.length,closed=[];
    await run.panel.readDoorTestInputs(chosen,{onSample:value=>closed.push(clone(value))});
    assert.deepEqual(run.calls.queries.slice(beforeClosed),[chosen,...targets.filter(bank=>bank!==chosen)]);
    assert.deepEqual(closed.map(value=>value.board),[chosen,...targets.filter(bank=>bank!==chosen)]);
    assert.ok(run.calls.queries.every(bank=>targets.includes(bank)));
    assert.equal(run.calls.pulses.length,1,'closed observations do not open another door');
    assert.equal(run.panel.busy,false);
  });

  test(`${capacity}-bay scans and direct requests reject absent columns before any query or pulse`,async()=>{
    const run=await setup({getBoards:()=>targets,getMaster:()=>master});
    for(const absent of boards.filter(bank=>!targets.includes(bank))){
      for(const operation of [
        ()=>run.panel.check(absent),()=>run.panel.scan([absent]),()=>run.panel.scan([...targets,absent]),
        ()=>run.panel.openDoorTest(absent,1),()=>run.panel.readDoorTestInputs(absent),
      ])await assert.rejects(operation(),error=>error.code==='LAYOUT');
    }
    assert.deepEqual(run.calls.queries,[]);assert.deepEqual(run.calls.pulses,[]);
    assert.equal(run.calls.reset,0);assert.equal(run.calls.open,1);assert.equal(run.calls.ports,1);
    assert.equal(run.panel.busy,false);
  });

  test(`${capacity}-bay input monitoring offers and queries only installed columns`,async()=>{
    const run=await setup({getBoards:()=>targets,getMaster:()=>master}),select=run.document.elements.get('usb-monitor-board');
    assert.equal(select.value,'all');
    const monitoring=run.document.elements.get('usb-monitor').listeners.get('click')();await flush();
    await run.clock.advance(500*(targets.length-1));
    run.panel.stopMonitor();await run.clock.advance(500);await monitoring;
    assert.deepEqual(run.calls.queries,targets);
    assert.equal(run.calls.pulses.length,0);assert.equal(run.panel.monitoring,false);
    for(const bank of boards)assert.equal(select.innerHTML.includes(`value="${bank}"`),targets.includes(bank));
  });
}

test('changing the active layout during the sensor watch cancels remaining reads without another pulse',async()=>{
  let targets=['A','B','C','D'],master='C';
  const run=await setup({getBoards:()=>targets,getMaster:()=>master});
  const pending=run.panel.openDoorTest('B',4),rejected=assert.rejects(pending,error=>error.code==='CANCELLED');
  await flush();assert.equal(run.calls.pulses.length,1);assert.ok(run.calls.queries.length>=6);
  const before=run.calls.queries.length;
  targets=['A','B'];master='B';run.panel.refreshLayout();
  await run.clock.advance(11000);await rejected;
  assert.equal(run.calls.queries.length,before,'no further old-layout or cross-column reads run');
  assert.equal(run.calls.pulses.length,1);assert.equal(run.panel.busy,false);
  await run.clock.advance(60000);assert.equal(run.calls.pulses.length,1);
});

test('a stale E monitor selection refreshes to A,B after reconnecting to the new master B',async()=>{
  let targets=[...boards],master='C';
  const run=await setup({getBoards:()=>targets,getMaster:()=>master}),select=run.document.elements.get('usb-monitor-board');
  select.value='E';targets=['A','B'];master='B';run.panel.refreshLayout();
  assert.equal(select.value,'all');assert.ok(!select.innerHTML.includes('value="E"'));
  await run.panel.disconnect();await run.panel.connect();
  assert.equal(run.instances[1].masterBoard,'B');
  const monitoring=run.document.elements.get('usb-monitor').listeners.get('click')();await flush();
  await run.clock.advance(500);run.panel.stopMonitor();await run.clock.advance(500);await monitoring;
  assert.deepEqual(run.calls.queries,['A','B']);assert.equal(run.calls.pulses.length,0);
});

test('32-bay preflight requires master B and never queries C before opening A',async()=>{
  const run=await setup({getBoards:()=>['A','B'],getMaster:()=> 'B',query:async(board,index,reading)=>{
    if(board==='B')throw Object.assign(Error('Master B did not reply'),{code:'TIMEOUT'});
    return reading(board);
  }}),samples=[];
  await assert.rejects(run.panel.openDoorTest('A',7,{onSample:(phase,result)=>samples.push({phase,result:clone(result)})}),error=>error.code==='BASELINE'&&/Master B/.test(error.message));
  assert.deepEqual(run.calls.queries,['A','B']);
  assert.equal(run.calls.pulses.length,0);
  assert.equal(samples.at(-1).result.board,'B');assert.equal(samples.at(-1).result.status,'no-response');
  assert.equal(run.panel.busy,false);
});

for(const change of ['master','boards']){
  test(`a ${change} change invalidates the open USB connection until reconnect`,async()=>{
    let targets=[...boards],master='C';
    const run=await setup({getBoards:()=>targets,getMaster:()=>master});
    if(change==='master')master='B';else targets=['A','B','C','D'];
    run.panel.refreshLayout();
    for(const operation of [
      ()=>run.panel.check('A'),()=>run.panel.scan(),()=>run.panel.reset(),
      ()=>run.panel.openDoorTest('A',1),()=>run.panel.readDoorTestInputs('A'),
    ])await assert.rejects(operation(),error=>error.code==='LAYOUT');
    assert.deepEqual(run.calls.queries,[]);assert.deepEqual(run.calls.pulses,[]);assert.equal(run.calls.reset,0);
    assert.equal(run.panel.busy,false);
    await run.panel.disconnect();await run.panel.connect();
    await run.panel.check('A');await run.panel.reset();
    assert.deepEqual(run.calls.queries,['A']);assert.deepEqual(run.calls.resetTargets,[master]);
    const pending=run.panel.openDoorTest('A',1);await run.finish(pending);
    assert.equal(run.calls.pulses.length,1,'a deliberate attempt works after reconnecting with the new configuration');
    assert.ok(run.calls.queries.every(bank=>targets.includes(bank)));
  });
}

for(const change of ['master','boards']){
  test(`a ${change} change during port selection prevents opening the stale USB configuration`,async()=>{
    let targets=[...boards],master='C';const port=deferred();
    const run=await setup({getBoards:()=>targets,getMaster:()=>master,requestPort:()=>port.promise,autoConnect:false});
    const pending=run.panel.connect();await flush();
    assert.equal(run.calls.ports,1);assert.equal(run.calls.open,0);
    if(change==='master')master='B';else targets=['A','B','C','D'];
    run.panel.refreshLayout();port.resolve({});await pending;
    assert.equal(run.calls.open,0);assert.equal(run.instances.length,0);
    assert.equal(run.panel.connected,false);assert.equal(run.panel.busy,false);
    assert.deepEqual(run.calls.queries,[]);assert.deepEqual(run.calls.pulses,[]);assert.equal(run.calls.reset,0);
  });
}

test('an unconfirmed empty layout cannot open a port, query, reset or actuate hardware',async()=>{
  const run=await setup({getBoards:()=>[]});
  await run.panel.connect();
  for(const operation of [
    ()=>run.panel.scan(),()=>run.panel.scan(['C']),()=>run.panel.reset(),()=>run.panel.check('C'),
    ()=>run.panel.openDoorTest('C',1),()=>run.panel.readDoorTestInputs('C'),
  ])await assert.rejects(operation());
  await run.document.elements.get('usb-monitor').listeners.get('click')();
  assert.equal(run.calls.ports,0);assert.equal(run.calls.open,0);assert.equal(run.calls.reset,0);
  assert.deepEqual(run.calls.queries,[]);assert.deepEqual(run.calls.pulses,[]);
  for(const id of ['usb-connect','usb-scan','usb-monitor'])assert.equal(run.document.elements.get(id).disabled,true);
  assert.equal(run.document.elements.get('usb-monitor-board').innerHTML,'<option value="all">All installed boards</option>');
});
