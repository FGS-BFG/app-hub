import {freshBankDoorTest,getDoorTargets,getDoorMaster,doorTestsComplete,doorTestSummary} from './door-test.js?v=20261118-click-door';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timestamp=()=>new Date().toISOString();
const boundedError=value=>{const text=String(value||'');return text.length>1000?text.slice(0,950)+' [truncated; see raw USB log]':text;};
const answerLabel=value=>({yes:'Yes',no:'No',uncertain:'Could not confirm'}[value]||'Not recorded');

// Opening is available only from an explicit click in the live door-test step.
// The diagram can read inputs while visible. Only the explicit open action releases a lock.
export function createDoorGuide({document,getState,getBoards=()=>getDoorTargets(getState()),getMaster=()=>getDoorMaster(getState()),usb,isActive,onChange=()=>{},onBusy=()=>{},onEvent=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
 let root=null,selected='',busy=false,error='',phase='',token=0;
 let skipReason='',remainingReason='',lockState='idle',doorNotice='';
 let liveTimer=null,liveRead=null,liveBits=null,liveGeneration=0;
 const state=()=>getState();
 const targets=()=>getDoorTargets(state());
 const layoutMatches=()=>targets().length>0&&targets().join('')===getBoards().join('')&&getDoorMaster(state())===getMaster();
 const bank=()=>state().banks[selected];
 const mutable=()=>isActive()&&!busy&&layoutMatches();
 function changed(){onChange();paint();}
 function setBusy(value){busy=value;if(value)pauseLive();onBusy(value);paint();if(!value)scheduleLive();}
 function latest(){return state().banks[selected];}
 function showDoorNotice(message){
  doorNotice=message;
  const notice=root?.querySelector('#door-selection-notice');
  if(notice){
   notice.hidden=!message;
   notice.textContent=message;
   if(message)notice.scrollIntoView({block:'nearest'});
  }
 }
 function openDoors(){
  if(!liveBits)return [];
  return Array.from({length:16},(_,index)=>index+1).filter(door=>liveBits[16-door]==='1');
 }
 function closeNotice(doors){
  return `Close ${doors.length===1?'door':'doors'} ${doors.join(', ')} on column ${selected} before testing another door.`;
 }
 function inProgress(item){return !!item.command.open&&item.status==='testing';}
 function setupReady(data){
  return data.setup.connections==='original'||data.setup.connections==='changed'&&!!data.setup.note.trim();
 }
 function choose(value){
  if(!isActive()||!layoutMatches()||!targets().includes(value)||value===selected)return;
  const doors=openDoors();
  if(doors.length){showDoorNotice(closeNotice(doors));return;}
  if(inProgress(bank())){showDoorNotice(`Finish the answers for door ${bank().door} on column ${selected} first.`);return;}
  if(busy)return;
  pauseLive();selected=value;lockState='idle';error='';phase='';doorNotice='';skipReason='';paint();scheduleLive(0);
 }
 function nextBank(){const next=targets().find(value=>!['tested','skipped'].includes(state().banks[value].status));if(next)choose(next);else paint();}
 function sampleText(record){
  const item=doorTestSummary(state()).banks[selected];
  const rows=targets().filter(value=>item.changes[value]?.length).map(value=>`<li>Column ${value}: raw input${item.changes[value].length===1?'':'s'} ${item.changes[value].join(', ')}</li>`);
  return `<div class="door-evidence"><strong>Sensor changes observed during this attempt</strong>${rows.length?`<ul>${rows.join('')}</ul>`:'<p>No changes were captured in the available readings.</p>'}<small>Raw input numbers are recorded without assuming open/closed polarity. Short changes between reads can be missed.</small>${record.command.lockOff?`<p>Lock-off command: ${record.command.lockOff.status==='sent'?'transmitted':'not confirmed'}.</p>`:''}</div>`;
 }
 function answers(field,label,value){return `<fieldset id="door-question" class="door-answer" tabindex="-1"><legend>${label}</legend><div class="choices">${['yes','no','uncertain'].map(answer=>`<button class="choice ${value===answer?'selected':''}" data-door-answer="${field}:${answer}" aria-pressed="${value===answer}" ${busy?'disabled':''}>${answerLabel(answer)}</button>`).join('')}</div></fieldset>`;}
 function focusQuestion(){root?.querySelector('#door-question')?.focus();}
 function pauseLive(){
  if(liveTimer!==null)clearTimer(liveTimer);
  liveTimer=null;
  liveBits=null;
  liveGeneration++;
 }
 function canWatch(){return root&&isActive()&&layoutMatches()&&!busy&&!document.hidden&&usb.connected&&typeof usb.readLiveDoorInputs==='function';}
 function scheduleLive(delay=500){
  if(liveTimer!==null||liveRead||!canWatch())return;
  liveTimer=setTimer(readLive,delay);
 }
 async function readLive(){
  liveTimer=null;
  if(!canWatch())return;
  if(usb.busy){scheduleLive();return;}
  const board=selected,generation=liveGeneration;
  const reading=Promise.resolve().then(()=>generation===liveGeneration&&canWatch()?usb.readLiveDoorInputs(board):null);
  liveRead=reading;
  try{
   const bits=await reading;
   if(generation===liveGeneration&&canWatch()&&board===selected){
    liveBits=typeof bits==='string'&&/^[01]{16}$/.test(bits)?bits:null;
    updateWindows();
    if(liveBits&&doorNotice.startsWith('Close ')&&!openDoors().length)showDoorNotice('');
   }
  }catch{
   if(generation===liveGeneration){liveBits=null;updateWindows();}
  }finally{
   liveRead=null;
   scheduleLive();
  }
 }
 function windowState(door){
  if(usb.connected&&!document.hidden&&liveBits?.[16-door]==='1')return 'open';
  if(bank().door===door&&lockState==='uncertain')return 'uncertain';
  if(usb.connected&&!document.hidden&&bank().door===door&&lockState==='released')return 'released';
  return 'neutral';
 }
 function doorLabel(door,appearance){
  const labels={open:'sensor open',released:'release command active',uncertain:'lock state unknown',neutral:'no active release indication'};
  return `Column ${selected}, door ${door}, ${labels[appearance]}`;
 }
 function updateWindows(){
  if(!root||!isActive())return;
  for(const button of root.querySelectorAll('[data-door-number]')){
   const door=Number(button.dataset.doorNumber),appearance=windowState(door);
   button.setAttribute('aria-label',doorLabel(door,appearance));
   const light=root.querySelector(`[data-door-window="${door}"]`);
   for(const style of ['open','released','uncertain','neutral'])light?.classList.toggle(style,style===appearance);
  }
 }
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden){pauseLive();updateWindows();}
  else scheduleLive(0);
 });
 function doorPicker(record){
  const order=Array.from({length:8},(_,row)=>[row+1,row+9]).flat();
  const doors=order.map(door=>{
   const appearance=windowState(door),isSelected=record.door===door;
   return `<button type="button" class="locker-door ${isSelected?'selected':''}" data-door-number="${door}" aria-label="${doorLabel(door,appearance)}" aria-pressed="${isSelected}"><b>${door}</b><span class="locker-door-window ${appearance}" data-door-window="${door}" aria-hidden="true"></span></button>`;
  }).join('');
  return `<fieldset class="locker-picker"><legend>Doors on column ${selected}</legend><div class="locker-column"><div class="locker-column-header">COLUMN ${selected}</div><div class="locker-door-grid" aria-label="Column ${selected}: doors 1 to 8 down the left, 9 to 16 down the right">${doors}</div></div><div class="locker-window-legend"><span><i class="open"></i> Red: sensor open</span><span><i class="released"></i> Green: release active</span><span><i class="neutral"></i> Grey: no active release indication</span></div>${record.door?`<p class="locker-selection" role="status">Door ${record.door} selected</p>`:''}</fieldset>`;
 }
 function paint(){
  if(!root||!isActive())return;
  if(!layoutMatches()){root.innerHTML='<h1>The column layout needs confirmation.</h1><p>No door will open from this report. Start a new report with a confirmed locker layout.</p>';return;}
  if(!targets().includes(selected))selected=targets()[0];
  const data=state(),record=bank(),complete=doorTestsComplete(data),attempted=!!record.command.open;
  const hasCommands=targets().some(value=>!!data.banks[value].command.open||data.previous?.[value]?.some(item=>item.command.open));
  const done=['tested','skipped'].includes(record.status);
  root.innerHTML=`<h1>${data.scope==='board'?'Test a door<br>on board '+selected+'.':'Test one door<br>on each column.'}</h1><p class="lede">${data.scope==='board'?'This test covers board '+selected+' only. Click a closed door to start its test.':'Test at least one door on each installed column ('+targets().join(', ')+'). Click a closed door to start.'}</p>
   <details class="door-setup" ${!setupReady(data)?'open':''}><summary>Connections used for these door tests</summary><p>If you swapped cables earlier, record which connections are now fitted.</p><div class="choices"><button class="choice ${data.setup.connections==='original'?'selected':''}" data-door-setup="original" ${busy||hasCommands?'disabled':''}>Original connections are restored</button><button class="choice ${data.setup.connections==='changed'?'selected':''}" data-door-setup="changed" ${busy||hasCommands?'disabled':''}>Testing with changed connections</button></div>${data.setup.connections==='changed'?`<label class="field">Describe the changed connections<textarea id="door-setup-note" maxlength="1000" ${busy||hasCommands?'disabled':''}>${esc(data.setup.note)}</textarea></label>`:''}</details>
   <div class="door-bank-tabs" style="--door-columns:${targets().length}" aria-label="Columns to test">${targets().map(value=>`<button class="door-bank ${selected===value?'selected':''}" data-door-bank="${value}" aria-pressed="${selected===value}" ${busy?'disabled':''}><b>${value}${value===getMaster()?' · master':''}</b><span>${({pending:'Not tested',testing:'In progress',tested:'Result recorded',skipped:'Not completed'})[data.banks[value].status]}</span></button>`).join('')}</div>
   ${complete?'<div class="guide-status good"><div><strong>'+(data.scope==='board'?'The selected board has a recorded result.':'Every installed column has a recorded result.')+'</strong><p>Review the results below. Select Next for the final report. A recorded result can include an incomplete test.</p></div></div>':''}
   <section class="door-current" aria-label="Selected column door test"><h2>Column ${selected}${selected===getMaster()?' · master':''}</h2>
   <p id="door-selection-notice" class="report-error" role="alert" ${doorNotice?'':'hidden'}>${esc(doorNotice)}</p>
   ${busy?`<div class="guide-status waiting"><span class="guide-spinner" aria-hidden="true"></span><div><strong>${esc(phase||'Checking the selected column…')}</strong><p>Keep this page visible until the check finishes.</p></div></div><button class="secondary" id="door-stop">Stop this check</button>`:''}
   ${inProgress(record)&&!busy?`${record.operator.opened?`<p>Close door ${record.door} on column ${selected}. If it did not open, leave it closed.</p>${answers('closed','Is the door closed now?',record.operator.closed)}`:answers('opened','Did door '+record.door+' open?',record.operator.opened)}`:''}
   ${done?`<p>${record.status==='skipped'?'Not completed: '+esc(record.skipReason):`Door ${record.door}: opened ${answerLabel(record.operator.opened)}, closed ${answerLabel(record.operator.closed)}.`}</p>`:''}
   ${!attempted&&!busy?`<p>${setupReady(data)?'Click a closed door, then pull it open. The lock releases for up to 15 seconds.':'Record the connections above before starting a door test.'}</p>`:''}
   ${doorPicker(record)}
   ${attempted&&!busy?sampleText(record):''}
   ${!busy?`<details class="door-skip"><summary>I cannot complete this column test</summary><label class="field">Reason<textarea id="door-skip-reason" maxlength="1000" placeholder="For example: column does not reply, door inaccessible, or test interrupted.">${esc(skipReason)}</textarea></label><button class="secondary" id="door-skip" ${!skipReason.trim()?'disabled':''}>Record ${selected} as not completed</button></details>`:''}
   ${error?`<p class="report-error" role="alert">${esc(error)}</p>`:''}${!usb.connected&&!done?'<p class="door-help">USB is disconnected. Reconnect with the guide control below, or record why this test cannot be completed.</p>':''}</section>
   ${!complete&&!busy?`<details class="door-skip"><summary>I cannot complete the remaining column tests</summary><label class="field">Reason<textarea id="door-remaining-reason" maxlength="1000">${esc(remainingReason)}</textarea></label><button class="secondary" id="door-skip-remaining" ${!remainingReason.trim()?'disabled':''}>Record remaining tests as not completed</button></details>`:''}`;
  root.querySelectorAll('[data-door-bank]').forEach(element=>element.addEventListener('click',()=>choose(element.dataset.doorBank)));
  root.querySelectorAll('[data-door-setup]').forEach(element=>element.addEventListener('click',()=>{if(!mutable()||hasCommands)return;data.setup.connections=element.dataset.doorSetup;if(data.setup.connections==='original')data.setup.note='';changed();}));
  root.querySelector('#door-setup-note')?.addEventListener('input',event=>{if(!mutable())return;data.setup.note=event.target.value;onChange();});
  root.querySelectorAll('[data-door-number]').forEach(element=>element.addEventListener('click',()=>requestDoor(Number(element.dataset.doorNumber))));
  root.querySelector('#door-stop')?.addEventListener('click',stop);
  root.querySelectorAll('[data-door-answer]').forEach(element=>element.addEventListener('click',()=>{
   if(!mutable()||!inProgress(bank()))return;
   const [field,answer]=element.dataset.doorAnswer.split(':');
   if(field==='opened'){latest().operator.opened=answer;doorNotice='';changed();focusQuestion();}
   else if(field==='closed'&&latest().operator.opened)finishDoor(answer);
  }));
  root.querySelector('#door-skip-reason')?.addEventListener('input',event=>{skipReason=event.target.value;root.querySelector('#door-skip').disabled=!skipReason.trim();});
  root.querySelector('#door-skip')?.addEventListener('click',()=>{if(!mutable()||!skipReason.trim())return;record.status='skipped';record.skipReason=skipReason.trim();record.completedAt=timestamp();onEvent(`Column ${selected} door test not completed: ${record.skipReason}`);changed();nextBank();});
  root.querySelector('#door-remaining-reason')?.addEventListener('input',event=>{remainingReason=event.target.value;root.querySelector('#door-skip-remaining').disabled=!remainingReason.trim();});
  root.querySelector('#door-skip-remaining')?.addEventListener('click',()=>{if(!mutable()||!remainingReason.trim())return;for(const value of targets()){const item=data.banks[value];if(['tested','skipped'].includes(item.status))continue;item.status='skipped';item.skipReason=remainingReason.trim();item.completedAt=timestamp();onEvent(`Column ${value} door test not completed: ${item.skipReason}`);}changed();});
 }
 function storeSample(item,which,sample){
  const copy=structuredClone(sample);if(copy.error)copy.error=boundedError(copy.error);
  item.snapshots[which][sample.board]=copy;
  if(which!=='baseline')item.samples.push({phase:which,...copy});
  item.samples=item.samples.slice(-200);
  if(copy.board===selected)liveBits=copy.status==='responded'?copy.bits:null;
  onChange();updateWindows();
 }
 function requestDoor(door){
  if(!isActive()||document.hidden||!layoutMatches()||!Number.isInteger(door)||door<1||door>16)return;
  const doors=openDoors();
  if(doors.length){showDoorNotice(closeNotice(doors));return;}
  if(busy||inProgress(bank())){
   showDoorNotice(`Finish testing door ${bank().door} on column ${selected} before opening another door.`);
   return;
  }
  if(!setupReady(state())){showDoorNotice('Record the connections above before starting a door test.');return;}
  if(!usb.connected){showDoorNotice('Connect the locker USB port before testing a door.');return;}
  if(usb.activationBlocked){showDoorNotice(usb.activationBlockReason||'Check the previous lock-off before testing another door.');return;}
  if(state().previous?.[selected]?.length>=16&&['tested','skipped'].includes(bank().status)){
   showDoorNotice('Save this report and start a new test to record more doors on this column.');
   return;
  }
  openDoor(door);
 }
 async function openDoor(door){
  const data=state(),ownBank=selected,ownToken=++token;
  const previousDoors={};
  for(const board of targets()){
   const prior=[...(data.previous?.[board]||[]),data.banks[board]].findLast(item=>item.command.open);
   if(prior)previousDoors[board]={door:prior.door,closureUncertain:prior.operator.closed!=='yes'};
  }
  const previous=bank();
  if(['tested','skipped'].includes(previous.status)){
   data.previous||={};
   (data.previous[ownBank]||=[]).push(previous);
  }
  const item={...freshBankDoorTest(),door,status:'testing',startedAt:timestamp()};
  data.banks[ownBank]=item;
  error='';doorNotice='';phase='';lockState='idle';
  setBusy(true);
  onEvent(`Operator clicked door ${door} on column ${ownBank} to start its test.`);
  try{
   if(liveRead)await liveRead;
   if(ownToken!==token||!isActive()||state()!==data||document.hidden||!usb.connected)return;
   await usb.openDoorTest(ownBank,item.door,{
    previousDoors,
    shouldContinue:()=>ownToken===token&&isActive()&&state()===data,
    onPhase:text=>{phase=text;paint();},
    onSample:(which,sample)=>storeSample(item,which,sample),
    onLockState:value=>{lockState=['released','door-open'].includes(value)?'released':value==='uncertain'?'uncertain':'off';updateWindows();},
    onCommand:evidence=>{if(evidence.releaseMode)onEvent(`Column ${ownBank}, door ${item.door}: release limit ${evidence.durationMs} ms; matching input ${item.door}, 1=open, 0=closed; relock reason ${evidence.relockReason||'not confirmed'}.`);lockState=evidence.offSent&&evidence.code!=='LOCK_OFF'?'off':'uncertain';const rejected=evidence.code==='CONTROLLER',openOk=evidence.openSent&&!rejected,offOk=evidence.offSent&&evidence.code!=='LOCK_OFF';item.command.open=evidence.openAttempted?{status:openOk?'sent':'uncertain',at:evidence.openAt||evidence.at||timestamp(),code:openOk?'':evidence.code||'',error:openOk?'':boundedError(evidence.error),raw:evidence.openCommand||''}:null;item.command.lockOff=evidence.offAttempted||evidence.offSent?{status:offOk?'sent':'uncertain',at:evidence.offAt||evidence.at||timestamp(),code:offOk?'':evidence.code||'',error:offOk?'':boundedError(evidence.error||'Lock-off transmission was not confirmed.'),raw:evidence.offCommand||''}:null;onChange();},
   });
  }catch(cause){error=cause.message||String(cause);onEvent(`Column ${ownBank} door check incomplete: ${error}`);}
  finally{phase='';setBusy(false);onChange();if(item.command.open)focusQuestion();}
 }
 async function finishDoor(answer){
  const item=bank(),data=state(),ownToken=++token;
  error='';doorNotice='';phase='Recording the closing result…';
  let advanceColumn=false;
  setBusy(true);
  try{
   if(liveRead)await liveRead;
   if(ownToken!==token||!isActive()||state()!==data)return;
   if(usb.connected&&!document.hidden){
    await usb.readDoorTestInputs(selected,{shouldContinue:()=>ownToken===token&&isActive()&&state()===data,onSample:sample=>storeSample(item,'closed',sample)});
   }
  }catch(cause){error=cause.message||String(cause);onEvent('Closed-input check incomplete: '+error);}
  finally{
   if(ownToken===token&&isActive()&&state()===data){
    item.operator.closed=answer;
    item.status='tested';
    item.completedAt=timestamp();
    onEvent(`Column ${selected}, door ${item.door}: operator opened=${item.operator.opened}, closed=${answer}`);
    const doors=openDoors();
    if(doors.length)doorNotice=closeNotice(doors);
    else if(answer==='yes'&&!error)advanceColumn=true;
   }
   phase='';setBusy(false);onChange();
  }
  if(advanceColumn)nextBank();
 }
 function stop(){pauseLive();token++;usb.stopDoorTest?.();if(busy){error='The check was stopped. Do not repeat the opening automatically. Record what happened or mark this column as not completed.';onEvent('Operator stopped the door check.');paint();}}
 return {render(element){root=element;if(!canWatch()&&!busy)pauseLive();paint();scheduleLive(0);},pauseLive,stop,get busy(){return busy;},reset(){stop();root=null;selected='';error='';phase='';doorNotice='';lockState='idle';skipReason='';remainingReason='';}};
}
