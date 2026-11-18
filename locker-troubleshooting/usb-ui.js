import {SerialTransport} from './serial.js?v=20261118-release15';

const BOARDS=['A','B','C','D','E'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const stamp=()=>new Date().toISOString();
export function changedInputs(previous,bits){return typeof previous==='string'&&typeof bits==='string'&&/^[01]{16}$/.test(previous)&&/^[01]{16}$/.test(bits)?Array.from({length:16},(_,i)=>i+1).filter(n=>previous[16-n]!==bits[16-n]):[];}
export function mountUsbPanel(root,{saved={},getBoards=()=>BOARDS,getMaster=()=> 'C',onSave=()=>{},onConnection=()=>{},onBusy=()=>{},onScanRequested=null}={}){
 let transport=null,connecting=false,disconnecting=false,disconnectTask=null,operation=false,monitoring=false,monitorToken=0,token=0,intentionalClose=false,doorStop=false;
 let connectedBoards=[];
 let discovery=null,lastDiscovery=null,singleBoardTarget=null;
 let liveDoorRead=null;
 let data={boards:{},events:[],observations:[],checks:[],...saved};
 for(const key of ['events','observations','checks'])if(!Array.isArray(data[key]))data[key]=[];
 if(!data.boards||typeof data.boards!=='object')data.boards={};
 data.connected=false;data.lastBits||={};
 let message='Connect the locker USB cable to this computer, then select its COM port.';
 let lastError='',lastConnected=false,controlsEnabled=true;
 const supported=!!navigator.serial&&window.isSecureContext;
 root.innerHTML=`<section class="usb-panel" aria-labelledby="usb-title"><div class="usb-heading"><div><span class="sidebar-title">LIVE LOCKER CONNECTION</span><h2 id="usb-title">Check the locker over USB</h2></div><span id="usb-badge" class="usb-badge">Disconnected</span></div><p id="usb-compatibility">${supported?'Use this page in desktop Chrome or Edge. Close the parkIT app before connecting; only one application can use the COM port.':'Open this page in desktop Chrome or Edge to use USB serial. This browser does not provide access to the locker COM port.'}</p><div class="usb-controls"><button class="primary" id="usb-connect">Connect locker USB</button><button class="secondary" id="usb-disconnect" disabled>Disconnect</button><button class="secondary" id="usb-scan" disabled>Check installed boards</button><button class="secondary" id="usb-monitor" disabled>Watch sensor inputs</button></div><label class="usb-watch-label">Watch inputs on <select id="usb-monitor-board"><option value="all">All installed boards</option></select></label><p id="usb-message" role="status"></p><p id="usb-error" class="usb-error" role="alert"></p><div class="usb-settings" id="usb-settings"></div><details id="usb-live-details"><summary>Board replies, sensor inputs and USB log</summary><p class="usb-help">Inputs 1–16 show the raw electrical value. A reply confirms communication. Input changes are observations; they do not identify a faulty component.</p><div id="usb-board-list"></div><div class="usb-log-header"><strong>Recent observations</strong><button class="text-button" id="usb-mark">Add observation marker</button></div><ul id="usb-observations" class="usb-observations"></ul><details><summary>Raw USB traffic</summary><pre id="usb-log" class="usb-log" aria-label="Raw USB traffic"></pre></details></details></section>`;
 const $=q=>root.querySelector(q);
 function activeBoards(){const requested=getBoards();return Array.isArray(requested)?BOARDS.filter(board=>requested.includes(board)):[];}
 function operationBoards(){return singleBoardTarget?[singleBoardTarget]:activeBoards();}
 function activeMaster(){const master=getMaster();return BOARDS.includes(master)&&activeBoards().includes(master)?master:null;}
 function requireBoard(board){if(!operationBoards().includes(board))throw Object.assign(Error('This board is not part of the selected test scope.'),{code:'LAYOUT'});}
 function requireCurrentMaster(){const master=activeMaster();if(!master||transport?.masterBoard!==master||connectedBoards.join('')!==activeBoards().join(''))throw Object.assign(Error('The USB connection does not match the selected master and columns. Reconnect using the correct locker layout.'),{code:'LAYOUT'});return master;}
 function refreshLayout(){const select=$('#usb-monitor-board'),previous=select.value,targets=operationBoards();select.innerHTML=`<option value="all">${singleBoardTarget?'Selected board only':'All installed boards'}</option>`+targets.map(board=>`<option value="${board}">Board ${board}</option>`).join('');select.value=targets.includes(previous)?previous:'all';paint();}
 function persist(){onSave(structuredClone(data));}
 function event(e){if(liveDoorRead&&transport?.connected)return;data.events.push({...e,...(discovery?{stage:'discovery'}:{}),at:e.at||stamp()});data.events=data.events.slice(-2000);if(e.type==='error'||e.type==='warning'){data.observations.push({at:e.at||stamp(),message:e.message||e.raw||e.code||'USB message'});data.observations=data.observations.slice(-120);}persist();paintLog();}
 function observe(text){data.observations.push({at:stamp(),message:text});data.observations=data.observations.slice(-120);persist();paintLog();}
 function paintLog(){
  $('#usb-log').textContent=data.events.slice(-70).map(e=>`${e.at} ${e.type.toUpperCase()} ${e.command||''} ${e.raw!==undefined?JSON.stringify(e.raw):e.message||e.code||''}`).join('\n')||'No USB traffic recorded.';
  $('#usb-observations').innerHTML=data.observations.slice(-8).reverse().map(e=>`<li><time>${esc(e.at.slice(11,19))}</time> ${esc(e.message)}</li>`).join('')||'<li>No observations recorded.</li>';
 }
 function paint(){
  const connected=!!transport?.connected,busy=connecting||disconnecting||operation||!!transport?.busy;
  $('#usb-badge').textContent=connecting?'Connecting…':monitoring?'Watching inputs':connected?'USB port open':'Disconnected';
  $('#usb-badge').classList.toggle('connected',connected);
  $('#usb-connect').disabled=!controlsEnabled||!supported||busy||connected||!activeMaster();
  $('#usb-disconnect').disabled=!controlsEnabled||!connected||connecting||disconnecting||operation;
  $('#usb-scan').disabled=!controlsEnabled||!connected||busy||monitoring||!activeBoards().length;
  $('#usb-monitor').disabled=!controlsEnabled||!connected||(!monitoring&&busy)||!activeBoards().length;
  $('#usb-monitor').textContent=monitoring?'Stop watching':'Watch sensor inputs';$('#usb-monitor-board').disabled=!controlsEnabled||busy||monitoring;
  $('#usb-message').textContent=message;$('#usb-error').textContent=lastError;
  $('#usb-settings').textContent=`9600 baud · 8N1 · ${singleBoardTarget?`single board ${singleBoardTarget}; locker master ${activeMaster()||'not selected'} not confirmed`:`master ${activeMaster()||'not selected'}`} · USB evidence is included when you save a report`;
  $('#usb-board-list').innerHTML=operationBoards().map(b=>{const r=data.boards[b];return `<div class="usb-board"><div class="usb-board-heading"><strong>${b}${!singleBoardTarget&&b===activeMaster()?' · master':''}</strong><span>${r?esc(r.status==='responded'?'Reply received':r.status==='no-response'?'Reply timed out':'Check incomplete'):'Not checked'}</span><small>${r?esc(r.at.slice(11,19))+' · '+(r.elapsedMs??'—')+' ms':''}</small></div><div class="sensor-bits" aria-label="Board ${b} raw sensor inputs">${Array.from({length:16},(_,i)=>{const value=r?.status==='responded'?r.bits?.[15-i]:undefined;return `<span class="sensor-bit ${value==='1'?'one':value==='0'?'zero':''}" title="Input ${i+1}: ${value??'not read'}"><small>${i+1}</small><b>${value??'–'}</b></span>`;}).join('')}</div>${r?.error?`<p class="usb-board-error">${esc(r.error)}</p>`:''}</div>`;}).join('');paintLog();
 }
 function connectionChanged(state){if(liveDoorRead&&state.connected===lastConnected&&!state.error)return;data.connected=state.connected;persist();const error=intentionalClose?null:state.error;if(state.connected!==lastConnected||error){lastConnected=state.connected;onConnection({connected:state.connected,error});}onBusy(state.busy);if(error){lastError=error.message||'USB connection lost.';message='Reconnect the USB port before continuing. Incomplete checks are not board failures.';stopMonitor();}paint();}
 async function connect(){
  if(connecting||disconnecting||operation||monitoring||transport?.connected||transport?.busy)return;
  if(!supported){lastError='USB access requires desktop Chrome or Edge over HTTPS or localhost.';paint();return;}
  const targets=activeBoards(),master=activeMaster();if(!master){lastError='The selected locker layout has not been confirmed. No USB checks are available.';paint();return;}
  connecting=true;lastError='';message=`Select the COM port connected to master ${master}.`;paint();onBusy(true);
  let candidate;
  try{const port=await navigator.serial.requestPort();if(master!==activeMaster()||targets.join('')!==activeBoards().join(''))throw Error('The locker layout changed during port selection. Choose the port again.');candidate=new SerialTransport(port,{masterBoard:master,onEvent:event,onState:connectionChanged});transport=candidate;connectedBoards=[...targets];await candidate.open();requireCurrentMaster();message=singleBoardTarget?`USB port open for single board ${singleBoardTarget}. Read its inputs before the door test.`:`USB port open. Follow the guide below to reset ${master} and read the board inputs.`;event({type:'info',message:`USB port opened at 9600 baud, 8N1 for master ${master}. Opening a port is not a board reply.`});onConnection({connected:true});}
  catch(e){await candidate?.close().catch(()=>{});transport=null;connectedBoards=[];if(e.name==='NotFoundError'){message='Port selection cancelled. No board was checked.';}else{lastError=e.message||String(e);message='Could not open the locker COM port. Close the parkIT app and try again.';event({type:'error',code:e.code||e.name,message:lastError});}onConnection({connected:false,error:e.name==='NotFoundError'?null:{code:e.code||'PORT',message:lastError}});}
  finally{connecting=false;onBusy(false);paint();}
 }
 function stopMonitor(){monitoring=false;monitorToken++;onBusy(false);paint();}
 async function disconnect(intentional=true){
  if(disconnecting)return disconnectTask;
  stopDiscovery();lastDiscovery=null;
  const closingTransport=transport;
  disconnecting=true;intentionalClose=intentional;token++;stopMonitor();onBusy(true);paint();
  disconnectTask=(async()=>{
   try{await closingTransport?.close();}
   finally{
    intentionalClose=false;
    try{
     // A delayed close must never clear a newer port instance.
     if(transport===closingTransport){
      transport=null;connectedBoards=[];data.connected=false;
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
 function stopDiscovery(){
  if(!discovery)return Promise.resolve([]);
  discovery.stopped=true;
  return discovery.done;
 }
 function requireDiscoveryContext(run){
  if(run.stopped||run.token!==token||document.hidden)throw Object.assign(Error('The board address check was stopped.'),{code:'CANCELLED'});
  if(disconnecting||transport!==run.transport||!run.transport.connected)throw Object.assign(Error('The USB connection changed during the board address check.'),{code:'DISCONNECTED'});
  if(run.master!==activeMaster()||run.boards!==activeBoards().join('')||singleBoardTarget)throw Object.assign(Error('The locker context changed during the board address check. Repeat it for the selected layout.'),{code:'LAYOUT'});
 }
 function discoveryReply(board,reply,started){
  const raw=typeof reply?.raw==='string'?reply.raw:'';
  const frames=[...raw.matchAll(/<([A-E])>\s*Ex\(BIN\)\s*:\s*([01]{8})\s*:\s*([01]{8})(?=\s*(?:<[A-E]>|[~\r\n]|$))/gi)];
  if(reply?.board!==board||reply.status!==undefined&&reply.status!=='responded'||typeof reply.bits!=='string'||!/^[01]{16}$/.test(reply.bits)||!frames.some(frame=>frame[1].toUpperCase()===board&&frame[2]+frame[3]===reply.bits)){
   throw Object.assign(Error(`No valid addressed input-status reply from ${board} was received during discovery.`),{code:'PROTOCOL',raw});
  }
  return{board,status:'responded',bits:reply.bits,raw:raw.slice(-1024),at:typeof reply.at==='string'&&Number.isFinite(Date.parse(reply.at))?new Date(reply.at).toISOString():stamp(),elapsedMs:Number.isFinite(reply.elapsedMs)&&reply.elapsedMs>=0?reply.elapsedMs:Date.now()-started,stage:'discovery'};
 }
 async function discoverBoards(){
  if(singleBoardTarget)throw Object.assign(Error('Discovery cannot widen an adopted single-board test. Start a new report to choose another board.'),{code:'SCOPE'});
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Object.assign(Error('Wait for the current USB check to finish before discovering boards.'),{code:'BUSY'});
  if(!transport?.connected)throw Object.assign(Error('Connect the locker USB port before discovering boards.'),{code:'DISCONNECTED'});
  const master=requireCurrentMaster(),results=[];
  let finish;
  const run={transport,master,boards:activeBoards().join(''),token:++token,stopped:false,done:new Promise(resolve=>{finish=resolve;})};
  discovery=run;lastDiscovery=null;operation=true;lastError='';message='Checking board addresses A–E over USB…';onBusy(true);paint();
  try{
   for(const board of BOARDS){
    requireDiscoveryContext(run);
    const started=Date.now();let result;
    try{result=discoveryReply(board,await run.transport.query(board),started);}
    catch(error){result={board,status:error?.code==='TIMEOUT'?'no-response':'error',code:typeof error?.code==='string'?error.code.slice(0,80):'DISCOVERY',error:String(error?.message||error).slice(0,1000),raw:typeof error?.raw==='string'?error.raw.slice(-1024):'',at:stamp(),elapsedMs:Date.now()-started,stage:'discovery'};}
    results.push(result);data.checks.push(result);data.checks=data.checks.slice(-600);
    event({type:result.status==='responded'?'info':'warning',...result,command:'ISB#'+board,message:`Discovery ${board}: ${result.status}${result.error?' — '+result.error:''}`});
    requireDiscoveryContext(run);
    if(result.status==='error'&&['DISCONNECTED','WRITE','PORT'].includes(result.code))throw Object.assign(Error(result.error),{code:result.code});
   }
   lastDiscovery={transport:run.transport,master:run.master,boards:run.boards,results:structuredClone(results)};
   message='Board address check complete. Valid replies: '+(results.filter(result=>result.status==='responded').map(result=>result.board).join(', ')||'none')+'.';
   return structuredClone(results);
  }catch(error){
   if(error.code!=='CANCELLED')lastError=error.message;
   message='Board address check stopped. Captured evidence remains in the USB log.';
   error.results=structuredClone(results);throw error;
  }finally{
   if(discovery===run)discovery=null;
   operation=false;onBusy(false);paint();finish(structuredClone(results));
  }
 }
 function adoptSingleBoard(board){
  if(!BOARDS.includes(board))throw Object.assign(Error('Choose a discovered board letter from A to E.'),{code:'LAYOUT'});
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Object.assign(Error('Wait for the current USB check to finish before choosing a board.'),{code:'BUSY'});
  if(!transport?.connected)throw Object.assign(Error('Connect the USB port before choosing the detected board.'),{code:'DISCONNECTED'});
  const master=requireCurrentMaster();
  if(singleBoardTarget){
   if(singleBoardTarget!==board)throw Object.assign(Error('This report is already scoped to another detected board. Start a new report to change it.'),{code:'SCOPE'});
   return singleBoardTarget;
  }
  if(!lastDiscovery||lastDiscovery.transport!==transport||lastDiscovery.master!==master||lastDiscovery.boards!==activeBoards().join('')||!lastDiscovery.results.some(result=>result.board===board&&result.status==='responded'))throw Object.assign(Error('Complete a valid board address check before selecting this board.'),{code:'DISCOVERY'});
  singleBoardTarget=board;refreshLayout();
  event({type:'info',stage:'discovery',board,message:`Single-board test selected for ${board}. Expected locker master ${master} remains unconfirmed.`});
  return singleBoardTarget;
 }
 function clear(){
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Object.assign(Error('Wait for USB activity to finish before clearing this test.'),{code:'BUSY'});
  if(singleBoardTarget&&transport?.connected)throw Object.assign(Error('Disconnect the single-board test before starting a fresh report.'),{code:'SCOPE'});
  if(!transport?.connected)singleBoardTarget=null;
  lastDiscovery=null;
  data={boards:{},lastBits:{},connected:!!transport?.connected,events:[],observations:[],checks:[]};persist();refreshLayout();
 }
 async function check(board){
  requireBoard(board);
  if(disconnecting||!transport?.connected)throw Object.assign(Error('Connect the locker USB port first.'),{code:'DISCONNECTED'});
  requireCurrentMaster();
  const started=Date.now();let result;
  try{const reply=await transport.query(board);const changes=changedInputs(data.lastBits[board],reply.bits);data.lastBits[board]=reply.bits;result={...reply,status:'responded'};
   if(changes.length)observe(`Board ${board}: input${changes.length===1?'':'s'} ${changes.join(', ')} changed since the previous valid read${changes.length>1?' — multiple input changes; compare with the physical action.':'.'}`);
  }catch(e){result={board,status:e.code==='TIMEOUT'?'no-response':'error',code:e.code||'UNKNOWN',error:e.message,at:stamp(),elapsedMs:Date.now()-started};observe(`Board ${board}: ${e.code==='TIMEOUT'?'no valid reply within the response timeout.':e.message}`);}
  data.boards[board]=result;data.checks.push(result);data.checks=data.checks.slice(-600);persist();paint();return result;
 }
 async function publicCheck(board){
  if(operation||monitoring||connecting||disconnecting||transport?.busy)throw Object.assign(Error('Wait for the current USB check to finish.'),{code:'BUSY'});
  operation=true;onBusy(true);paint();
  try{return await check(board);}
  finally{operation=false;onBusy(false);paint();}
 }
 // Preview readings use the same serial lock, without filling the report log.
 async function readLiveDoorInputs(board){
  if(document.hidden||operation||monitoring||connecting||disconnecting||transport?.busy||!transport?.connected)return null;
  requireBoard(board);
  requireCurrentMaster();
  const source=transport;
  operation=true;
  liveDoorRead=source;
  onBusy(true);
  try{
   const reply=await source.query(board);
   if(source!==transport||!source.connected||document.hidden)return null;
   requireBoard(board);
   requireCurrentMaster();
   return reply.board===board&&/^[01]{16}$/.test(reply.bits)?reply.bits:null;
  }catch{
   return null;
  }finally{
   liveDoorRead=null;
   operation=false;
   onBusy(false);
  }
 }
 async function scan(boards=operationBoards(),onResult=()=>{}){
  if(!Array.isArray(boards)||!boards.length||new Set(boards).size!==boards.length)throw Error('Choose the installed boards for this check.');
  boards.forEach(requireBoard);boards=[...boards];
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Error('Stop the current USB check before starting another.');
  operation=true;const mine=++token;lastError='';onBusy(true);paint();
  try{for(const board of boards){if(mine!==token||!transport?.connected)break;message=`Reading board ${board}…`;paint();const result=await check(board);await onResult(result);if(result.status==='error'&&['DISCONNECTED','WRITE','PORT'].includes(result.code))break;await delay(200);}message='Board check finished. Review each result below.';}
  finally{operation=false;onBusy(false);paint();}
 }
 async function reset(){
  if(singleBoardTarget)throw Object.assign(Error('Master reset is unavailable while testing one detected board.'),{code:'SCOPE'});
  const master=requireCurrentMaster();requireBoard(master);
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Error('Stop the current USB check first.');
  if(!transport?.connected)throw Error('Connect the locker USB port first.');
  operation=true;onBusy(true);message=`Sending RST to master ${master}. Waiting for its five-second reset sequence…`;lastError='';paint();
  try{const r=await transport.resetMaster();observe(`RST#${master} transmitted; reset wait completed. The subsequent ISB check verifies communication.`);message='Master reset command sent and reset wait completed. Run the board checks next.';return r;}
  catch(e){lastError=e.message;throw e;}
  finally{operation=false;onBusy(false);paint();}
 }
 function stopDoorTest(){doorStop=true;transport?.cancelDoorPulse?.().catch(error=>showError(error));}
 function beginDoorOperation(board){
  requireBoard(board);requireCurrentMaster();
  if(connecting||disconnecting||operation||monitoring||transport?.busy)throw Error('Wait for the current USB check to finish.');
  if(!transport?.connected)throw Error('Connect the locker USB port first.');
  operation=true;doorStop=false;lastError='';onBusy(true);paint();return ++token;
 }
 async function openDoorTest(board,door,{shouldContinue=()=>true,onPhase=()=>{},onSample=()=>{},onCommand=()=>{},onLockState=()=>{},previousDoors={}}={}){
  if(!Number.isInteger(door)||door<1||door>16)throw Error('Choose a door from 1 to 16.');
  if(transport?.activationBlocked)throw Error(transport.activationBlockReason||'Lock-off transmission was not confirmed. Stop opening doors and record the incomplete tests.');
  const targets=operationBoards(),master=activeMaster(),mine=beginDoorOperation(board),canContinue=()=>mine===token&&!doorStop&&!document.hidden&&shouldContinue()&&targets.join('')===operationBoards().join('')&&master===activeMaster();
  const requireContinue=()=>{if(!canContinue())throw Object.assign(Error('Door check interrupted. No opening will be retried automatically.'),{code:'CANCELLED'});};
  const read=async(phase,value)=>{requireContinue();const result=await check(value);onSample(phase,result);return result;};
  try{
   onPhase('Recording the starting sensor inputs…');
   const first=await read('baseline',board);
   if(first.status!=='responded')throw Object.assign(Error('The selected column did not provide a valid starting reading. No opening command was sent.'),{code:'BASELINE'});
   for(const value of targets.filter(value=>value!==board)){
    const result=await read('baseline',value);
    if(value===master&&result.status!=='responded')throw Object.assign(Error(`Master ${master} did not provide a valid starting reading. No opening command was sent.`),{code:'BASELINE'});
    const previous=previousDoors[value];
    if(previous&&result.status!=='responded'&&previous.closureUncertain){
     throw Object.assign(Error(`Check that door ${previous.door} on column ${value} is closed and restore its connection before testing another door.`),{code:'BASELINE'});
    }
    if(previous&&result.status==='responded'&&result.bits[16-previous.door]==='1'){
     throw Object.assign(Error(`Close door ${previous.door} on column ${value} before testing another door.`),{code:'DOOR_OPEN'});
    }
   }
   const latest=await read('baseline',board);
   if(latest.status!=='responded')throw Object.assign(Error('The selected column stopped replying before opening. No opening command was sent.'),{code:'BASELINE'});
   if(latest.bits[16-door]!=='0')throw Object.assign(Error(`The selected door sensor is not closed. Close door ${door} on column ${board} before trying again.`),{code:'BASELINE'});
   const alreadyOpen=Array.from({length:16},(_,index)=>index+1).filter(number=>latest.bits[16-number]==='1');
   if(alreadyOpen.length)throw Object.assign(Error(`Close ${alreadyOpen.length===1?'door':'doors'} ${alreadyOpen.join(', ')} on column ${board} before testing another door.`),{code:'DOOR_OPEN'});
   requireContinue();onPhase(`Releasing door ${door} on ${board} for up to 15 seconds. Open the door to relock sooner…`);
   let evidence;
   const seen=new Set(),sampleKey=sample=>JSON.stringify(sample),capture=sample=>{const key=sampleKey(sample);if(!seen.has(key)){seen.add(key);onSample('open',sample);}};
   const recordPulse=value=>{for(const sample of value.samples||[])capture(sample);onCommand(value);};
   try{evidence=await transport.pulseDoor(board,door,{durationMs:15000,untilOpen:true,onProgress:progress=>{if(progress.sample)capture(progress.sample);onLockState(progress.phase);}});recordPulse(evidence);}
   catch(error){if(error.evidence)recordPulse({...error.evidence,code:error.code||'OUTPUT',error:error.message});throw error;}
   if(evidence.cancelled)throw Object.assign(Error('The opening check was stopped. Record the physical result before continuing.'),{code:'CANCELLED'});
   requireContinue();onPhase('Keep the selected door open. Watching its column for 10 seconds…');
   const deadline=Date.now()+10000;
   do{const result=await read('open',board);if(result.status!=='responded')break;await delay(150);}while(Date.now()<deadline&&canContinue());
   requireContinue();onPhase('Checking the other columns for sensor changes…');
   for(const value of targets.filter(value=>value!==board))await read('open',value);
   observe(`Column ${board}, door ${door}: opening and lock-off commands transmitted. Operator confirmation and raw sensor evidence are separate.`);
  }catch(error){lastError=error.message;observe(`Column ${board}, door ${door}: ${error.message}`);throw error;}
  finally{operation=false;onBusy(false);paint();}
 }
 async function readDoorTestInputs(board,{shouldContinue=()=>true,onSample=()=>{}}={}){
  const targets=operationBoards(),master=activeMaster(),mine=beginDoorOperation(board);
  try{for(const value of [board,...targets.filter(value=>value!==board)]){if(mine!==token||doorStop||document.hidden||!shouldContinue()||targets.join('')!==operationBoards().join('')||master!==activeMaster())throw Error('Closed-input check interrupted.');onSample(await check(value));}}
  finally{operation=false;onBusy(false);paint();}
 }
 async function toggleMonitor(){
  if(monitoring){stopMonitor();message='Input monitoring stopped.';paint();return;}
  if(connecting||disconnecting||operation||transport?.busy||!transport?.connected)return;
  const targets=operationBoards(),selected=$('#usb-monitor-board').value;
  if(!targets.length)throw Error('The selected locker layout has not been confirmed.');
  if(selected!=='all')requireBoard(selected);
  monitoring=true;const mine=++monitorToken;const watchBoards=selected==='all'?targets:[selected];onBusy(true);message='Watching raw sensor inputs. Operate one locker at a time and compare the changes.';$('#usb-live-details').open=true;paint();
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
 document.addEventListener('visibilitychange',()=>{if(document.hidden){stopMonitor();stopDoorTest();stopDiscovery();}});
 globalThis.addEventListener?.('pagehide',()=>{stopDoorTest();stopDiscovery();});
 persist();refreshLayout();
 return {supported,get connected(){return!!transport?.connected;},get busy(){return connecting||disconnecting||operation||monitoring||!!transport?.busy;},get activationBlocked(){return!!transport?.activationBlocked;},get activationBlockReason(){return transport?.activationBlockReason||'';},get monitoring(){return monitoring;},get singleBoardTarget(){return singleBoardTarget;},connect,disconnect,discoverBoards,stopDiscovery,adoptSingleBoard,check:publicCheck,readLiveDoorInputs,scan,reset,refreshLayout,openDoorTest,readDoorTestInputs,stopDoorTest,stopMonitor,showError,setControlsEnabled(value){controlsEnabled=!!value;paint();},snapshot:()=>structuredClone(data),clear};
}
