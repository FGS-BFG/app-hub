import {SerialTransport} from './serial.js';

const BOARDS=['A','B','C','D','E'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const stamp=()=>new Date().toISOString();
export function changedInputs(previous,bits){return typeof previous==='string'&&typeof bits==='string'&&/^[01]{16}$/.test(previous)&&/^[01]{16}$/.test(bits)?Array.from({length:16},(_,i)=>i+1).filter(n=>previous[16-n]!==bits[16-n]):[];}
export function mountUsbPanel(root,{saved={},onSave=()=>{},onConnection=()=>{},onBusy=()=>{},onScanRequested=null}={}){
 let transport=null,connecting=false,operation=false,monitoring=false,monitorToken=0,token=0,intentionalClose=false;
 let data={boards:{},events:[],observations:[],checks:[],...saved};
 for(const key of ['events','observations','checks'])if(!Array.isArray(data[key]))data[key]=[];
 if(!data.boards||typeof data.boards!=='object')data.boards={};
 data.connected=false;data.lastBits||={};
 let message='Connect the locker USB cable to this computer, then select its COM port.';
 let lastError='',lastConnected=false;
 const supported=!!navigator.serial&&window.isSecureContext;
 root.innerHTML=`<section class="usb-panel" aria-labelledby="usb-title"><div class="usb-heading"><div><span class="sidebar-title">LIVE LOCKER CONNECTION</span><h2 id="usb-title">Check the locker over USB</h2></div><span id="usb-badge" class="usb-badge">Disconnected</span></div><p id="usb-compatibility">${supported?'Use this page in desktop Chrome or Edge. Close Phil’s app and the FGS tester before connecting; only one application can use the COM port.':'Open this page in desktop Chrome or Edge to use USB serial. This browser does not provide access to the locker COM port.'}</p><div class="usb-controls"><button class="primary" id="usb-connect">Connect locker USB</button><button class="secondary" id="usb-disconnect" disabled>Disconnect</button><button class="secondary" id="usb-scan" disabled>Check all five boards</button><button class="secondary" id="usb-monitor" disabled>Watch sensor inputs</button></div><label class="usb-watch-label">Watch inputs on <select id="usb-monitor-board"><option value="all">All five boards</option><option value="A">Board A</option><option value="B">Board B</option><option value="C">Board C</option><option value="D">Board D</option><option value="E">Board E</option></select></label><p id="usb-message" role="status"></p><p id="usb-error" class="usb-error" role="alert"></p><div class="usb-settings">9600 baud · 8N1 · master C · commands and logs stay on this device</div><details id="usb-live-details"><summary>Board replies, sensor inputs and USB log</summary><p class="usb-help">Inputs 1–16 show the raw electrical value. A reply confirms communication. Input changes are observations; they do not identify a faulty component.</p><div id="usb-board-list"></div><div class="usb-log-header"><strong>Recent observations</strong><button class="text-button" id="usb-mark">Add observation marker</button></div><ul id="usb-observations" class="usb-observations"></ul><details><summary>Raw USB traffic</summary><pre id="usb-log" class="usb-log" aria-label="Raw USB traffic"></pre></details></details></section>`;
 const $=q=>root.querySelector(q);
 function persist(){onSave(structuredClone(data));}
 function event(e){data.events.push({...e,at:e.at||stamp()});data.events=data.events.slice(-2000);if(e.type==='error'||e.type==='warning'){data.observations.push({at:e.at||stamp(),message:e.message||e.raw||e.code||'USB message'});data.observations=data.observations.slice(-120);}persist();paintLog();}
 function observe(text){data.observations.push({at:stamp(),message:text});data.observations=data.observations.slice(-120);persist();paintLog();}
 function paintLog(){
  $('#usb-log').textContent=data.events.slice(-70).map(e=>`${e.at} ${e.type.toUpperCase()} ${e.command||''} ${e.raw!==undefined?JSON.stringify(e.raw):e.message||e.code||''}`).join('\n')||'No USB traffic recorded.';
  $('#usb-observations').innerHTML=data.observations.slice(-8).reverse().map(e=>`<li><time>${esc(e.at.slice(11,19))}</time> ${esc(e.message)}</li>`).join('')||'<li>No observations recorded.</li>';
 }
 function paint(){
  const connected=!!transport?.connected,busy=connecting||operation||!!transport?.busy;
  $('#usb-badge').textContent=connecting?'Connecting…':monitoring?'Watching inputs':connected?'USB port open':'Disconnected';
  $('#usb-badge').classList.toggle('connected',connected);
  $('#usb-connect').disabled=!supported||busy||connected;
  $('#usb-disconnect').disabled=!connected||connecting;
  $('#usb-scan').disabled=!connected||busy||monitoring;
  $('#usb-monitor').disabled=!connected||(!monitoring&&busy);
  $('#usb-monitor').textContent=monitoring?'Stop watching':'Watch sensor inputs';$('#usb-monitor-board').disabled=busy||monitoring;
  $('#usb-message').textContent=message;$('#usb-error').textContent=lastError;
  $('#usb-board-list').innerHTML=BOARDS.map(b=>{const r=data.boards[b];return `<div class="usb-board"><div class="usb-board-heading"><strong>${b}${b==='C'?' · master':''}</strong><span>${r?esc(r.status==='responded'?'Reply received':r.status==='no-response'?'Reply timed out':'Check incomplete'):'Not checked'}</span><small>${r?esc(r.at.slice(11,19))+' · '+(r.elapsedMs??'—')+' ms':''}</small></div><div class="sensor-bits" aria-label="Board ${b} raw sensor inputs">${Array.from({length:16},(_,i)=>{const value=r?.status==='responded'?r.bits?.[15-i]:undefined;return `<span class="sensor-bit ${value==='1'?'one':value==='0'?'zero':''}" title="Input ${i+1}: ${value??'not read'}"><small>${i+1}</small><b>${value??'–'}</b></span>`;}).join('')}</div>${r?.error?`<p class="usb-board-error">${esc(r.error)}</p>`:''}</div>`;}).join('');paintLog();
 }
 function connectionChanged(state){data.connected=state.connected;persist();const error=intentionalClose?null:state.error;if(state.connected!==lastConnected||error){lastConnected=state.connected;onConnection({connected:state.connected,error});}onBusy(state.busy);if(error){lastError=error.message||'USB connection lost.';message='Reconnect the USB port before continuing. Incomplete checks are not board failures.';stopMonitor();}paint();}
 async function connect(){
  if(connecting||transport?.connected)return;
  if(!supported){lastError='USB access requires desktop Chrome or Edge over HTTPS or localhost.';paint();return;}
  connecting=true;lastError='';message='Select the COM port connected to master C.';paint();onBusy(true);
  let candidate;
  try{const port=await navigator.serial.requestPort();candidate=new SerialTransport(port,{onEvent:event,onState:connectionChanged});transport=candidate;await candidate.open();message='USB port open. Follow the guide below to reset C and read the board inputs.';event({type:'info',message:'USB port opened at 9600 baud, 8N1. Opening a port is not a board reply.'});onConnection({connected:true});}
  catch(e){await candidate?.close().catch(()=>{});transport=null;if(e.name==='NotFoundError'){message='Port selection cancelled. No board was checked.';}else{lastError=e.message||String(e);message='Could not open the locker COM port. Close other locker applications and try again.';event({type:'error',code:e.code||e.name,message:lastError});}onConnection({connected:false,error:e.name==='NotFoundError'?null:{code:e.code||'PORT',message:lastError}});}
  finally{connecting=false;onBusy(false);paint();}
 }
 function stopMonitor(){monitoring=false;monitorToken++;onBusy(false);paint();}
 async function disconnect(intentional=true){stopMonitor();token++;intentionalClose=intentional;try{await transport?.close();}finally{intentionalClose=false;transport=null;data.connected=false;}message='USB disconnected. Reconnect before sending further checks.';if(intentional)lastError='';observe(intentional?'Operator disconnected the USB COM port.':'USB device disconnected unexpectedly.');onConnection({connected:false,error:intentional?null:{code:'DISCONNECTED',message:'USB device disconnected unexpectedly.'}});paint();}
 async function check(board){
  if(!transport?.connected)throw Object.assign(Error('Connect the locker USB port first.'),{code:'DISCONNECTED'});
  const started=Date.now();let result;
  try{const reply=await transport.query(board);const changes=changedInputs(data.lastBits[board],reply.bits);data.lastBits[board]=reply.bits;result={...reply,status:'responded'};
   if(changes.length)observe(`Board ${board}: input${changes.length===1?'':'s'} ${changes.join(', ')} changed since the previous valid read${changes.length>1?' — multiple input changes; compare with the physical action.':'.'}`);
  }catch(e){result={board,status:e.code==='TIMEOUT'?'no-response':'error',code:e.code||'UNKNOWN',error:e.message,at:stamp(),elapsedMs:Date.now()-started};observe(`Board ${board}: ${e.code==='TIMEOUT'?'no valid reply within the response timeout.':e.message}`);}
  data.boards[board]=result;data.checks.push(result);data.checks=data.checks.slice(-600);persist();paint();return result;
 }
 async function scan(boards=BOARDS,onResult=()=>{}){
  if(operation||monitoring||transport?.busy)throw Error('Stop the current USB check before starting another.');
  operation=true;const mine=++token;lastError='';onBusy(true);paint();
  try{for(const board of boards){if(mine!==token||!transport?.connected)break;message=`Reading board ${board}…`;paint();const result=await check(board);await onResult(result);if(result.status==='error'&&['DISCONNECTED','WRITE','PORT'].includes(result.code))break;await delay(200);}message='Board check finished. Review each result below.';}
  finally{operation=false;onBusy(false);paint();}
 }
 async function reset(){
  if(operation||monitoring||transport?.busy)throw Error('Stop the current USB check first.');
  if(!transport?.connected)throw Error('Connect the locker USB port first.');
  operation=true;onBusy(true);message='Sending RST to master C. Waiting for its five-second reset sequence…';lastError='';paint();
  try{const r=await transport.resetMaster();observe('RST#C transmitted; reset wait completed. The subsequent ISB check verifies communication.');message='Master reset command sent and reset wait completed. Run the board checks next.';return r;}
  catch(e){lastError=e.message;throw e;}
  finally{operation=false;onBusy(false);paint();}
 }
 async function toggleMonitor(){
  if(monitoring){stopMonitor();message='Input monitoring stopped.';paint();return;}
  if(operation||transport?.busy||!transport?.connected)return;
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
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopMonitor();});
 persist();paint();
 return {get connected(){return!!transport?.connected;},get busy(){return connecting||operation||monitoring||!!transport?.busy;},get monitoring(){return monitoring;},connect,disconnect,check,scan,reset,stopMonitor,showError,snapshot:()=>structuredClone(data),clear(){data={boards:{},lastBits:{},connected:!!transport?.connected,events:[],observations:[],checks:[]};persist();paint();}};
}
