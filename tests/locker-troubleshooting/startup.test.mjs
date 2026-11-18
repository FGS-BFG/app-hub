import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as flow from '../../locker-troubleshooting/flow.js';
import * as records from '../../locker-troubleshooting/report-record.js';
import * as driveHelpers from '../../locker-troubleshooting/drive-reports.js';
import * as storageHelpers from '../../locker-troubleshooting/test-storage.js';
import * as doorTests from '../../locker-troubleshooting/door-test.js';
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
      this.elements.push(new FakeElement(this,match[1],attributes,owner));
    }
  }
  removeOwned(owner){this.elements=this.elements.filter(element=>{for(let parent=element.owner;parent;parent=parent.owner)if(parent===owner)return false;return true;});}
  matches(element,selector){
    if(selector.startsWith('#'))return element.id===selector.slice(1);
    if(selector.startsWith('.'))return element.classList.contains(selector.slice(1));
    const attribute=selector.match(/^\[([^\]]+)\]$/);
    if(attribute)return Object.hasOwn(element.attributes,attribute[1]);
    return element.tagName.toLowerCase()===selector.toLowerCase();
  }
  querySelector(selector){return this.elements.find(element=>this.matches(element,selector))??null;}
  querySelectorAll(selector){return this.elements.filter(element=>this.matches(element,selector));}
  addEventListener(){}
  createElement(tag){return new FakeElement(this,tag);}
}

function boot(storage=new MemoryStorage(),{usbConnected=false,driveFailure='Unexpected automatic Drive save.',holdDoorOpen=false,doorFailure='',doorPreflightFailure='',doorOffFailure=false}={}){
  const document=new FakeDocument(html),microtasks=[],timers=new Map(),windowListeners=new Map();
  const calls={uuid:0,usbCheck:0,usbScan:0,usbReset:0,usbConnect:0,doorOpen:0,doorRead:0,guidedStart:0,driveSave:0,library:0,reloads:0};
  const drivePayloads=[],doorTargets=[];
  let timerId=0,releaseDoor;
  const usbData={boards:{},lastBits:{},events:[],checks:[],observations:[],connected:usbConnected};
  const window={
    addEventListener(type,listener){if(!windowListeners.has(type))windowListeners.set(type,[]);windowListeners.get(type).push(listener);},
    location:{reload(){calls.reloads++;}},
  };
  const fire=(type,event={})=>{for(const listener of [...(windowListeners.get(type)||[])])listener({type,...event});};
  class GuidedConnection{
    constructor(options){this.options=options;}
    snapshot(){return{phase:'stopped',remainingSeconds:60};}
    start(){calls.guidedStart++;this.options.probe();}
    retry(){this.start();}
    stop(){}
    notifyConnection(){}
  }
  class DriveReportClient{
    async save(payload){calls.driveSave++;drivePayloads.push(clone(payload));throw Error(driveFailure);}
    openLibrary(){calls.library++;}
  }
  function mountUsbPanel(root,{onSave}){
    const usb={connected:usbConnected,supported:true,busy:false,monitoring:false,
      snapshot:()=>clone(usbData),setControlsEnabled(){},stopMonitor(){},clear(){},showError(){},async disconnect(){},
      async check(){calls.usbCheck++;return{board:'C',status:'responded',bits:'0'.repeat(16)};},
      async scan(){calls.usbScan++;},async reset(){calls.usbReset++;},async connect(){calls.usbConnect++;},
      stopDoorTest(){},
      async openDoorTest(board,door,{onPhase,onSample,onCommand}){
        calls.doorOpen++;doorTargets.push({board,door});
        const sample=(value,bits)=>({board:value,status:'responded',bits,at:'2026-11-18T12:00:00.000Z',elapsedMs:5});
        for(const value of flow.BOARDS)onSample('baseline',sample(value,'0'.repeat(16)));
        if(doorPreflightFailure)throw Object.assign(Error(doorPreflightFailure),{code:'BASELINE'});
        onCommand({openAttempted:true,openSent:!doorFailure,offSent:true,offAttempted:true,openAt:'2026-11-18T12:00:00.100Z',offAt:'2026-11-18T12:00:00.600Z',code:doorOffFailure?'LOCK_OFF':'',error:doorOffFailure?'Controller rejected the lock-off command.':''});
        onPhase('Watching the selected column…');
        onSample('open',sample(board,'0'.repeat(14)+'11'));
        if(holdDoorOpen)await new Promise(resolve=>{releaseDoor=resolve;});
        if(doorFailure||doorOffFailure)throw Error(doorFailure||'Controller rejected the lock-off command.');
      },
      async readDoorTestInputs(board,{onSample}){calls.doorRead++;for(const value of flow.BOARDS)onSample({board:value,status:'responded',bits:'0'.repeat(16),at:'2026-11-18T12:00:01.000Z',elapsedMs:5});},
    };
    onSave(clone(usbData));return usb;
  }
  const setTimer=callback=>{const id=timerId++;timers.set(id,callback);return id;};
  const context=vm.createContext({...flow,...records,...driveHelpers,...storageHelpers,...doorTests,
    // Production ESM modules share a realm. Normalize the VM/host boundary here
    // so its plain step-log objects reach the real validator as plain objects.
    createReportRecord:(session,options)=>records.createReportRecord(structuredClone(session),options),
    DriveReportClient,GuidedConnection,mountUsbPanel,createDoorGuide,shouldProceed:snapshot=>snapshot.phase==='ready',
    FIELD_REPORTS:{endpoint:'https://script.google.com/macros/s/TEST/exec'},
    document,window,localStorage:storage,crypto:{randomUUID(){calls.uuid++;return uuid();}},
    navigator:{clipboard:{writeText:async()=>{}}},structuredClone,
    queueMicrotask:callback=>microtasks.push(callback),setTimeout:setTimer,setInterval:setTimer,
    clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),console,
  });
  function flush(){for(let runs=0;microtasks.length;runs++){assert.ok(runs<100,'boot microtasks must settle');microtasks.shift()();}}
  new vm.Script(appSource,{filename:appUrl.pathname}).runInContext(context);flush();
  const state=()=>JSON.parse(vm.runInContext('JSON.stringify({id:s.reportId,step:s.step,details:s.details,initial:s.initial,recheck:s.recheck,doorTests:s.doorTests,history:s.history,log:s.log,mode:reportMode,pending:pendingRecord,saved:savedRecord,recovery:recoveryContext})',context));
  return{storage,document,calls,state,fire,flush,drivePayloads,doorTargets,
    enterDoorStep(){vm.runInContext("go('doors','Test fixture completed communication checks')",context);flush();},
    releaseDoor(){releaseDoor?.();},
    change(id,value){const element=document.querySelector('#'+id);assert.ok(element,'actual UI input exists: '+id);element.value=value;element.dispatch('change');flush();},
    type(id,value){const element=document.querySelector('#'+id);assert.ok(element,'actual UI field exists: '+id);element.value=value;element.dispatch('input');flush();},
    check(id,value=true){const element=document.querySelector('#'+id);assert.ok(element,'actual UI checkbox exists: '+id);element.checked=value;element.dispatch('change');flush();},
    selectData(attribute,value){const element=document.querySelectorAll('['+attribute+']').find(item=>item.getAttribute(attribute)===value);assert.ok(element,'actual UI choice exists: '+attribute+' '+value);element.click();flush();},
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
    click(id){const element=document.querySelector('#'+id);assert.ok(element,'actual UI control exists: '+id);element.click();flush();},
  };
}

function noAutomaticIO(app){
  for(const key of ['usbCheck','usbScan','usbReset','usbConnect','doorOpen','doorRead','guidedStart','driveSave','library'])assert.equal(app.calls[key],0,key);
}

function freshWelcome(app,oldIds=[]){
  const state=app.state();
  assert.equal(state.step,'welcome');assert.equal(state.mode,'live');
  assert.deepEqual(state.details,{location:'',technician:'',notes:'',boardConfiguration:'',masterBoardLabel:'',slaveBoardLabels:'',configurationNotes:''});
  assert.deepEqual(state.initial,{});assert.deepEqual(state.recheck,{});
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
  previous.click('next');assert.equal(previous.state().step,'identify');
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
  const app=boot();app.input('location','Test remains open');app.click('next');
  const before=app.state(),stored=[...app.storage.values];
  app.fire('blur');app.fire('focus');app.fire('focus');app.flush();
  assert.deepEqual(app.state(),before);assert.deepEqual([...app.storage.values],stored);
  assert.equal(app.calls.reloads,0);assert.equal(app.calls.uuid,1);noAutomaticIO(app);
});

test('only a persisted pageshow requests reload; the replacement opening starts a fresh test',()=>{
  const app=boot();app.input('location','Before back-forward restoration');app.click('next');
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
  app.input('location','Continue this physical test');app.input('technician','Current operator');app.click('next');
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
  app.click('next');assert.equal(app.state().step,'power');
  for(const[key,value]of Object.entries(identification))assert.equal(app.state().details[key],value);
  noAutomaticIO(app);
  app.click('save-report');await app.settle();
  assert.equal(app.state().mode,'pending');assert.equal(app.calls.driveSave,1);
  const frozen=app.state().pending;
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
  app.change('door-number','1');assert.equal(app.calls.doorOpen,0);
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
    app.selectData('data-door-bank',board);app.change('door-number',String(index+1));app.check('door-ready');
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
  app.selectData('data-door-setup','original');app.change('door-number','16');app.check('door-ready');
  assert.equal(app.document.querySelector('#door-open').disabled,true);
  app.click('door-open');assert.equal(app.calls.doorOpen,0);
  app.type('door-remaining-reason','No USB connection could be established.');app.click('door-skip-remaining');
  for(const board of flow.BOARDS){assert.equal(app.state().doorTests.banks[board].status,'skipped');assert.equal(app.state().doorTests.banks[board].skipReason,'No USB connection could be established.');}
  app.click('next');assert.equal(app.state().step,'result');assert.equal(app.calls.doorOpen,0);
});

test('preflight failure records no opening command and requires readiness again before an explicit retry',async()=>{
  const app=boot(new MemoryStorage(),{usbConnected:true,doorPreflightFailure:'Selected column did not reply before opening.'});
  app.enterDoorStep();app.selectData('data-door-setup','original');
  app.change('door-number','17');assert.equal(app.state().doorTests.banks.A.door,null);
  app.change('door-number','1');app.check('door-ready');app.click('door-open');await app.settle();
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
  app.enterDoorStep();app.selectData('data-door-setup','original');app.change('door-number','1');app.check('door-ready');
  app.click('door-open');await app.settle();
  const item=app.state().doorTests.banks.A;
  assert.equal(item.command.open.status,'sent');assert.equal(item.command.lockOff.status,'uncertain');
  assert.equal(item.command.lockOff.code,'LOCK_OFF');
  assert.equal(item.command.open.at,'2026-11-18T12:00:00.100Z');
  assert.equal(item.command.lockOff.at,'2026-11-18T12:00:00.600Z');
  assert.match(doorTests.formatDoorTests(app.state().doorTests),/Lock-off command: uncertain.*LOCK_OFF/);
});
