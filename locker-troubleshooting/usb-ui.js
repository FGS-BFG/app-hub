import {SerialTransport} from './serial.js?v=20261118-doors';

const BOARDS=['A','B','C','D','E'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const stamp=()=>new Date().toISOString();
export function changedInputs(previous,bits){return typeof previous==='string'&&typeof bits==='string'&&/^[01]{16}$/.test(previous)&&/^[01]{16}$/.test(bits)?Array.from({length:16},(_,i)=>i+1).filter(n=>previous[16-n]!==bits[16-n]):[];}
export function mountUsbPanel(root,{saved={},onSave=()=>{},onConnection=()=>{},onBusy=()=>{},onScanRequested=null}={}){
 let transport=null,connecting=false,disconnecting=false,disconnectTask=null,operation=false,monitoring=false,monitorToken=0,token=0,intentionalClose=false,doorStop=false;
 let data={boards:{},events:[],observations:[],checks:[],...saved};
 for(const key of ['events','observations','checks'])if(!Array.isArray(data[key]))data[key]=[];
 if(!data.boards||typeof data.boards!=='object')data.boards={};
 data.connected=false;data.lastBits||={};
 let message='Connect the locker USB cable to this computer, then select its COM port.';
 let lastError='',lastConnected=false,controlsEnabled=true;
 const supported=!!navigator.serial&&window.isSecureContext;
 root.innerHTML=`<section class="usb-panel" aria-labelledby="usb-title"><div class="usb-heading"><div><span class="sidebar-title">LIVE LOCKER CONNECTION</span><h2 id="usb-title">Check the locker over USB</h2></div><span id="usb-badge" class="usb-badge">Disconnected</span></div><p id="usb-compatibility">${supported?'Use this page in desktop Chrome or Edge. Close Phil’s app and the FGS tester before connecting; only one application can use the COM port.':'Open this page in desktop Chrome or Edge to use USB serial. This browser does not provide access to the locker COM port.'}</p><div class="usb-controls"><button class="primary" id="usb-connect">Connect locker USB</button><button class="secondary" id="usb-disconnect" disabled>Disconnect</button><button class="secondary" id="usb-scan" disabled>Check all five boards</button><button class="secondary" id="usb-monitor" disabled>Watch sensor inputs</button></div><label class="usb-watch-label">Watch inputs on <select id="usb-monitor-board"><option value="all">All five boards</option><option value="A">Board A</option><option value="B">Board B</option><option value="C">Board C</option><option value="D">Board D</option><option value="E">Board E</option></select></label><p id="usb-message" role="status"></p><p id="usb-error" class="usb-error" role="alert"></p><div class="usb-settings">9600 baud · 8N1 · master C · USB evidence is included when you save a report</div><details id="usb-live-details"><summary>Board replies, sensor inputs and USB log</summary><p class="usb-help">Inputs 1–16 show the raw electrical value. A reply confirms communication. Input changes are observations; they do not identify a faulty component.</p><div id="usb-board-list"></div><div class="usb-log-header"><strong>Recent observations</strong><button class="text-button" id="usb-mark">Add observation marker</button></div><ul id="usb-observations" class="usb-observations"></ul><details><summary>Raw USB traffic</summary><pre id="usb-log" class="usb-log" aria-label="Raw USB traffic"></pre></details></details></section>`;
 const $=q=>root.querySelector(q);
 function persist(){onSave(structuredClone(data));}
 function event(e){data.events.push({...e,at:e.at||stamp()});data.events=data.events.slice(-2000);if(e.type==='error'||e.type==='warning'){data.observations.push({at:e.at||stamp(),message:e.message||e.raw||e.code||'USB message'});data.observations=data.observations.slice(-120);}persist();paintLog();}
 function observe(text){data.observations.push({at:stamp(),message:text});data.observations=data.observations.slice(-120);persist();paintLog();}
 function paintLog(){
  $('#usb-log').textContent=data.events.slice(-70).map(e=>`${e.at} ${e.type.toUpperCase()} ${e.command||''} ${e.raw!==undefined?JSON.stringify(e.raw):e.message||e.code||''}`).join('\n')||'No USB traffic recorded.';
  $('#usb-observations').innerHTML=data.observations.slice(-8).reverse().map(e=>`<li><time>${esc(e.at.slice(11,19))}</time> ${esc(e.message)}</li>`).join('')||'<li>No observations recorded.</li>';
 }
 function paint(){
  const connected=!!transport?.connected,busy=connecting||disconnecting||operation||!!transport?.busy;
  $('#usb-badge').textContent=connecting?'Connecting…':monitoring?'Watching inputs':connected?'USB port open':'Disconnected';
  $('#usb-badge').classList.toggle('connected',connected);
  $('#usb-connect').disabled=!controlsEnabled||!supported||busy||connected;
  $('#usb-disconnect').disabled=!controlsEnabled||!connected||connecting||disconnecting||operation;
  $('#usb-scan').disabled=!controlsEnabled||!connected||busy||monitoring;
  $('#usb-monitor').disabled=!controlsEnabled||!connected||(!monitoring&&busy);
  $('#usb-monitor').textContent=monitoring?'Stop watching':'Watch sensor inputs';$('#usb-monitor-board').disabled=!controlsEnabled||busy||monitoring;
  $('#usb-message').textContent=message;$('#usb-error').textContent=lastError;
  $('#usb-board-list').innerHTML=BOARDS.map(b=>{const r=data.boards[b];return `<div class="usb-board"><div class="usb-board-heading"><strong>${b}${b==='C'?' · master':''}</strong><span>${r?esc(r.status==='responded'?'Reply received':r.status==='no-response'?'Reply timed out':'Check incomplete'):'Not checked'}</span><small>${r?esc(r.at.slice(11,19))+' · '+(r.elapsedMs??'—')+' ms':''}</small></div><div class="sensor-bits" aria-label="Board ${b} raw sensor inputs">${Array.from({length:16},(_,i)=>{const value=r?.status==='responded'?r.bits?.[15-i]:undefined;return `<span class="sensor-bit ${value==='1'?'one':value==='0'?'zero':''}" title="Input ${i+1}: ${value??'not read'}"><small>${i+1}</small><b>${value??'–'}</b></span>`;}).join('')}</div>${r?.error?`<p class="usb-board-error">${esc(r.error)}</p>`:''}</div>`;}).join('');paintLog();
 }
 function connectionChanged(state){data.connected=state.connected;persist();const error=intentionalClose?null:state.error;if(state.connected!==lastConnected||error){lastConnected=state.connected;onConnection({connected:state.connected,error});}onBusy(state.busy);if(error){lastError=error.message||'USB connection lost.';message='Reconnect the USB port before continuing. Incomplete checks are not board failures.';stopMonitor();}paint();}
 async function connect(){
  if(connecting||disconnecting||operation||monitoring||transport?.connected||transport?.busy)return;
  if(!supported){lastError='USB access requires desktop Chrome or Edge over HTTPS or localhost.';paint();return;}
  connecting=true;lastError='';message='Select the COM port connected to master C.';paint();onBusy(true);
  let candidate;
  try{const port=await navigator.serial.requestPort();candidate=new SerialTransport(port,{onEvent:event,onState:connectionChanged});transport=candidate;await candidate.open();message='USB port open. Follow the guide below to reset C and read the board inputs.';event({type:'info',message:'USB port opened at 9600 baud, 8N1. Opening a port is not a board reply.'});onConnection({connected:true});}
  catch(e){await candidate?.close().catch(()=>{});transport=null;if(e.name==='NotFoundError'){message='Port selection cancelled. No board was checked.';}else{lastError=e.message||String(e);message='Could not open the locker COM port. Close other locker applications and try again.';event({type:'error',code:e.code||e.name,message:lastError});}onConnection({connected:false,error:e.name==='NotFoundError'?null:{code:e.code||'PORT',message:lastError}});}
  finally{connecting=false;onBusy(false);paint();}
 }
 function stopMonitor(){monitoring=false;monitorToken++;onBusy(false);paint();}
 async function disconnect(intentional=true){
  if(disconnecting)return disconnectTask;
  const closingTransport=transport;
  disconnecting=true;intentionalClose=intentional;token++;stopMonitor();onBusy(true);paint();
  disconnectTask=(async()=>{
   try{await closingTransport?.close();}
   finally{
    intentionalClose=false;
    try{
     // A delayed close must never clear a newer port instance.
     if(transport===closingTransport){
      transport=null;data.connected=false;
      message='USB disconnected. Reconnect before sending further checks.';
      if(intentional)lastError='';
      observe(intentional?'Operator disconnected the USB COM port.':'USB device disconnected unexpectedly.');
      onConnection({connected:false,error:intentional?null:{code:'DISCONNECTED',message:'USB device disconnected unexpectedly.'}});
     }
    }finally{disconnecting=false;disconnectTask=null;onBusy(false);paint();}
   }
  })();
  return disconnectTask;
 }
 async function check(board){
  if(disconnecting||!transport?.connected)throw Object.assign(Error('Connect the locker USB port first.'),{code:'DISCONNECTED'});
  const started=Date.now();let result;
  try{const reply=await transport.query(board);const changes=changedInputs(data.lastBits[board],reply.bits);data.lastBits[board]=reply.bits;result={...reply,status:'responded'};
   if(changes.length)observe(`Board ${board}: input${changes.length===1?'':'s'} ${changes.join(', ')} changed since the previous valid read${changes.length>1?' — multiple input changes; compare with the physical action.':'.'}`);
  }catch(e){result={board,status:e.code==='TIMEOUT'?'no-response':'error',code:e.code||'UNKNOWN',error:e.message,at:stamp(),elapsedMs:Date.now()-started};observe(`Board ${board}: ${e.code==='TIMEOUT'?'no valid reply within the response timeout.':e.message}`);}
  data.boards[board]=result;data.checks.push(result);data.checks=data.checks.slice(-600);persist();paint();return result;
 }
 async function scan(boards=BOARDS,onResult=()=>{}){
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Error('Stop the current USB check before starting another.');
  operation=true;const mine=++token;lastError='';onBusy(true);paint();
  try{for(const board of boards){if(mine!==token||!transport?.connected)break;message=`Reading board ${board}…`;paint();const result=await check(board);await onResult(result);if(result.status==='error'&&['DISCONNECTED','WRITE','PORT'].includes(result.code))break;await delay(200);}message='Board check finished. Review each result below.';}
  finally{operation=false;onBusy(false);paint();}
 }
 async function reset(){
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Error('Stop the current USB check first.');
  if(!transport?.connected)throw Error('Connect the locker USB port first.');
  operation=true;onBusy(true);message='Sending RST to master C. Waiting for its five-second reset sequence…';lastError='';paint();
  try{const r=await transport.resetMaster();observe('RST#C transmitted; reset wait completed. The subsequent ISB check verifies communication.');message='Master reset command sent and reset wait completed. Run the board checks next.';return r;}
  catch(e){lastError=e.message;throw e;}
  finally{operation=false;onBusy(false);paint();}
 }
 function stopDoorTest(){doorStop=true;transport?.cancelDoorPulse?.().catch(error=>showError(error));}
 function beginDoorOperation(board){
  if(!BOARDS.includes(board))throw Error('Choose a column from A to E.');
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Error('Wait for the current USB check to finish.');
  if(!transport?.connected)throw Error('Connect the locker USB port first.');
  operation=true;doorStop=false;lastError='';onBusy(true);paint();return ++token;
 }
 async function openDoorTest(board,door,{shouldContinue=()=>true,onPhase=()=>{},onSample=()=>{},onCommand=()=>{}}={}){
  if(!Number.isInteger(door)||door<1||door>16)throw Error('Choose a door from 1 to 16.');
  if(transport?.activationBlocked)throw Error(transport.activationBlockReason||'Lock-off transmission was not confirmed. Stop opening doors and record the incomplete tests.');
  const mine=beginDoorOperation(board),canContinue=()=>mine===token&&!doorStop&&!document.hidden&&shouldContinue();
  const requireContinue=()=>{if(!canContinue())throw Object.assign(Error('Door check interrupted. No opening will be retried automatically.'),{code:'CANCELLED'});};
  const read=async(phase,value)=>{requireContinue();const result=await check(value);onSample(phase,result);return result;};
  try{
   onPhase('Recording the starting sensor inputs…');
   const first=await read('baseline',board);
   if(first.status!=='responded')throw Object.assign(Error('The selected column did not provide a valid starting reading. No opening command was sent.'),{code:'BASELINE'});
   for(const value of BOARDS.filter(value=>value!==board)){const result=await read('baseline',value);if(value==='C'&&result.status!=='responded')throw Object.assign(Error('Master C did not provide a valid starting reading. No opening command was sent.'),{code:'BASELINE'});}
   const latest=await read('baseline',board);
   if(latest.status!=='responded')throw Object.assign(Error('The selected column stopped replying before opening. No opening command was sent.'),{code:'BASELINE'});
   requireContinue();onPhase(`Opening door ${door} on ${board}…`);
   let evidence;
   const recordPulse=value=>{for(const sample of value.samples||[])onSample('open',sample);onCommand(value);};
   try{evidence=await transport.pulseDoor(board,door,{durationMs:500});recordPulse(evidence);}
   catch(error){if(error.evidence)recordPulse({...error.evidence,code:error.code||'OUTPUT',error:error.message});throw error;}
   if(evidence.cancelled)throw Object.assign(Error('The opening check was stopped. Record the physical result before continuing.'),{code:'CANCELLED'});
   requireContinue();onPhase('Keep the selected door open. Watching its column for 10 seconds…');
   const deadline=Date.now()+10000;
   do{const result=await read('open',board);if(result.status!=='responded')break;await delay(150);}while(Date.now()<deadline&&canContinue());
   requireContinue();onPhase('Checking the other columns for sensor changes…');
   for(const value of BOARDS.filter(value=>value!==board))await read('open',value);
   observe(`Column ${board}, door ${door}: opening and lock-off commands transmitted. Operator confirmation and raw sensor evidence are separate.`);
  }catch(error){lastError=error.message;observe(`Column ${board}, door ${door}: ${error.message}`);throw error;}
  finally{operation=false;onBusy(false);paint();}
 }
 async function readDoorTestInputs(board,{shouldContinue=()=>true,onSample=()=>{}}={}){
  const mine=beginDoorOperation(board);
  try{for(const value of [board,...BOARDS.filter(value=>value!==board)]){if(mine!==token||doorStop||document.hidden||!shouldContinue())throw Error('Closed-input check interrupted.');onSample(await check(value));}}
  finally{operation=false;onBusy(false);paint();}
 }
 async function toggleMonitor(){
  if(monitoring){stopMonitor();message='Input monitoring stopped.';paint();return;}
  if(connecting||disconnecting||operation||transport?.busy||!transport?.connected)return;
  monitoring=true;const mine=++monitorToken;const selected=$('#usb-monitor-board').value;const watchBoards=selected==='all'?BOARDS:[selected];onBusy(true);message='Watching raw sensor inputs. Operate one locker at a time and compare the changes.';$('#usb-live-details').open=true;paint();
  try{while(monitoring&&mine===monitorToken&&transport?.connected){for(const board of watchBoards){if(!monitoring||mine!==monitorToken||!transport?.connected)break;await check(board);await delay(500);}}}
  finally{if(mine===monitorToken)monitoring=false;onBusy(false);paint();}
 }
 $('#usb-connect').addEventListener('click',connect);
 $('#usb-disconnect').addEventListener('click',()=>disconnect());
 $('#usb-scan').addEventListener('click',()=>Promise.resolve(onScanRequested?onScanRequested():scan()).catch(showError));
 $('#usb-monitor').addEventListener('click',()=>toggleMonitor().catch(showError));
 $('#usb-mark').addEventListener('click',()=>observe('Operator marker — compare subsequent sensor readings with the physical locker action.'));
 function showError(e){lastError=e.message;paint();}
 navigator.serial?.addEventListener('disconnect',e=>{if((e.port||e.target)===transport?.port)disconnect(false).catch(showError);});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){stopMonitor();stopDoorTest();}});
 globalThis.addEventListener?.('pagehide',stopDoorTest);
 persist();paint();
 return {supported,get connected(){return!!transport?.connected;},get busy(){return connecting||disconnecting||operation||monitoring||!!transport?.busy;},get activationBlocked(){return!!transport?.activationBlocked;},get activationBlockReason(){return transport?.activationBlockReason||'';},get monitoring(){return monitoring;},connect,disconnect,check:async board=>{if(operation||monitoring||connecting||disconnecting)throw Error('Wait for the current USB check to finish.');return check(board);},scan,reset,openDoorTest,readDoorTestInputs,stopDoorTest,stopMonitor,showError,setControlsEnabled(value){controlsEnabled=!!value;paint();},snapshot:()=>structuredClone(data),clear(){data={boards:{},lastBits:{},connected:!!transport?.connected,events:[],observations:[],checks:[]};persist();paint();}};
}
