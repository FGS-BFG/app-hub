import test from 'node:test';
test('live windows distinguish sensor-open red from the selected active release and clear green after lock-off',async()=>{
 const app=boot(new MemoryStorage(),{usbConnected:true,holdDoorOpen:true});
 app.enterDoorStep('32');app.selectData('data-door-setup','original');app.selectData('data-door-number','3');app.check('door-ready');
 app.click('door-open');
 let windows=app.document.querySelectorAll('.locker-door-window');
 assert.equal(windows[0].classList.contains('open'),true,'input 1 open is red');
 assert.equal(windows[4].classList.contains('released'),true,'selected door 3 is green during release');
 assert.equal(app.document.querySelector('[data-door-number="3"]').disabled,true);
 app.releaseDoor();await app.settle();
 windows=app.document.querySelectorAll('.locker-door-window');
 assert.equal(windows[4].classList.contains('released'),false,'lock-off removes green');
 assert.equal(windows[0].classList.contains('open'),true,'red follows sensor until a new reading');
 assert.equal(app.calls.doorOpen,1);
});
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as flow from '../../locker-troubleshooting/flow.js';
import * as records from '../../locker-troubleshooting/report-record.js';
import * as driveHelpers from '../../locker-troubleshooting/drive-reports.js';
import * as storageHelpers from '../../locker-troubleshooting/test-storage.js';
import * as doorTests from '../../locker-troubleshooting/door-test.js';
import * as layouts from '../../locker-troubleshooting/layouts.js';
import * as boardDetection from '../../locker-troubleshooting/board-detection.js';
import {createDoorGuide} from '../../locker-troubleshooting/door-ui.js';

const appUrl=new URL('../../locker-troubleshooting/app.js',import.meta.url);
const html=fs.readFileSync(new URL('../../locker-troubleshooting/index.html',import.meta.url),'utf8');
// Execute the actual entry point without an experimental VM module loader.
// Its production imports are provided below; no startup logic is replaced.
const appSource=fs.readFileSync(appUrl,'utf8').replace(/^import\s+[^\r\n]+;\s*$/gm,'');
let nextUuid=0;
const uuid=()=>`f0000000-0000-4000-8000-${String(++nextUuid).padStart(12,'0')}`;
const clone=value=>JSON.parse(JSON.stringify(value));

class MemoryStorage{
  constructor(entries=[]){this.values=new Map(entries);this.mutations=[];}
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(String(key))??null;}
  setItem(key,value){key=String(key);value=String(value);this.mutations.push({type:'set',key,value});if(this.failWrite?.(key,value))throw Object.assign(Error('Storage quota exceeded'),{name:'QuotaExceededError'});this.values.set(key,value);}
  removeItem(key){key=String(key);this.mutations.push({type:'remove',key});this.values.delete(key);}
}

class FakeElement{
  constructor(document,tag,attributes={},owner=null){
    this.document=document;this.tagName=tag.toUpperCase();this.attributes={...attributes};this.owner=owner;
    this.id=attributes.id||'';this.dataset={};this.listeners=new Map();this._html='';this.textContent='';
    this.value=attributes.value||'';this.disabled=Object.hasOwn(attributes,'disabled');this.hidden=Object.hasOwn(attributes,'hidden');this.open=false;
    this.name=attributes.name||'';this.type=attributes.type||'';this.checked=Object.hasOwn(attributes,'checked');this.readOnly=Object.hasOwn(attributes,'readonly');
    for(const[key,value]of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    const classes=new Set((attributes.class||'').split(/\s+/).filter(Boolean));
    this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name,force){if(force??!classes.has(name)){classes.add(name);return true;}classes.delete(name);return false;}};
  }
  get innerHTML(){return this._html;}
  set innerHTML(value){this.document.removeOwned(this);this._html=String(value);this.document.parse(this._html,this);}
  insertAdjacentHTML(position,value){this._html=position==='afterbegin'?String(value)+this._html:this._html+String(value);this.document.parse(String(value),this);}
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener);}
  dispatch(type,event={}){for(const listener of [...(this.listeners.get(type)||[])])listener({type,target:this,...event});}
  click(){if(!this.disabled)this.dispatch('click');}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  toggleAttribute(name,force){if(force??!Object.hasOwn(this.attributes,name)){this.attributes[name]='';if(name==='disabled')this.disabled=true;return true;}delete this.attributes[name];if(name==='disabled')this.disabled=false;return false;}
  focus(){}
  scrollIntoView(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  closest(selector){return this.document.matches(this,selector)?this:null;}
  querySelectorAll(selector){return this.document.querySelectorAll(selector).filter(element=>{for(let owner=element.owner;owner;owner=owner.owner)if(owner===this)return true;return false;});}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
}

class FakeDocument{
  constructor(markup){this.elements=[];this.parse(markup,null);}
  parse(markup,owner){
    for(const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
      const attributes={};
      for(const attribute of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attributes[attribute[1]]=attribute[2]??attribute[3]??attribute[4]??'';
      const element=new FakeElement(this,match[1],attributes,owner);
      if(element.tagName==='TEXTAREA')element.value=markup.slice(match.index+match[0].length).split(/<\/textarea\s*>/i)[0]
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
      this.elements.push(element);
    }
  }
  removeOwned(owner){this.elements=this.elements.filter(element=>{for(let parent=element.owner;parent;parent=parent.owner)if(parent===owner)return false;return true;});}
  matches(element,selector){
    if(selector.includes(','))return selector.split(',').some(part=>this.matches(element,part.trim()));
    if(selector.includes(':checked')&&!element.checked)return false;
    if(selector.includes(':disabled')&&!element.disabled)return false;
    selector=selector.replace(/:(checked|disabled)\b/g,'');
    if(selector.startsWith('#'))return element.id===selector.slice(1);
    if(selector.startsWith('.'))return element.classList.contains(selector.slice(1));
    const tag=selector.match(/^[a-z][\w-]*/i)?.[0];
    if(tag&&element.tagName.toLowerCase()!==tag.toLowerCase())return false;
    const attributes=[...selector.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)];
    if(attributes.length)return attributes.every(attribute=>Object.hasOwn(element.attributes,attribute[1])&&
      (attribute[2]===undefined&&attribute[3]===undefined&&attribute[4]===undefined||element.getAttribute(attribute[1])===(attribute[2]??attribute[3]??attribute[4])));
    return !!tag;
  }
  querySelector(selector){return this.elements.find(element=>this.matches(element,selector))??null;}
  querySelectorAll(selector){return this.elements.filter(element=>this.matches(element,selector));}
  addEventListener(){}
  createElement(tag){return new FakeElement(this,tag);}
}

function boot(storage=new MemoryStorage(),{usbConnected=false,driveFailure='Unexpected automatic Drive save.',holdDoorOpen=false,doorFailure='',doorPreflightFailure='',doorOffFailure=false}={}){
  const document=new FakeDocument(html),microtasks=[],timers=new Map(),windowListeners=new Map();
  const calls={uuid:0,usbCheck:0,usbScan:0,usbReset:0,usbConnect:0,usbDiscover:0,usbStopDiscovery:0,usbAdopt:0,doorOpen:0,doorRead:0,guidedStart:0,driveSave:0,library:0,reloads:0};
  const drivePayloads=[],doorTargets=[],scanTargets=[],queryTargets=[],resetTargets=[],adoptedBoards=[];
  let timerId=0,releaseDoor,mockUsb,appNow=Date.now();
  const usbData={boards:{},lastBits:{},events:[],checks:[],observations:[],connected:usbConnected};
  const window={
    addEventListener(type,listener){if(!windowListeners.has(type))windowListeners.set(type,[]);windowListeners.get(type).push(listener);},
    location:{reload(){calls.reloads++;}},
  };
  const fire=(type,event={})=>{for(const listener of [...(windowListeners.get(type)||[])])listener({type,...event});};
  class GuidedConnection{
    constructor(options){this.options=options;this.current={phase:'stopped',remainingSeconds:60};}
    snapshot(){return clone(this.current);}
    start(){calls.guidedStart++;const master=this.options.getMaster?.()||'C';this.current={phase:'waiting',remainingSeconds:60,masterBoard:master,connected:mockUsb.connected,verifiedAt:null,discoveredBoards:[],discoveryResults:[],discoveryAt:'',discoveryRunning:false};this.options.probe(master);}
    retry(){this.start();}
    stop(){}
    notifyConnection(){}
  }
  class DriveReportClient{
    async save(payload){calls.driveSave++;drivePayloads.push(clone(payload));throw Error(driveFailure);}
    openLibrary(){calls.library++;}
  }
  function mountUsbPanel(root,{onSave,onConnection=()=>{},getBoards=()=>flow.BOARDS,getMaster=()=> 'C'}){
    let singleBoardTarget=null,lastDiscoveryResults=[];
    const scopedBoards=()=>singleBoardTarget?[singleBoardTarget]:getBoards();
    const requireTarget=board=>assert.ok(scopedBoards().includes(board),'USB request remains within the explicitly selected controller scope');
    const usb={connected:usbConnected,supported:true,busy:false,monitoring:false,
      get singleBoardTarget(){return singleBoardTarget;},
      snapshot:()=>clone(usbData),setControlsEnabled(){},stopMonitor(){},clear(){singleBoardTarget=null;lastDiscoveryResults=[];},showError(){},
      async disconnect(){usb.connected=false;usbData.connected=false;onConnection({connected:false});},
      async check(board=getMaster()){requireTarget(board);queryTargets.push(board);calls.usbCheck++;return{board,status:'responded',bits:'0'.repeat(16)};},
      async scan(boards=scopedBoards(),onResult=()=>{}){calls.usbScan++;scanTargets.push([...boards]);for(const board of boards){requireTarget(board);await onResult({board,status:'responded',bits:'0'.repeat(16),at:'2026-11-18T12:00:00.000Z'});}},
      async reset(){if(singleBoardTarget)throw Object.assign(Error('Master reset is unavailable in a single-board check.'),{code:'SCOPE'});calls.usbReset++;resetTargets.push(getMaster());},async connect(){calls.usbConnect++;},refreshLayout(){},
      async discoverBoards(){calls.usbDiscover++;return clone(lastDiscoveryResults);},
      async stopDiscovery(){calls.usbStopDiscovery++;return clone(lastDiscoveryResults);},
      adoptSingleBoard(board){
        assert.ok(usb.connected,'only a connected port can adopt a detected board');
        assert.ok(lastDiscoveryResults.some(result=>result.board===board&&result.status==='responded'&&/^[01]{16}$/.test(result.bits)), 'adoption needs a valid reply from this discovered address');
        assert.ok(!singleBoardTarget||singleBoardTarget===board,'an adopted target cannot silently change');
        calls.usbAdopt++;adoptedBoards.push(board);singleBoardTarget=board;return board;
      },
      setDiscoveryResults(results){lastDiscoveryResults=clone(results);},
      stopDoorTest(){},
      async openDoorTest(board,door,{onPhase,onSample,onCommand,onLockState=()=>{}}){
        calls.doorOpen++;doorTargets.push({board,door});
        const sample=(value,bits)=>({board:value,status:'responded',bits,at:'2026-11-18T12:00:00.000Z',elapsedMs:5});
        requireTarget(board);for(const value of scopedBoards())onSample('baseline',sample(value,'0'.repeat(16)));
        if(doorPreflightFailure)throw Object.assign(Error(doorPreflightFailure),{code:'BASELINE'});
        onCommand({openAttempted:true,openSent:!doorFailure,offSent:true,offAttempted:true,openAt:'2026-11-18T12:00:00.100Z',offAt:'2026-11-18T12:00:00.600Z',code:doorOffFailure?'LOCK_OFF':'',error:doorOffFailure?'Controller rejected the lock-off command.':''});
        onLockState('released');onPhase('Watching the selected column…');
        onSample('open',sample(board,'0'.repeat(14)+'11'));
        if(holdDoorOpen)await new Promise(resolve=>{releaseDoor=resolve;});
        onLockState('off');
        if(doorFailure||doorOffFailure)throw Error(doorFailure||'Controller rejected the lock-off command.');
      },
      async readDoorTestInputs(board,{onSample}){requireTarget(board);calls.doorRead++;for(const value of scopedBoards())onSample({board:value,status:'responded',bits:'0'.repeat(16),at:'2026-11-18T12:00:01.000Z',elapsedMs:5});},
    };
    mockUsb=usb;onSave(clone(usbData));return usb;
  }
  class AppDate extends Date{constructor(...args){super(...(args.length?args:[appNow]));}static now(){return appNow;}}
  const setTimer=callback=>{const id=timerId++;timers.set(id,callback);return id;};
  const context=vm.createContext({...flow,...records,...driveHelpers,...storageHelpers,...doorTests,...layouts,...boardDetection,
    // Production ESM modules share a realm. Normalize the VM/host boundary here
    // so its plain step-log objects reach the real validator as plain objects.
    createReportRecord:(session,options)=>records.createReportRecord(structuredClone(session),options),
    DriveReportClient,GuidedConnection,mountUsbPanel,createDoorGuide,shouldProceed:(snapshot,master)=>snapshot.phase==='ready'&&snapshot.masterBoard===master,
    FIELD_REPORTS:{endpoint:'https://script.google.com/macros/s/TEST/exec'},
    document,window,localStorage:storage,crypto:{randomUUID(){calls.uuid++;return uuid();}},
    navigator:{clipboard:{writeText:async()=>{}}},structuredClone,Date:AppDate,
    queueMicrotask:callback=>microtasks.push(callback),setTimeout:setTimer,setInterval:setTimer,
    clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),console,
  });
  function flush(){for(let runs=0;microtasks.length;runs++){assert.ok(runs<100,'boot microtasks must settle');microtasks.shift()();}}
  new vm.Script(appSource,{filename:appUrl.pathname}).runInContext(context);flush();
  const state=()=>JSON.parse(vm.runInContext('JSON.stringify({id:s.reportId,step:s.step,details:s.details,beforeRestart:s.beforeRestart,boardDetection:s.boardDetection,initial:s.initial,recheck:s.recheck,doorTests:s.doorTests,history:s.history,log:s.log,mode:reportMode,pending:pendingRecord,saved:savedRecord,recovery:recoveryContext})',context));
  const earlierPageFixture="s.beforeRestart={communication:'unsure',unresponsiveBoards:[],notes:'Fixture begins after the earlier observation page.',recordedAt:s.started};";
  return{storage,document,calls,state,fire,flush,drivePayloads,doorTargets,scanTargets,queryTargets,resetTargets,adoptedBoards,
    enterBeforeRestart(capacity='80',setup='flat-input-sense',{connected=false}={}){this.chooseCapacity(capacity);this.click('next');this.chooseConfiguration(setup);if(connected){mockUsb.connected=true;usbData.connected=true;}this.click('next');assert.equal(state().step,'before-restart');},
    enterDoorStep(capacity='80'){context.fixtureCapacity=capacity;vm.runInContext(earlierPageFixture+"s.details.lockerCapacity=fixtureCapacity;s.doorTests=freshDoorTests(boardsFor(s),masterFor(s));go('doors','Test fixture completed communication checks')",context);flush();},
    enterInitialCheck(capacity='80'){context.fixtureCapacity=capacity;vm.runInContext(earlierPageFixture+"s.details.lockerCapacity=fixtureCapacity;s.doorTests=freshDoorTests(boardsFor(s),masterFor(s));go('initial','Test fixture completed connection check')",context);flush();},
    enterConnection(capacity='32'){context.fixtureCapacity=capacity;vm.runInContext(earlierPageFixture+"s.details.lockerCapacity=fixtureCapacity;s.doorTests=freshDoorTests(boardsFor(s),masterFor(s));go('connect','Test fixture completed power cycle')",context);flush();},
    enterSelfTest(capacity='80',setup='flat-input-sense'){context.fixtureCapacity=capacity;context.fixtureSetup=setup;vm.runInContext(earlierPageFixture+"s.details.lockerCapacity=fixtureCapacity;s.details.boardConfiguration=fixtureSetup;s.doorTests=freshDoorTests(boardsFor(s),masterFor(s));go('selftest','Test fixture requested physical self-test')",context);flush();},
    timerCount(){return timers.size;},
    advanceAppTime(ms){appNow+=ms;},
    finding:()=>JSON.parse(vm.runInContext('JSON.stringify(outcome(s))',context)),
    readyConnection(master){context.fixtureMaster=master;vm.runInContext("connection.current={phase:'ready',masterBoard:fixtureMaster,connected:true,verifiedAt:1};render()",context);flush();},
    foundBoards(results,{master='C',at}={}){
      mockUsb.setDiscoveryResults(results);context.fixtureDiscovery=clone(results);context.fixtureMaster=master;context.fixtureDiscoveryAt=at||new Date(appNow).toISOString();
      vm.runInContext("connection.current={phase:'attention',reason:'different-board',masterBoard:fixtureMaster,connected:usb.connected,verifiedAt:null,goodReplyCount:0,remainingSeconds:0,discoveredBoards:fixtureDiscovery.filter(result=>result.status==='responded'&&/^[A-E]$/.test(result.board)&&/^[01]{16}$/.test(result.bits)).map(result=>result.board),discoveryResults:fixtureDiscovery,discoveryAt:fixtureDiscoveryAt,discoveryRunning:false};guidedChanged()",context);flush();
    },
    async disconnectUsb(){await mockUsb.disconnect();flush();},
    releaseDoor(){releaseDoor?.();},
    change(id,value){const element=document.querySelector('#'+id);assert.ok(element,'actual UI input exists: '+id);element.value=value;element.dispatch('change');flush();},
    type(id,value){const element=document.querySelector('#'+id);assert.ok(element,'actual UI field exists: '+id);element.value=value;element.dispatch('input');flush();},
    check(id,value=true){const element=document.querySelector('#'+id);assert.ok(element,'actual UI checkbox exists: '+id);element.checked=value;element.dispatch('change');flush();},
    selectData(attribute,value){const element=document.querySelectorAll('['+attribute+']').find(item=>item.getAttribute(attribute)===value);assert.ok(element,'actual UI choice exists: '+attribute+' '+value);element.click();flush();},
    beforeCommunication(value){const options=document.querySelectorAll('[name="pre-restart-communication"]'),element=options.find(item=>item.value===value);assert.ok(element,'pre-restart answer exists: '+value);for(const item of options)item.checked=item===element;element.dispatch('change');flush();},
    beforeBoard(board,checked=true){const element=document.querySelectorAll('[name="pre-restart-board"]').find(item=>item.value===board);assert.ok(element,'pre-restart column exists: '+board);element.checked=checked;element.dispatch('change');flush();},
    async settle(){for(let i=0;i<8;i++){await Promise.resolve();flush();}},
    recoveries:()=>JSON.parse(vm.runInContext('JSON.stringify(recoveryEntries.map(item=>({id:item.id,kind:item.kind})))',context)),
    async openRecovery(id){
      const index=JSON.parse(vm.runInContext('JSON.stringify(recoveryEntries.map(item=>item.id))',context)).indexOf(id);
      assert.ok(index>=0,'requested archive appears in the actual recovery list');
      const button=document.querySelectorAll('[data-recovery]').find(element=>element.dataset.recovery===String(index));
      assert.ok(button);document.querySelector('#recovery-list').dispatch('click',{target:button});
      for(let i=0;i<8;i++){await Promise.resolve();flush();}
    },
    input(field,value){const element=document.querySelectorAll('[data-detail]').find(x=>x.dataset.detail===field);assert.ok(element,'actual welcome input exists: '+field);element.value=value;element.dispatch('input');flush();},
    chooseConfiguration(value){const element=document.querySelectorAll('[data-board-configuration]').find(x=>x.dataset.boardConfiguration===value);assert.ok(element,'actual board configuration option exists: '+value);element.click();flush();},
    chooseCapacity(value){const element=document.querySelectorAll('[data-locker-capacity]').find(x=>x.dataset.lockerCapacity===value);assert.ok(element,'actual capacity option exists: '+value);element.click();flush();},
    click(id){const element=document.querySelector('#'+id);assert.ok(element,'actual UI control exists: '+id);element.click();flush();},
  };
}

function noAutomaticIO(app){
  for(const key of ['usbCheck','usbScan','usbReset','usbConnect','usbDiscover','usbAdopt','doorOpen','doorRead','guidedStart','driveSave','library'])assert.equal(app.calls[key],0,key);
}

function discoveryResults(...responders){
  return flow.BOARDS.map(board=>responders.includes(board)
    ?{board,status:'responded',bits:'0000000011111111',raw:`<${board}>Ex(BIN):00000000:11111111~`,at:'2026-11-18T12:00:00.000Z',elapsedMs:10,stage:'discovery'}
    :{board,status:'no-response',code:'TIMEOUT',error:'No valid reply before the timeout.',at:'2026-11-18T12:00:00.000Z',elapsedMs:1500,stage:'discovery'});
}

function freshWelcome(app,oldIds=[]){
  const state=app.state();
  assert.equal(state.step,'welcome');assert.equal(state.mode,'live');
  assert.deepEqual(state.details,{location:'',technician:'',notes:'',lockerCapacity:'',boardConfiguration:'',masterBoardLabel:'',slaveBoardLabels:'',configurationNotes:''});
  assert.equal(app.document.querySelector('#next').disabled,true,'a fresh test requires a capacity choice');
  assert.deepEqual(state.initial,{});assert.deepEqual(state.recheck,{});
  assert.deepEqual(state.beforeRestart,{communication:'',unresponsiveBoards:[],notes:'',recordedAt:''});
  assert.deepEqual(state.boardDetection,{attempts:[],selection:null,checks:[]});
  assert.deepEqual(state.history,[]);assert.deepEqual(state.log,[]);
  assert.equal(state.pending,null);assert.equal(state.saved,null);assert.equal(state.recovery,null);
  assert.match(state.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(oldIds.includes(state.id),false);assert.equal(app.calls.uuid,1);
  assert.match(app.document.querySelector('#step').innerHTML,/Let’s check the lockers/);
  assert.doesNotMatch(app.document.querySelector('#step').innerHTML,/Saved to Google Drive|This report is waiting to be saved/);
  assert.equal(app.document.querySelector('#recovery-dialog').open,false);
  noAutomaticIO(app);
}

function archivedFixtures(step='initial'){
  const legacy=storageHelpers.STORAGE_PREFIX;
  const draft={...flow.freshSession(),reportId:uuid(),step,mode:'usb',connection:'connected',
    details:{...flow.freshSession().details,location:'Previous site',technician:'Previous operator',notes:'Original notes'},
    initial:{A:'responded'},usb:{connected:true,events:[{type:'tx',raw:'ISB#A\r'}]},
  };
  const pendingSession={...flow.freshSession(),details:{...flow.freshSession().details,location:'Frozen site',technician:'Archived operator',notes:'Frozen observations'}};
  const pending=records.createReportRecord(pendingSession,{id:uuid(),savedAt:'2026-11-18T08:00:00.000Z'});
  const saved=records.createReportRecord(pendingSession,{id:uuid(),savedAt:'2026-11-18T08:01:00.000Z'});
  const receipt={fileId:'test_saved_file_123456789',url:'https://drive.google.com/file/d/test_saved_file_123456789/view',reportId:saved.id};
  const raw=value=>' \n'+JSON.stringify(value,null,2)+'\n ';
  const entries=[
    [legacy,raw(draft)],[legacy+'-pending-report',raw(pending)],[legacy+'-saved-report',raw({record:saved,receipt})],
    [storageHelpers.draftKey(draft.reportId),raw(draft)],
    [storageHelpers.pendingKey(pending.id),raw(pending)],
    [storageHelpers.savedKey(saved.id),raw({schema:1,receipt})],
    ['unrelated-browser-record','  keep exact bytes  '],
  ];
  return{entries,ids:[draft.reportId,pending.id,saved.id]};
}

test('each ordinary app load starts a blank welcome test with a new UUID',()=>{
  const storage=new MemoryStorage(),one=boot(storage),two=boot(storage);
  freshWelcome(one);freshWelcome(two);
  assert.notEqual(one.state().id,two.state().id);
});

test('legacy live, frozen and saved records never choose the startup screen or replay locker commands',()=>{
  for(const oldStep of ['connect','reset','initial','doors','result']){
    const fixture=archivedFixtures(oldStep),storage=new MemoryStorage(fixture.entries);
    const app=boot(storage,{usbConnected:true});
    freshWelcome(app,fixture.ids);
    for(const[key,raw]of fixture.entries)assert.equal(storage.getItem(key),raw,'old raw record retained: '+key);
    assert.equal(storage.mutations.some(x=>fixture.entries.some(([key])=>key===x.key)),false,'startup never rewrites or deletes archived keys');
  }
});

test('reload creates a fresh test while preserving the previous per-ID draft unchanged',()=>{
  const storage=new MemoryStorage(),previous=boot(storage);
  previous.input('location','Test before reload');previous.input('technician','Operator before reload');
  previous.chooseCapacity('80');previous.click('next');assert.equal(previous.state().step,'identify');
  const previousId=previous.state().id,key=storageHelpers.draftKey(previousId),raw=storage.getItem(key);
  assert.ok(raw);
  const reopened=boot(storage);
  freshWelcome(reopened,[previousId]);
  assert.equal(storage.getItem(key),raw);
  assert.equal(reopened.document.querySelector('#recover-reports').disabled,false);
});

test('two app contexts sharing localStorage autosave separate drafts without replacing either test',()=>{
  const fixture=archivedFixtures(),storage=new MemoryStorage(fixture.entries);
  const one=boot(storage);one.input('location','First open test');
  const oneKey=storageHelpers.draftKey(one.state().id),oneRaw=storage.getItem(oneKey);
  const two=boot(storage);freshWelcome(two,[one.state().id,...fixture.ids]);
  assert.equal(storage.getItem(oneKey),oneRaw);
  two.input('location','Second open test');two.input('technician','Second operator');
  const twoKey=storageHelpers.draftKey(two.state().id),twoRaw=storage.getItem(twoKey);
  one.input('technician','First operator');
  assert.equal(storage.getItem(twoKey),twoRaw);
  assert.equal(JSON.parse(storage.getItem(oneKey)).details.location,'First open test');
  assert.equal(JSON.parse(storage.getItem(oneKey)).details.technician,'First operator');
  assert.equal(JSON.parse(twoRaw).details.location,'Second open test');
  assert.notEqual(oneKey,twoKey);
  for(const[key,raw]of fixture.entries)assert.equal(storage.getItem(key),raw);
  noAutomaticIO(one);noAutomaticIO(two);
});

test('returning focus from a popup preserves the in-progress test and does not reload',()=>{
  const app=boot();app.input('location','Test remains open');app.chooseCapacity('80');app.click('next');
  const before=app.state(),stored=[...app.storage.values];
  app.fire('blur');app.fire('focus');app.fire('focus');app.flush();
  assert.deepEqual(app.state(),before);assert.deepEqual([...app.storage.values],stored);
  assert.equal(app.calls.reloads,0);assert.equal(app.calls.uuid,1);noAutomaticIO(app);
});

test('only a persisted pageshow requests reload; the replacement opening starts a fresh test',()=>{
  const app=boot();app.input('location','Before back-forward restoration');app.chooseCapacity('80');app.click('next');
  const before=app.state(),key=storageHelpers.draftKey(before.id),raw=app.storage.getItem(key);
  app.fire('pageshow',{persisted:false});app.fire('focus');app.flush();
  assert.deepEqual(app.state(),before);assert.equal(app.calls.reloads,0);
  app.fire('pageshow',{persisted:true});app.flush();
  assert.equal(app.calls.reloads,1);assert.deepEqual(app.state(),before);
  assert.equal(app.storage.getItem(key),raw);noAutomaticIO(app);
  const replacement=boot(app.storage);freshWelcome(replacement,[before.id]);
  assert.equal(app.storage.getItem(key),raw);
});

test('recovery never lists the underlying current test or the archive already being viewed',async()=>{
  const fixture=archivedFixtures(),storage=new MemoryStorage(fixture.entries),app=boot(storage);
  app.input('location','Underlying current test');
  const currentId=app.state().id,archivedId=fixture.ids[1];
  app.click('recover-reports');
  assert.equal(app.recoveries().some(item=>item.id===currentId),false);
  await app.openRecovery(archivedId);
  assert.equal(app.state().mode,'pending');
  assert.equal(app.state().pending.id,archivedId);
  assert.equal(app.state().id,currentId);
  app.click('recover-reports');
  const offered=app.recoveries().map(item=>item.id);
  assert.equal(offered.includes(currentId),false);
  assert.equal(offered.includes(archivedId),false);
  assert.equal(offered.includes(fixture.ids[0]),true,'other unfinished tests remain available');
  assert.doesNotMatch(app.document.querySelector('#recovery-list').innerHTML,/Underlying current test/);
  for(const[key,raw]of fixture.entries)assert.equal(storage.getItem(key),raw);
  noAutomaticIO(app);
});

test('a frozen recovery retry survives Back in RAM when pending storage and Drive saving both fail',async()=>{
  const fixture=archivedFixtures(),storage=new MemoryStorage(fixture.entries);
  const app=boot(storage,{driveFailure:'Simulated Drive rejection'});
  app.input('location','Underlying live test');
  const currentId=app.state().id,recoveredId=fixture.ids[0],key=storageHelpers.pendingKey(recoveredId);
  app.click('recover-reports');await app.openRecovery(recoveredId);
  const frozen=app.state().pending;
  assert.equal(frozen.id,recoveredId);assert.equal(storage.getItem(key),null);
  storage.failWrite=writeKey=>writeKey===key;
  app.click('retry-save');await app.settle();
  assert.equal(app.calls.driveSave,1);
  assert.equal(app.state().mode,'pending');
  assert.equal(storage.getItem(key),null,'there is no persistent pending record to recover');
  assert.deepEqual(app.drivePayloads[0],records.payloadForDrive(frozen));
  app.click('close-recovered');
  assert.equal(app.state().mode,'live');assert.equal(app.state().id,currentId);
  app.click('recover-reports');
  assert.equal(app.recoveries().find(item=>item.id===recoveredId)?.kind,'pending','the RAM frozen record takes precedence over the older draft');
  await app.openRecovery(recoveredId);
  const recovered=app.state().pending;
  assert.equal(recovered.id,frozen.id);
  assert.equal(recovered.savedAt,frozen.savedAt);
  assert.equal(recovered.reportText,frozen.reportText);
  assert.deepEqual(recovered,frozen);
  for(const[oldKey,raw]of fixture.entries)assert.equal(storage.getItem(oldKey),raw);
  for(const name of ['usbCheck','usbScan','usbReset','usbConnect','guidedStart'])assert.equal(app.calls[name],0,name);
});

test('a validated saved marker from another window forks the live ID while invalid markers preserve it',()=>{
  const storage=new MemoryStorage(),app=boot(storage);
  app.input('location','Continue this physical test');app.input('technician','Current operator');app.chooseCapacity('80');app.click('next');
  const before=app.state(),oldDraftKey=storageHelpers.draftKey(before.id),oldDraft=storage.getItem(oldDraftKey);
  const markerKey=storageHelpers.savedKey(before.id),fileId='saved_in_other_window_123456789';
  const receipt={fileId,url:`https://drive.google.com/file/d/${fileId}/view`,reportId:before.id};
  for(const raw of [
    'not valid JSON',
    JSON.stringify({schema:1,receipt:{...receipt,reportId:uuid()}}),
    JSON.stringify({schema:1,receipt:{...receipt,url:`https://evil.test/file/d/${fileId}/view`}}),
  ]){
    storage.setItem(markerKey,raw);app.fire('storage',{key:markerKey,newValue:raw,storageArea:storage});app.flush();
    assert.deepEqual(app.state(),before);assert.equal(app.calls.uuid,1);
  }
  const marker=JSON.stringify({schema:1,receipt});
  app.fire('storage',{key:storageHelpers.savedKey(uuid()),newValue:marker,storageArea:storage});app.flush();
  assert.deepEqual(app.state(),before,'a different report key cannot fork this test');
  storage.setItem(markerKey,marker);app.fire('storage',{key:markerKey,newValue:marker,storageArea:storage});app.flush();
  const after=app.state();
  assert.notEqual(after.id,before.id);
  assert.deepEqual(after,{...before,id:after.id},'only the report identity changes; metadata and physical progress remain');
  assert.equal(app.calls.uuid,2);
  assert.equal(storage.getItem(oldDraftKey),oldDraft);
  assert.equal(storage.getItem(markerKey),marker);
  const newDraft=JSON.parse(storage.getItem(storageHelpers.draftKey(after.id)));
  assert.deepEqual(newDraft.details,before.details);assert.equal(newDraft.step,before.step);
  noAutomaticIO(app);
});

test('board identification gates the power step and preserves labels through a frozen report and explicit recovery',async()=>{
  const storage=new MemoryStorage(),app=boot(storage,{driveFailure:'Simulated Drive rejection'});
  app.input('location','Configuration test site');app.input('technician','Configuration operator');
  app.chooseCapacity('80');
  app.click('next');
  assert.equal(app.state().step,'identify');
  assert.equal(app.document.querySelector('#next').disabled,true);
  app.click('next');assert.equal(app.state().step,'identify');
  assert.deepEqual(app.document.querySelectorAll('[data-board-configuration]').map(x=>x.dataset.boardConfiguration).sort(),
    ['flat-input-sense','individual-wires','mixed','unsure'].sort());
  noAutomaticIO(app);
  app.chooseConfiguration('flat-input-sense');
  assert.equal(app.state().details.boardConfiguration,'flat-input-sense');
  assert.equal(app.document.querySelector('#next').disabled,false);
  app.chooseConfiguration('individual-wires');
  const identification={boardConfiguration:'individual-wires',masterBoardLabel:'Master C label 304-C',
    slaveBoardLabels:'A/B/D/E: 304 slave labels',configurationNotes:'Individual blue sensor wires observed on all banks.'};
  for(const key of ['masterBoardLabel','slaveBoardLabels','configurationNotes'])app.input(key,identification[key]);
  app.click('next');assert.equal(app.state().step,'before-restart');
  app.beforeCommunication('unsure');app.click('next');assert.equal(app.state().step,'power');
  for(const[key,value]of Object.entries(identification))assert.equal(app.state().details[key],value);
  noAutomaticIO(app);
  app.click('save-report');await app.settle();
  assert.equal(app.state().mode,'pending');assert.equal(app.calls.driveSave,1);
  const frozen=app.state().pending;
  assert.equal(frozen.session.beforeRestart.communication,'unsure');assert.ok(frozen.session.beforeRestart.recordedAt);
  for(const[key,value]of Object.entries(identification))assert.equal(frozen.session.details[key],value);
  const pendingRaw=storage.getItem(storageHelpers.pendingKey(frozen.id));assert.ok(pendingRaw);
  const reopened=boot(storage);freshWelcome(reopened,[frozen.id]);
  assert.equal(storage.getItem(storageHelpers.pendingKey(frozen.id)),pendingRaw);
  reopened.click('recover-reports');
  assert.equal(reopened.recoveries().find(item=>item.id===frozen.id)?.kind,'pending');
  await reopened.openRecovery(frozen.id);
  assert.deepEqual(reopened.state().pending,frozen);
  for(const[key,value]of Object.entries(identification))assert.equal(reopened.state().pending.session.details[key],value);
  noAutomaticIO(reopened);
});

test('door opening requires a chosen door and explicit readiness, blocks report changes during I/O, and never replays on render',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true,holdDoorOpen:true});
  app.enterDoorStep();assert.equal(app.state().step,'doors');
  assert.equal(app.calls.doorOpen,0);assert.equal(app.document.querySelector('#next').disabled,true);
  app.selectData('data-door-setup','original');
  app.selectData('data-door-number','1');assert.equal(app.calls.doorOpen,0);
  assert.equal(app.document.querySelector('#door-open').disabled,true);
  app.check('door-ready');assert.equal(app.calls.doorOpen,0);
  app.click('door-open');
  assert.equal(app.calls.doorOpen,1);
  for(const id of ['save-report','restart','recover-reports','saved-reports','back','next'])assert.equal(app.document.querySelector('#'+id).disabled,true,id+' stays disabled during the opening check');
  app.click('save-report');app.click('restart');assert.equal(app.calls.driveSave,0);
  app.releaseDoor();await app.settle();
  assert.equal(app.state().doorTests.banks.A.command.open.status,'sent');
  app.selectData('data-door-answer','opened:yes');
  app.click('door-read-closed');await app.settle();
  app.selectData('data-door-answer','closed:yes');app.click('door-complete');
  assert.equal(app.state().doorTests.banks.A.status,'tested');
  app.selectData('data-door-bank','A');
  assert.equal(app.document.querySelector('#door-open'),null,'completed attempt has no Open button');
  app.selectData('data-door-bank','C');app.selectData('data-door-bank','A');
  assert.equal(app.calls.doorOpen,1,'bank selection and renders do not activate outputs');
  app.type('door-remaining-reason','Remaining columns unavailable during this software test.');app.click('door-skip-remaining');
  assert.equal(app.document.querySelector('#next').disabled,false);
  app.click('next');assert.equal(app.state().step,'result');
  app.click('back');assert.equal(app.state().step,'doors');assert.equal(app.calls.doorOpen,1);
  app.click('next');assert.equal(app.state().step,'result');assert.equal(app.calls.doorOpen,1);
  app.click('save-result');await app.settle();
  assert.equal(app.state().mode,'pending');
  const frozen=app.state().pending;
  assert.equal(frozen.session.doorTests.banks.A.operator.opened,'yes');
  assert.equal(frozen.session.doorTests.banks.B.status,'skipped');
  assert.match(frozen.reportText,/ONE DOOR PER COLUMN/);
  assert.match(frozen.reportText,/Operator observed physically opened: yes/);
  assert.match(frozen.reportText,/A: 1, 2/);
  assert.match(frozen.reportText,/Remaining columns unavailable during this software test\./);
  const reopened=boot(app.storage,{usbConnected:true});freshWelcome(reopened,[frozen.id]);
  reopened.click('recover-reports');await reopened.openRecovery(frozen.id);
  assert.deepEqual(reopened.state().pending,frozen);assert.equal(reopened.calls.doorOpen,0);
});

test('one explicit selected-door opening is recorded for each of A B C D E before the final report',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterDoorStep();
  app.selectData('data-door-setup','original');
  for(const [index,board] of flow.BOARDS.entries()){
    app.selectData('data-door-bank',board);app.selectData('data-door-number',String(index+1));app.check('door-ready');
    assert.equal(app.calls.doorOpen,index);
    app.click('door-open');await app.settle();
    app.selectData('data-door-answer','opened:yes');app.click('door-read-closed');await app.settle();
    app.selectData('data-door-answer','closed:yes');app.click('door-complete');
    assert.equal(app.state().doorTests.banks[board].status,'tested');
    assert.equal(app.calls.doorOpen,index+1);
    assert.equal(app.document.querySelector('#next').disabled,index!==4);
  }
  assert.deepEqual(app.doorTargets,flow.BOARDS.map((board,index)=>({board,door:index+1})));
  app.click('next');assert.equal(app.state().step,'result');assert.equal(app.calls.doorOpen,5);
});

test('an unavailable USB connection can finish with explicit reasons for all five uncompleted door tests',()=>{
  const app=boot();app.enterDoorStep();
  app.selectData('data-door-setup','original');app.selectData('data-door-number','16');app.check('door-ready');
  assert.equal(app.document.querySelector('#door-open').disabled,true);
  app.click('door-open');assert.equal(app.calls.doorOpen,0);
  app.type('door-remaining-reason','No USB connection could be established.');app.click('door-skip-remaining');
  for(const board of flow.BOARDS){assert.equal(app.state().doorTests.banks[board].status,'skipped');assert.equal(app.state().doorTests.banks[board].skipReason,'No USB connection could be established.');}
  app.click('next');assert.equal(app.state().step,'result');assert.equal(app.calls.doorOpen,0);
});

test('preflight failure records no opening command and requires readiness again before an explicit retry',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true,doorPreflightFailure:'Selected column did not reply before opening.'});
  app.enterDoorStep();app.selectData('data-door-setup','original');
  const invalidChoice=app.document.querySelector('[data-door-number="1"]');invalidChoice.dataset.doorNumber='17';invalidChoice.click();app.flush();assert.equal(app.state().doorTests.banks.A.door,null);invalidChoice.dataset.doorNumber='1';
  app.selectData('data-door-number','1');app.check('door-ready');app.click('door-open');await app.settle();
  assert.equal(app.state().doorTests.banks.A.command.open,null);
  assert.equal(app.state().doorTests.banks.A.status,'testing');
  assert.equal(app.document.querySelector('#door-open').disabled,true);
  assert.equal(app.document.querySelectorAll('[data-door-answer]').length,0,'no physical opening is inferred from a preflight failure');
  app.type('door-skip-reason','The starting sensor reading could not be confirmed.');app.click('door-skip');
  assert.equal(app.state().doorTests.banks.A.status,'skipped');
  assert.equal(app.state().doorTests.banks.A.command.open,null);
});

test('a controller-rejected lock-off stays uncertain even if its USB bytes were transmitted',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true,doorOffFailure:true});
  app.enterDoorStep();app.selectData('data-door-setup','original');app.selectData('data-door-number','1');app.check('door-ready');
  app.click('door-open');await app.settle();
  const item=app.state().doorTests.banks.A;
  assert.equal(item.command.open.status,'sent');assert.equal(item.command.lockOff.status,'uncertain');
  assert.equal(item.command.lockOff.code,'LOCK_OFF');
  assert.equal(item.command.open.at,'2026-11-18T12:00:00.100Z');
  assert.equal(item.command.lockOff.at,'2026-11-18T12:00:00.600Z');
  assert.match(doorTests.formatDoorTests(app.state().doorTests),/Lock-off command: uncertain.*LOCK_OFF/);
});

test('each capacity needs an explicit choice and survives the report, reload and read-only recovery',async()=>{
  for(const capacity of ['80','64','32']){
    const app=boot();app.input('location','Capacity software check');app.input('technician','Operator');
    assert.equal(app.state().details.lockerCapacity,'');assert.equal(app.document.querySelector('#next').disabled,true);
    assert.deepEqual(app.document.querySelectorAll('[data-locker-capacity]').map(element=>element.dataset.lockerCapacity),['80','64','32']);
    app.click('next');assert.equal(app.state().step,'welcome');
    app.chooseCapacity(capacity);assert.equal(app.state().details.lockerCapacity,capacity);
    assert.equal(app.document.querySelector('#next').disabled,false);noAutomaticIO(app);
    app.click('next');assert.equal(app.state().step,'identify');
    assert.match(app.state().log.at(-1).label,new RegExp(capacity+' bays'));
    app.click('back');assert.equal(app.state().details.lockerCapacity,capacity);
    app.click('save-report');await app.settle();
    assert.equal(app.state().mode,'pending');
    const frozen=app.state().pending;assert.equal(frozen.session.details.lockerCapacity,capacity);
    assert.match(frozen.reportText,new RegExp('Locker capacity: '+capacity+' bays'));
    const reopened=boot(app.storage);freshWelcome(reopened,[frozen.id]);
    reopened.click('recover-reports');await reopened.openRecovery(frozen.id);
    assert.deepEqual(reopened.state().pending,frozen);noAutomaticIO(reopened);
  }
});

test('32- and 64-bay communication checks and door steps use only their confirmed columns',async()=>{
  for(const [capacity,targets] of [['32',['A','B']],['64',['A','B','C','D']]]){
    const app=boot(new MemoryStorage(),{usbConnected:true});
    app.enterInitialCheck(capacity);await app.settle();
    assert.deepEqual(app.scanTargets,[targets]);
    assert.deepEqual(Object.keys(app.state().initial),targets);
    assert.equal(app.document.querySelector('#next').disabled,false);
    app.click('next');assert.equal(app.state().step,'doors');
    assert.deepEqual(app.document.querySelectorAll('[data-door-bank]').map(element=>element.dataset.doorBank),targets);
    app.selectData('data-door-setup','original');
    for(const [index,board] of targets.entries()){
      app.selectData('data-door-bank',board);app.selectData('data-door-number',String(index+1));app.check('door-ready');
      app.click('door-open');await app.settle();
      app.selectData('data-door-answer','opened:yes');app.click('door-read-closed');await app.settle();
      app.selectData('data-door-answer','closed:yes');app.click('door-complete');
      assert.equal(app.document.querySelector('#next').disabled,index!==targets.length-1);
    }
    assert.deepEqual(app.doorTargets,targets.map((board,index)=>({board,door:index+1})));
    app.click('next');assert.equal(app.state().step,'result');
    app.click('save-result');await app.settle();
    const frozen=app.state().pending;assert.ok(frozen);
    assert.deepEqual(frozen.session.doorTests.targets,targets);
    const text=frozen.reportText;
    for(const absent of flow.BOARDS.filter(board=>!targets.includes(board)))assert.doesNotMatch(text,new RegExp('BANK '+absent+':'));
    assert.match(text,new RegExp('Locker capacity: '+capacity+' bays'));
    assert.equal(app.calls.doorOpen,targets.length);
  }
});

test('capacity changes reset blank door targets before testing and preserve the original capacity after evidence',async()=>{
  const app=boot();app.chooseCapacity('80');app.chooseCapacity('32');
  assert.deepEqual(app.state().doorTests.targets,['A','B']);
  app.chooseCapacity('64');assert.deepEqual(app.state().doorTests.targets,['A','B','C','D']);
  app.chooseCapacity('32');app.enterDoorStep('32');
  app.selectData('data-door-setup','original');
  app.click('back');assert.equal(app.state().step,'welcome');
  app.chooseCapacity('80');assert.equal(app.state().details.lockerCapacity,'32','door-test setup evidence locks the recorded capacity');
  assert.deepEqual(app.state().doorTests.targets,['A','B']);
  assert.match(app.document.querySelector('#toast').textContent,/new report/);
});

test('a partial 32-bay B-master door-stage draft remains recoverable as read-only evidence without opening a door',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterDoorStep('32');
  app.selectData('data-door-setup','original');app.selectData('data-door-number','1');app.check('door-ready');
  app.click('door-open');await app.settle();
  const original=app.state(),key=storageHelpers.draftKey(original.id),raw=app.storage.getItem(key);
  assert.ok(raw);assert.equal(JSON.parse(raw).step,'doors');
  const reopened=boot(app.storage);freshWelcome(reopened,[original.id]);
  reopened.click('recover-reports');assert.ok(reopened.recoveries().some(item=>item.id===original.id));
  await reopened.openRecovery(original.id);
  assert.equal(reopened.state().mode,'pending');
  assert.deepEqual(reopened.state().pending.session.doorTests,original.doorTests);
  assert.equal(reopened.calls.doorOpen,0);assert.equal(app.storage.getItem(key),raw);
});

test('32-bay connection proof, reset, sidebar and door master use B while 64 and 80 keep C',async()=>{
  for(const [capacity,master,targets] of [['32','B',['A','B']],['64','C',['A','B','C','D']],['80','C',flow.BOARDS]]){
    const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection(capacity);await app.settle();
    assert.deepEqual(app.queryTargets,[master]);
    assert.equal(app.document.querySelector('#master-tab').textContent,'Master '+master);
    assert.equal(app.document.querySelector('#board-map-row').getAttribute('aria-label'),`Boards ${targets.join(' ')} with ${master} as master`);
    assert.match(app.document.querySelector('#board-map-note').textContent,new RegExp('USB connects to '+master));
    app.readyConnection(master==='B'?'C':'B');
    assert.equal(app.document.querySelector('#next').disabled,true);app.click('next');
    assert.equal(app.calls.usbReset,0);assert.equal(app.state().step,'connect');
    assert.doesNotMatch(app.document.querySelector('#step').innerHTML,/We are happy with the connection/);
    app.readyConnection(master);app.click('next');
    assert.match(app.document.querySelector('#step').innerHTML,new RegExp('Resetting master '+master));
    if(master==='B')assert.doesNotMatch(app.document.querySelector('#step').innerHTML,/master C/);
    await app.settle();
    assert.equal(app.state().step,'reset');assert.deepEqual(app.resetTargets,[master]);
    assert.match(app.state().log.at(-1).label,new RegExp('RST#'+master));
    app.click('next');await app.settle();assert.deepEqual(app.scanTargets,[targets]);
    app.click('next');assert.equal(app.state().step,'doors');
    assert.deepEqual(app.document.querySelectorAll('[data-door-bank]').map(element=>element.dataset.doorBank),targets);
    assert.match(app.document.querySelector('#door-guide').innerHTML,new RegExp('<b>'+master+' · master</b>'));
    assert.equal(app.state().doorTests.master,master);
  }
});

test('32-bay setup identifies A and B and captions the C-master reference photographs as examples',()=>{
  const app=boot();app.chooseCapacity('32');
  assert.deepEqual(app.state().doorTests.targets,['A','B']);assert.equal(app.state().doorTests.master,'B');
  app.click('next');assert.equal(app.state().step,'identify');
  assert.match(app.document.querySelector('#step').innerHTML,/master B and slave A/);
  assert.match(app.document.querySelector('#reference-caption').textContent,/C-master reference.*master B and slave A/);
  app.click('zoom-photo');assert.equal(app.document.querySelector('#photo-dialog').open,true);
  assert.match(app.document.querySelector('#photo-caption').textContent,/master B and slave A/);
});

test('self-test button help uses the recorded reference version and the configured master',()=>{
  for(const [capacity,master]of[['32','B'],['64','C'],['80','C']])for(const setup of['flat-input-sense','individual-wires']){
    const app=boot();app.enterSelfTest(capacity,setup);
    assert.match(app.document.querySelector('#step').innerHTML,/Need help finding the red button\?/);
    assert.equal(app.document.querySelector('#button-help').getAttribute('open'),null);
    const image=app.document.querySelector('#button-help-image');
    assert.equal(image.getAttribute('src'),setup==='individual-wires'?'assets/master-wired-reference.jpg':'assets/master.png');
    assert.match(app.document.querySelector('#step').innerHTML,new RegExp('Use the button on master '+master));
    assert.match(app.document.querySelector('#step').innerHTML,new RegExp('We will reset master '+master+' and try'));
    assert.equal(app.timerCount(),0);noAutomaticIO(app);
  }
});

test('opening button help, switching references and enlarging the photo do not start a timer or change test evidence',()=>{
  const app=boot();app.enterSelfTest('32','flat-input-sense');const before=app.state();
  const help=app.document.querySelector('#button-help');help.open=true;help.dispatch('toggle');
  app.change('button-help-setup','individual-wires');
  assert.equal(app.document.querySelector('#button-help').getAttribute('open'),'');
  assert.equal(app.document.querySelector('#button-help-image').getAttribute('src'),'assets/master-wired-reference.jpg');
  app.click('button-help-preview');
  assert.equal(app.document.querySelector('#photo-dialog').open,true);
  assert.equal(app.document.querySelector('#full-photo').src,'assets/master-wired-labelled.png');
  assert.match(app.document.querySelector('#photo-caption').textContent,/master B and slave A/);
  app.click('close-photo');app.change('button-help-setup','flat-input-sense');
  assert.equal(app.document.querySelector('#button-help-image').getAttribute('src'),'assets/master.png');
  assert.deepEqual(app.state(),before);assert.equal(app.timerCount(),0);noAutomaticIO(app);
});

test('the pre-restart page records all, none or unsure before power without any automatic USB action',()=>{
  for(const capacity of ['80','64','32'])for(const answer of ['all','none','unsure']){
    const app=boot();app.enterBeforeRestart(capacity,'flat-input-sense',{connected:true});
    assert.deepEqual(app.state().beforeRestart,{communication:'',unresponsiveBoards:[],notes:'',recordedAt:''});
    assert.deepEqual(app.document.querySelectorAll('[name="pre-restart-communication"]').map(element=>element.value),['all','some','none','unsure']);
    assert.equal(app.document.querySelector('#next').disabled,true);
    const finding=app.finding(),initial=app.state().initial,recheck=app.state().recheck;
    app.click('next');assert.equal(app.state().step,'before-restart');
    app.beforeCommunication(answer);app.type('pre-restart-notes','Observation from parkIT before the power cycle.');
    assert.equal(app.document.querySelector('#next').disabled,false);
    assert.equal(app.document.querySelectorAll('[name="pre-restart-board"]').length,0,'only some needs a column checklist');
    assert.equal(app.state().beforeRestart.recordedAt,'');noAutomaticIO(app);
    app.click('next');assert.equal(app.state().step,'power');
    assert.equal(app.state().beforeRestart.communication,answer);
    assert.deepEqual(app.state().beforeRestart.unresponsiveBoards,[]);
    assert.equal(app.state().beforeRestart.notes,'Observation from parkIT before the power cycle.');
    assert.match(app.state().beforeRestart.recordedAt,/^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.deepEqual(app.state().initial,initial);assert.deepEqual(app.state().recheck,recheck);assert.deepEqual(app.finding(),finding);
    noAutomaticIO(app);
  }
});

test('some columns requires a proper nonempty subset of the fitted layout and labels its configured master',()=>{
  for(const[capacity,master,targets]of[['32','B',['A','B']],['64','C',['A','B','C','D']],['80','C',['A','B','C','D','E']]]){
    const app=boot();app.enterBeforeRestart(capacity,'individual-wires',{connected:true});
    app.beforeCommunication('some');
    assert.deepEqual(app.document.querySelectorAll('[name="pre-restart-board"]').map(element=>element.value),targets);
    assert.ok(app.document.querySelector('#step').innerHTML.includes(`<strong>${master} (master)</strong>`));
    assert.equal(app.document.querySelector('#next').disabled,true);app.click('next');assert.equal(app.state().step,'before-restart');
    for(const board of targets)app.beforeBoard(board);
    assert.equal(app.document.querySelector('#next').disabled,true,'all fitted columns needs the none response');
    app.click('next');assert.equal(app.state().step,'before-restart');
    app.beforeBoard(targets.at(-1),false);
    assert.equal(app.document.querySelector('#next').disabled,false);
    const expected=targets.slice(0,-1),finding=app.finding();
    app.click('next');assert.equal(app.state().step,'power');
    assert.equal(app.state().beforeRestart.communication,'some');assert.deepEqual(app.state().beforeRestart.unresponsiveBoards,expected);
    assert.deepEqual(app.finding(),finding);assert.deepEqual(app.state().initial,{});assert.deepEqual(app.state().recheck,{});
    noAutomaticIO(app);
  }
});

test('recorded pre-restart evidence is read-only on Back, resists stale events and stays blank in a new opening',()=>{
  const app=boot();app.enterBeforeRestart('32');app.beforeCommunication('some');app.beforeBoard('A');
  app.type('pre-restart-notes','A did not respond in parkIT before restarting.');
  const oldRadio=app.document.querySelectorAll('[name="pre-restart-communication"]').find(element=>element.value==='all');
  const oldBoard=app.document.querySelectorAll('[name="pre-restart-board"]').find(element=>element.value==='B');
  const oldNotes=app.document.querySelector('#pre-restart-notes');
  app.click('next');assert.equal(app.state().step,'power');
  const recorded=app.state().beforeRestart;assert.ok(recorded.recordedAt);
  app.click('back');assert.equal(app.state().step,'before-restart');
  assert.deepEqual(app.state().beforeRestart,recorded);
  assert.ok(app.document.querySelectorAll('fieldset').some(element=>element.disabled));
  assert.equal(app.document.querySelector('#pre-restart-notes').readOnly,true);
  assert.equal(app.document.querySelector('#pre-restart-notes').value,recorded.notes);
  assert.equal(app.document.querySelector('[name="pre-restart-board"][value="A"]').checked,true);
  assert.match(app.document.querySelector('#step').innerHTML,/observation was recorded/);
  oldRadio.checked=true;oldRadio.dispatch('change');oldBoard.checked=true;oldBoard.dispatch('change');
  oldNotes.value='Changed after recording';oldNotes.dispatch('input');app.flush();
  assert.deepEqual(app.state().beforeRestart,recorded,'detached earlier event handlers cannot rewrite recorded evidence');
  const currentNotes=app.document.querySelector('#pre-restart-notes');currentNotes.value='Another late edit';currentNotes.dispatch('input');app.flush();
  assert.deepEqual(app.state().beforeRestart,recorded);
  app.advanceAppTime(60000);app.click('next');assert.equal(app.state().step,'power');
  assert.deepEqual(app.state().beforeRestart,recorded,'continuing again does not replace the first recording time');
  const raw=app.storage.getItem(storageHelpers.draftKey(app.state().id)),reopened=boot(app.storage);
  freshWelcome(reopened,[app.state().id]);assert.equal(app.storage.getItem(storageHelpers.draftKey(app.state().id)),raw);
  noAutomaticIO(app);
});

test('changing capacity before confirmation clears stale column choices but retains notes and an audit entry',()=>{
  const app=boot();app.enterBeforeRestart('80');app.beforeCommunication('some');app.beforeBoard('E');
  app.type('pre-restart-notes','Review this parkIT message after correcting the locker size.');
  assert.equal(app.state().beforeRestart.recordedAt,'');
  app.click('back');assert.equal(app.state().step,'identify');app.click('back');assert.equal(app.state().step,'welcome');
  app.chooseCapacity('32');
  assert.equal(app.state().beforeRestart.communication,'');assert.deepEqual(app.state().beforeRestart.unresponsiveBoards,[]);
  assert.equal(app.state().beforeRestart.notes,'Review this parkIT message after correcting the locker size.');
  assert.equal(app.state().beforeRestart.recordedAt,'');
  assert.ok(app.state().log.some(entry=>/some/i.test(entry.label)&&/\bE\b/.test(entry.label)),'the earlier unconfirmed choice is retained in the step record');
  app.click('next');app.click('next');assert.equal(app.state().step,'before-restart');
  assert.equal(app.document.querySelector('#next').disabled,true);
  app.beforeCommunication('some');
  assert.deepEqual(app.document.querySelectorAll('[name="pre-restart-board"]').map(element=>element.value),['A','B']);
  app.beforeBoard('A');assert.equal(app.document.querySelector('#next').disabled,false);
  assert.deepEqual(app.state().beforeRestart.unresponsiveBoards,['A']);noAutomaticIO(app);
});

test('detecting A under expected master C requires an explicit single-board choice and never sends RST',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('80');await app.settle();
  const before=app.calls.usbCheck;app.foundBoards(discoveryResults('A'));
  assert.equal(app.state().step,'connect');assert.equal(app.document.querySelector('#next').disabled,true);
  assert.deepEqual(app.document.querySelectorAll('[data-use-detected-board]').map(element=>element.dataset.useDetectedBoard),['A']);
  assert.equal(app.calls.usbAdopt,0);assert.equal(app.calls.usbCheck,before);assert.equal(app.calls.usbReset,0);
  app.click('next');assert.equal(app.state().step,'connect');
  app.selectData('data-use-detected-board','A');await app.settle();
  assert.equal(app.state().step,'single-board');assert.deepEqual(app.adoptedBoards,['A']);
  assert.equal(app.state().boardDetection.selection.board,'A');assert.equal(app.state().boardDetection.selection.expectedMaster,'C');
  assert.deepEqual(app.state().doorTests.targets,['A']);assert.equal(app.state().doorTests.master,null);assert.equal(app.state().doorTests.scope,'board');
  assert.deepEqual(app.queryTargets,['C','A']);assert.equal(app.calls.usbReset,0);assert.equal(app.calls.usbScan,0);
  assert.equal(app.document.querySelector('#next').disabled,false);
  app.click('next');assert.equal(app.state().step,'doors');
  assert.deepEqual(app.document.querySelectorAll('[data-door-bank]').map(element=>element.dataset.doorBank),['A']);
  assert.doesNotMatch(app.document.querySelector('#door-guide').innerHTML,/<b>A · master<\/b>/);
  assert.equal(app.calls.doorOpen,0,'selecting an address never opens a door');
  app.selectData('data-door-setup','original');app.selectData('data-door-number','3');app.check('door-ready');
  app.click('door-open');await app.settle();
  assert.deepEqual(app.doorTargets,[{board:'A',door:3}]);assert.equal(app.calls.usbReset,0);
  app.selectData('data-door-answer','opened:yes');app.click('door-read-closed');await app.settle();
  app.selectData('data-door-answer','closed:yes');app.click('door-complete');app.click('next');
  assert.equal(app.state().step,'result');assert.match(app.document.querySelector('#step').innerHTML,/single.board|one board|limited/i);
});

test('an E response outside the 32-bay A,B layout is usable only after explicit limited-scope selection',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('32');await app.settle();
  app.foundBoards(discoveryResults('E'),{master:'B'});
  assert.equal(app.document.querySelector('#next').disabled,true);assert.equal(app.calls.usbAdopt,0);
  assert.deepEqual(app.queryTargets,['B']);assert.deepEqual(app.state().doorTests.targets,['A','B']);
  app.selectData('data-use-detected-board','E');await app.settle();
  assert.equal(app.state().step,'single-board');assert.deepEqual(app.adoptedBoards,['E']);
  assert.equal(app.state().details.lockerCapacity,'32');assert.equal(app.state().boardDetection.selection.expectedMaster,'B');
  assert.deepEqual(app.state().doorTests.targets,['E']);assert.equal(app.state().doorTests.master,null);
  assert.deepEqual(app.queryTargets,['B','E']);assert.deepEqual(app.resetTargets,[]);
  app.click('next');assert.equal(app.state().step,'doors');
  assert.deepEqual(app.document.querySelectorAll('[data-door-bank]').map(element=>element.dataset.doorBank),['E']);
  app.selectData('data-door-setup','original');app.selectData('data-door-number','16');app.check('door-ready');
  app.click('door-open');await app.settle();assert.deepEqual(app.doorTargets,[{board:'E',door:16}]);
  assert.equal(app.calls.usbReset,0);assert.equal(app.calls.usbScan,0);
});

test('multiple responding addresses remain separate choices and select only the clicked controller',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('80');await app.settle();
  app.foundBoards(discoveryResults('A','E'));
  assert.deepEqual(app.document.querySelectorAll('[data-use-detected-board]').map(element=>element.dataset.useDetectedBoard),['A','E']);
  assert.equal(app.calls.usbAdopt,0);assert.equal(app.document.querySelector('#next').disabled,true);
  app.selectData('data-use-detected-board','E');await app.settle();
  assert.deepEqual(app.adoptedBoards,['E']);assert.deepEqual(app.queryTargets,['C','E']);
  assert.deepEqual(app.state().doorTests.targets,['E']);assert.equal(app.calls.usbReset,0);
});

test('Back after explicit adoption retains the limited scope and never restarts the expected-master probe',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('80');await app.settle();
  app.foundBoards(discoveryResults('A'));app.selectData('data-use-detected-board','A');await app.settle();
  assert.equal(app.state().step,'single-board');const checks=app.calls.usbCheck,starts=app.calls.guidedStart;
  app.click('back');await app.settle();
  assert.equal(app.state().step,'connect');assert.equal(app.calls.guidedStart,starts);assert.equal(app.calls.usbCheck,checks);
  assert.equal(app.document.querySelectorAll('[data-use-detected-board]').length,0);
  assert.equal(app.state().boardDetection.selection.board,'A');
  app.click('next');await app.settle();assert.equal(app.state().step,'single-board');
  assert.deepEqual(app.queryTargets,['C','A','A']);assert.deepEqual(app.adoptedBoards,['A']);
  assert.equal(app.calls.usbReset,0);assert.equal(app.calls.usbScan,0);assert.equal(app.calls.doorOpen,0);
});

test('retry, Back and stale discovery buttons cannot silently select a controller',async()=>{
  for(const action of ['retry','back','disconnected','superseded']){
    const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('80');await app.settle();
    app.foundBoards(discoveryResults('A'));
    const stale=app.document.querySelector('[data-use-detected-board="A"]');assert.ok(stale);
    const checks=app.calls.usbCheck;
    if(action==='retry')app.click('retry-connection');
    if(action==='back')app.click('back');
    if(action==='disconnected')await app.disconnectUsb();
    if(action==='superseded'){app.advanceAppTime(1000);app.foundBoards(discoveryResults('E'));}
    stale.click();await app.settle();
    assert.equal(app.calls.usbAdopt,0,action);assert.equal(app.calls.usbReset,0,action);assert.equal(app.calls.doorOpen,0,action);
    assert.ok(!app.state().boardDetection.selection,action);
    assert.equal(app.calls.usbCheck,checks+(action==='retry'?1:0),action);
  }
});

test('discovery rendering and photographs record evidence without adopting or performing more USB work',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('80');await app.settle();
  const before={checks:app.calls.usbCheck,scans:app.calls.usbScan,resets:app.calls.usbReset,opens:app.calls.doorOpen};
  app.foundBoards(discoveryResults('A'));
  const observed=app.state().boardDetection;assert.ok(observed);
  app.click('zoom-photo');app.click('close-photo');app.change('reference-setup','individual-wires');
  assert.deepEqual(app.state().boardDetection,observed);assert.equal(app.calls.usbAdopt,0);
  assert.deepEqual({checks:app.calls.usbCheck,scans:app.calls.usbScan,resets:app.calls.usbReset,opens:app.calls.doorOpen},before);
  app.click('save-report');await app.settle();
  const frozen=app.state().pending;assert.ok(frozen);assert.deepEqual(frozen.session.boardDetection,observed);
  const reopened=boot(app.storage);freshWelcome(reopened,[frozen.id]);
  reopened.click('recover-reports');await reopened.openRecovery(frozen.id);
  assert.deepEqual(reopened.state().pending.session.boardDetection,observed);noAutomaticIO(reopened);
});

test('a saved limited-board report freezes the discovery and original expected-master context without replaying USB work',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true});app.enterConnection('80');await app.settle();
  app.foundBoards(discoveryResults('A'));app.selectData('data-use-detected-board','A');await app.settle();
  app.click('next');assert.equal(app.state().step,'doors');
  app.type('door-remaining-reason','Physical opening deferred after confirming the detected address.');app.click('door-skip-remaining');
  app.click('next');assert.equal(app.state().step,'result');app.click('save-result');await app.settle();
  const frozen=app.state().pending;assert.ok(frozen);
  assert.equal(frozen.session.boardDetection.selection.board,'A');assert.equal(frozen.session.boardDetection.selection.expectedMaster,'C');
  assert.deepEqual(frozen.session.doorTests.targets,['A']);assert.equal(frozen.session.doorTests.master,null);
  assert.match(frozen.reportText,/single.board|limited|one board/i);
  assert.match(frozen.reportText,/expected[^\n]*C|master[^\n]*C/i);
  assert.doesNotMatch(frozen.reportText,/Master board: A|A \(master\)|RST#A/);
  assert.deepEqual(app.resetTargets,[]);assert.equal(app.calls.doorOpen,0);
  const originalText=frozen.reportText,reopened=boot(app.storage);freshWelcome(reopened,[frozen.id]);
  reopened.click('recover-reports');await reopened.openRecovery(frozen.id);
  assert.equal(reopened.state().pending.reportText,originalText);
  assert.deepEqual(reopened.state().pending.session.boardDetection,frozen.session.boardDetection);noAutomaticIO(reopened);
});


test('visual door choices select without opening and require readiness again after a change',()=>{
 const app=boot(new MemoryStorage(),{usbConnected:true});app.enterDoorStep('32');
 assert.equal(app.document.querySelector('#door-number'),null);
 const choices=app.document.querySelectorAll('[data-door-number]');
 assert.deepEqual(choices.map(item=>Number(item.dataset.doorNumber)),[1,9,2,10,3,11,4,12,5,13,6,14,7,15,8,16]);
 assert.equal(choices.length,16);assert.equal(new Set(choices.map(item=>item.dataset.doorNumber)).size,16);
 app.selectData('data-door-setup','original');
 app.selectData('data-door-number','16');
 assert.equal(app.state().doorTests.banks.A.door,16);
 assert.equal(app.document.querySelector('[data-door-number="16"]').getAttribute('aria-pressed'),'true');
 assert.equal(app.calls.doorOpen,0);
 app.check('door-ready');assert.equal(app.document.querySelector('#door-open').disabled,false);
 app.selectData('data-door-number','1');
 assert.equal(app.document.querySelector('#door-ready').checked,false);
 assert.equal(app.document.querySelector('#door-open').disabled,true);
 assert.equal(app.document.querySelector('[data-door-number="16"]').getAttribute('aria-pressed'),'false');
 assert.equal(app.calls.doorOpen,0);assert.equal(app.calls.usbCheck,0);assert.equal(app.calls.usbReset,0);
 app.selectData('data-door-bank','B');assert.equal(app.state().doorTests.banks.B.door,null);
 assert.equal(app.document.querySelectorAll('[data-door-number]').filter(item=>item.getAttribute('aria-pressed')==='true').length,0);
});
