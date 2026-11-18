import {BEFORE_RESTART_COMMUNICATION,BOARD_CONFIGURATIONS,LOCKER_CAPACITIES,STAGES,STATES,freshSession,allChecked,failedBoards,workingNeighbors,validateStep,nextStep,outcome,report} from './flow.js?v=20261118-click-door';
import {detectedSelection} from './board-detection.js?v=20261118-detect';
import {mountUsbPanel} from './usb-ui.js?v=20261118-click-door';
import {createDoorGuide} from './door-ui.js?v=20261118-connection-setup';
import {freshDoorTests,getDoorTargets,getDoorMaster,hasDoorTestData,doorTestSummary} from './door-test.js?v=20261118-click-door';
import {boardsFor,masterFor,layoutForCapacity} from './layouts.js?v=20261118-master';
import {GuidedConnection,shouldProceed} from './guided-connection.js?v=20261118-detect';
import {createReportRecord,payloadForDrive,hasReportData} from './report-record.js?v=20261118-click-door';
import {DriveReportClient,buildReportPayload,validateSaveResult} from './drive-reports.js';
import {FIELD_REPORTS} from './drive-config.js';
import {draftKey,pendingKey,savedKey,readRecoverableTests} from './test-storage.js?v=20261118-click-door';

const drive=new DriveReportClient({endpoint:FIELD_REPORTS.endpoint});
let checksPaused=false;
let reportMode='live',pendingRecord=null,savedRecord=null,savedReceipt=null,reportError='',cacheError='';
let recoveryContext=null,recoveryEntries=[];
const volatilePending=new Map();
const stages={welcome:0,identify:0,'before-restart':0,power:0,startup:0,connect:0,reset:0,'single-board':1,initial:1,selftest:1,retry:2,recheck:2,select:2,connector:2,swap:2,cable:2,doors:3,result:4};
const PHOTO_SETUPS={
 'flat-input-sense':{label:'Flat Input Sense ribbons',master:'assets/master.png',slave:'assets/slave.png'},
 'individual-wires':{label:'Individual sensor wires',master:'assets/master-wired-labelled.png',slave:'assets/slave-wired-labelled.png'}
};
const $=q=>document.querySelector(q);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// A page opening is always a new physical test. Older browser records are
// available only through explicit, read-only recovery; never replay their step.
let s=freshSession(),usb,connection,doorGuide;
const activeBoards=()=>boardsFor(s);
const activeMaster=()=>masterFor(s);
const selectedBoard=()=>detectedSelection(s);
const testBoards=()=>selectedBoard()?[selectedBoard()]:activeBoards();
const testMaster=()=>selectedBoard()?null:activeMaster();
const canChooseBoardScope=()=>!Object.keys(s.initial).length&&!Object.keys(s.recheck).length&&!hasDoorTestData(s.doorTests)&&!s.log.some(item=>item.label.startsWith('USB RST#'));
const stageTitle=index=>selectedBoard()&&index===1?'Check board '+selectedBoard():selectedBoard()&&index===3?'Test a door on board '+selectedBoard():STAGES[index];
const layoutReady=()=>!!layoutForCapacity(s.details.lockerCapacity);
const boardNames=()=>{const boards=activeBoards();return boards.length<2?boards.join(''):boards.slice(0,-1).join(', ')+' and '+boards.at(-1);};
const capacityLocked=()=>!!s.beforeRestart?.recordedAt||!!s.boardDetection?.selection||!!s.boardDetection?.attempts?.length||!!usb?.connected||!!s.usb?.events?.length||!!Object.keys(s.initial).length||!!Object.keys(s.recheck).length||hasDoorTestData(s.doorTests);
function layoutNote(){if(!s.details.lockerCapacity)return 'Select the locker capacity. The guide will check its installed columns.';return layoutReady()?`This ${s.details.lockerCapacity}-bay locker uses columns ${boardNames()}, with ${activeMaster()} as the master.`:'The column layout for this capacity is not confirmed. You can record the setup and save a report; physical checks are unavailable.';}
s.reportId=crypto.randomUUID();
let entry=0,attempted=-1,checking=false,resetComplete=-1,physicalDone=false,readingBoard='',photo='master';
let photoSetup='flat-input-sense';
let selftestDeadline=0,selftestTimer=null,advancePending=false;
let buttonHelpSetup='',buttonHelpOpen=false;
const snapshot=()=>connection?.snapshot()||{phase:'waiting',remainingSeconds:60};
function cacheSet(key,value){try{const text=JSON.stringify(value);localStorage.setItem(key,text);if(localStorage.getItem(key)!==text)throw Error('The browser did not retain the report.');return true;}catch{cacheError='This browser cannot keep a local retry copy. Keep this page open and download a copy. Saving to Google Drive can still be attempted.';return false;}}
function cacheRemove(key){try{localStorage.removeItem(key);return true;}catch{cacheError='This browser could not update its local test storage.';return false;}}
function save(){const ok=hasReportData(s)?cacheSet(draftKey(s.reportId),s):cacheRemove(draftKey(s.reportId));if(!ok)$('#storage-label').textContent='Browser progress could not be saved';return ok;}
function record(label){if(reportMode!=='live')return;s.log.push({at:new Date().toISOString(),label});save();}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),2400);}
function clearComparison(){s.affected='';s.neighbor='';s.swapped={};s.cable='';s.acknowledged=false;}
function ioIdle(){return !checking&&!usb?.busy&&!doorGuide?.busy;}
function idle(){return reportMode==='live'&&ioIdle();}
function go(step,label){if(reportMode!=='live')return;if(step==='result'&&s.step!=='doors'&&layoutReady())step='doors';advancePending=false;connection.stop();usb.stopMonitor();clearInterval(selftestTimer);selftestTimer=null;selftestDeadline=0;s.history.push(s.step);if(label)record(label);s.step=step;entry++;attempted=-1;resetComplete=-1;physicalDone=false;readingBoard='';save();setContextPhoto();render(true);enterStep();}
function enterStep(){if(reportMode!=='live'||checksPaused)return;if(s.step==='connect'&&!selectedBoard()){connection.start();connection.notifyConnection(usb.connected);}else queueMicrotask(maybeRunStep);}
function maybeRunStep(){if(reportMode!=='live'||checksPaused||!layoutReady()||!usb?.connected||!idle()||attempted===entry)return;if(s.step==='single-board'&&selectedBoard()){attempted=entry;runSingleBoardCheck();}else if(['reset','retry'].includes(s.step)&&!selectedBoard()){attempted=entry;sendReset();}else if(['initial','recheck'].includes(s.step)&&!selectedBoard()){attempted=entry;runChecks(s.step,activeBoards());}}
function canProceed(){if(reportMode!=='live'||checksPaused||s.step!=='welcome'&&!layoutReady())return false;if(s.step==='connect')return !checking&&!advancePending&&usb.connected&&(selectedBoard()?idle():shouldProceed(snapshot(),activeMaster()));if(!idle())return false;if(['reset','retry'].includes(s.step))return usb.connected&&resetComplete===entry;if(s.step==='connector')return true;if(['swap','cable'].includes(s.step)&&!physicalDone)return usb.connected;if(['initial','recheck','swap','cable'].includes(s.step)&&Object.keys(s.checkErrors||{}).length)return false;return validateStep(s);}
function nextLabel(){if(s.step==='welcome')return 'Start the guide';if(s.step==='doors')return 'View final report';if(s.step==='swap'&&!physicalDone)return 'Connections swapped · Next';if(s.step==='cable'&&!physicalDone)return 'Cable replaced · Next';return 'Next';}
function actions(){return `<div class="step-actions"><button id="back" class="back" ${s.history.length&&idle()?'':'disabled'}>← Back</button><button id="next" class="primary" ${canProceed()?'':'disabled'}>${nextLabel()} <span aria-hidden="true">→</span></button></div>`;}
function note(text){return `<div class="note">${text}</div>`;}
function success(title,text){return `<div class="guide-status good"><span aria-hidden="true">✓</span><div><strong>${title}</strong><p>${text}</p></div></div>`;}
function waiting(title,text){return `<div class="guide-status waiting"><span class="guide-spinner" aria-hidden="true"></span><div><strong>${title}</strong><p>${text}</p></div></div>`;}
function warning(){return `<div class="warning"><span class="warning-icon" aria-hidden="true">△</span><div><strong>Align each D9 connector carefully.</strong><p>Keep the pins and housing aligned. Do not force a connector. Misalignment can cause sparks, incorrect connections and board damage.</p></div></div>`;}
function connectButton(){return `<button class="primary" id="guide-connect" ${usb.connected||!idle()||!usb.supported?'disabled':''}>Choose the locker USB port</button>`;}
function reconnect(){return !usb.connected?`<div class="guide-status attention"><div><strong>The USB port is disconnected.</strong><p>Connect the black USB cable. Close the parkIT app, then choose the locker port.</p>${connectButton()}</div></div>`:'';}
function problemExit(){return Object.keys(s.checkErrors||{}).length||!usb.connected?`<div class="guide-help">${Object.keys(s.checkErrors||{}).length?'<p>This check is incomplete. A USB error or unexpected reply does not identify a faulty board.</p>':''}<button class="secondary" id="retry-step" ${usb.connected&&idle()?'':'disabled'}>Try this check again</button><button class="text-button" id="finish-incomplete" ${idle()?'':'disabled'}>Save the incomplete result for support</button></div>`:'';}
function boardResults(field,boards=activeBoards()){const values=field==='cable'?{[s.neighbor]:s.cable}:s[field];return `<div class="guided-board-results" aria-label="Automatic board checks">${boards.map(b=>{const state=values[b];const text=state==='responded'?'Reply received':state==='no-response'?'No reply before the timeout':s.checkErrors?.[b]?'Check incomplete':checking&&readingBoard===b?'Checking now…':'Waiting for this check';return `<div class="guided-board-row ${state==='responded'?'pass':state==='no-response'||s.checkErrors?.[b]?'fail':''}"><b>${b}</b><div><strong>${b===activeMaster()?'Master '+activeMaster():'Board '+b}</strong><span>${esc(text)}</span></div><span aria-hidden="true">${state==='responded'?'✓':checking&&readingBoard===b?'…':'·'}</span></div>`;}).join('')}</div>`;}
function doorResultContent(){
 const data=s.doorTests,summary=doorTestSummary(data);
 const rows=testBoards().flatMap(board=>{
  const attempts=[...(data.previous?.[board]||[]),data.banks[board]];
  return attempts.map(item=>{
   const result=item.status==='tested'?`operator opened=${esc(item.operator.opened)}, closed=${esc(item.operator.closed)}`:item.status==='skipped'?'not completed':'no completed result';
   const issue=item.command.open&&item.command.open.status!=='sent'||item.command.lockOff&&item.command.lockOff.status!=='sent';
   return `<li><strong>${board}${item.door?' · door '+item.door:''}</strong>: ${result}${issue?' · command issue recorded':''}</li>`;
  });
 });
 return `<section class="door-result"><h2>Door checks</h2><p>${summary.tested} columns tested · ${summary.skipped} skipped · ${summary.pending} pending</p><ul>${rows.join('')}</ul><p>Door observations and sensor readings are recorded separately from the communication result above.</p></section>`;
}
function selftestHelpContent(){
 const setupId=PHOTO_SETUPS[buttonHelpSetup]?buttonHelpSetup:PHOTO_SETUPS[s.details.boardConfiguration]?s.details.boardConfiguration:photoSetup;
 const setup=PHOTO_SETUPS[setupId],wired=setupId==='individual-wires';
 const source=wired?'assets/master-wired-reference.jpg':setup.master;
 return `<details id="button-help" class="button-help" ${buttonHelpOpen?'open':''}><summary>Need help finding the red button?</summary><div class="button-help-body"><ol><li>Find master ${activeMaster()}: the board connected to the black USB cable.</li><li>Look immediately in front of the USB connection for a small button with a red top and a silver metal body.</li></ol><label class="field">Reference version<select id="button-help-setup">${Object.entries(PHOTO_SETUPS).map(([id,item])=>`<option value="${id}" ${id===setupId?'selected':''}>${esc(item.label)}</option>`).join('')}</select></label><figure><div class="button-closeup ${wired?'wired':'flat'}"><img id="button-help-image" src="${source}" width="${wired?3000:941}" height="${wired?4000:1672}" alt="Close-up of the small red-topped push button beside the black USB plug, ${esc(setup.label)} version." loading="lazy"></div><figcaption>The red top is the part you press. Use the button on master ${activeMaster()}.</figcaption></figure>${photoExampleNote()?`<p class="button-help-note">${esc(photoExampleNote())}</p>`:''}<button type="button" id="button-help-preview" class="secondary" data-preview-configuration="${setupId}" data-preview-board="master">View the full master-board photo ↗</button></div></details>`;
}
function welcomeContent(){return `<div class="intro-mark" aria-hidden="true">▦</div><h1>Let’s check the lockers.<br>One step at a time.</h1><p class="lede">We will tell you what to do and check the board replies automatically.</p><p>Enter the location and your name. Select the locker capacity before you identify the boards.</p><div class="fields welcome-details"><label class="field">Location <span class="optional">optional</span><input data-detail="location" maxlength="100" value="${esc(s.details.location)}"></label><label class="field">Your name <span class="optional">optional</span><input data-detail="technician" maxlength="100" value="${esc(s.details.technician)}"></label></div><fieldset class="setup-fieldset"><legend>How many bays does this locker have?</legend><div class="choices capacity-choices">${LOCKER_CAPACITIES.map(option=>`<button class="choice ${s.details.lockerCapacity===option.id?'selected':''}" data-locker-capacity="${option.id}" aria-pressed="${s.details.lockerCapacity===option.id}">${esc(option.label)}</button>`).join('')}</div></fieldset>${note(layoutNote())}${actions()}`;}
function identificationContent(){
 const selected=s.details.boardConfiguration;
 const photoChoices=BOARD_CONFIGURATIONS.filter(option=>PHOTO_SETUPS[option.id]);
 return `<h1>Identify the board setup.</h1><p class="lede">Compare the sensor connections on the master and slave boards with these photos.</p><p>Choose the setup that matches the installed boards. Enlarge a photo if you need a closer look.</p>${photoExampleNote()?note(photoExampleNote()):''}<fieldset class="setup-fieldset"><legend>Which setup is fitted?</legend><div class="setup-grid">${photoChoices.map(option=>`<article class="setup-card ${selected===option.id?'selected':''}"><button class="setup-pick" data-board-configuration="${option.id}" aria-pressed="${selected===option.id}"><span class="setup-check" aria-hidden="true">${selected===option.id?'✓':'○'}</span><strong>${esc(PHOTO_SETUPS[option.id].label)}</strong><span>${option.id==='flat-input-sense'?'Flat orange Input Sense cables plug into the front headers.':'Individual sensor wires plug into the front headers; the examples use blue wires.'}</span></button><div class="setup-images">${['master','slave'].map(role=>`<button class="setup-photo ${option.id==='individual-wires'?'wired':''}" data-preview-configuration="${option.id}" data-preview-board="${role}" aria-label="Enlarge ${role} photograph: ${esc(PHOTO_SETUPS[option.id].label)}"><img src="${PHOTO_SETUPS[option.id][role]}" alt="${role==='master'?'Master':'Slave'} example with ${option.id==='flat-input-sense'?'flat Input Sense ribbons':'individual blue sensor wires'}" loading="lazy"><span>${role==='master'?'Master':'Slave'} <span aria-hidden="true">⤢</span></span></button>`).join('')}</div></article>`).join('')}</div><div class="choices setup-other">${BOARD_CONFIGURATIONS.filter(option=>!PHOTO_SETUPS[option.id]).map(option=>`<button class="choice ${selected===option.id?'selected':''}" data-board-configuration="${option.id}" aria-pressed="${selected===option.id}">${esc(option.label)}</button>`).join('')}</div></fieldset><p class="setup-help">The master has the USB connection to the PC. If the banks use different sensor connections, select Mixed and record the bank letters below.</p><div class="fields board-labels"><label class="field">Master board label <span class="optional">optional</span><input data-detail="masterBoardLabel" maxlength="160" value="${esc(s.details.masterBoardLabel)}" placeholder="Copy the printed board or firmware label"></label><label class="field">Slave board label(s) <span class="optional">optional</span><input data-detail="slaveBoardLabels" maxlength="500" value="${esc(s.details.slaveBoardLabels)}" placeholder="Include bank letters if labels differ"></label></div><label class="field notes-label">Configuration notes <span class="optional">optional</span><textarea data-detail="configurationNotes" maxlength="2000" placeholder="Record differences between banks or anything that does not match the photos.">${esc(s.details.configurationNotes)}</textarea></label>${note('Copy labels from the boards in front of you. The labels in the reference photos are examples. '+layoutNote())}${actions()}`;
}

function beforeRestartContent(){
 const observation=s.beforeRestart,locked=!!observation.recordedAt;
 return `<h1>Can parkIT communicate<br>with the locker?</h1><p class="lede">Before you restart the locker, record which columns respond in the parkIT app.</p><p>Use what parkIT is showing now. Keep the locker power on and leave the cables connected. If you cannot confirm the current status, select Not sure.</p><fieldset class="setup-fieldset" ${locked?'disabled':''}><legend>Which columns respond?</legend><div class="choices before-restart-choices">${BEFORE_RESTART_COMMUNICATION.map(option=>`<label class="choice ${observation.communication===option.id?'selected':''}"><strong>${esc(option.label)}</strong><input type="radio" name="pre-restart-communication" value="${option.id}" ${observation.communication===option.id?'checked':''}></label>`).join('')}</div></fieldset>${observation.communication==='some'?`<fieldset class="setup-fieldset" ${locked?'disabled':''}><legend>Select the columns that do not respond.</legend><div class="before-restart-boards">${activeBoards().map(board=>`<label class="choice"><strong>${board}${board===activeMaster()?' (master)':''}</strong><input type="checkbox" name="pre-restart-board" value="${board}" ${observation.unresponsiveBoards.includes(board)?'checked':''}></label>`).join('')}</div><p class="setup-help" id="pre-restart-board-help">Select at least one column. If no columns respond, choose No columns respond above.</p></fieldset>`:''}<label class="field notes-label">What is parkIT showing? <span class="optional">optional</span><textarea id="pre-restart-notes" maxlength="2000" ${locked?'readonly':''} placeholder="Record error messages, intermittent replies or other symptoms.">${esc(observation.notes)}</textarea></label>${locked?note('This observation was recorded at '+esc(new Date(observation.recordedAt).toLocaleString())+'. It stays unchanged as you continue the test.'):note('This records your observation from parkIT. The guide will check the boards over USB later.')}<p>Select Next to continue to the locker power cycle.</p>${actions()}`;
}

const bounded=(value,limit)=>String(value??'').slice(0,limit);
function identityResults(results,at){
 return (Array.isArray(results)?results:[]).filter(item=>item&&/^[A-E]$/.test(item.board)).slice(0,5).map(item=>{
  const valid=item.status==='responded'&&typeof item.bits==='string'&&/^[01]{16}$/.test(item.bits);
  const result={board:item.board,status:valid?'responded':item.status==='no-response'?'no-response':'error',at:typeof item.at==='string'&&Number.isFinite(Date.parse(item.at))?new Date(item.at).toISOString():at,stage:'discovery'};
  if(valid)result.bits=item.bits;
  if(item.raw!==undefined)result.raw=bounded(item.raw,1024);
  if(Number.isFinite(item.elapsedMs)&&item.elapsedMs>=0)result.elapsedMs=item.elapsedMs;
  if(item.code)result.code=bounded(item.code,80);
  if(item.error)result.error=bounded(item.error,1000);
  if(result.status==='error'&&!result.code&&!result.error){result.code='PROTOCOL';result.error='The address check did not return a valid input-status reply.';}
  return result;
 });
}
function rememberDiscovery(value=snapshot()){
 if(!value.discoveryAt||!Number.isFinite(Date.parse(value.discoveryAt))||!Array.isArray(value.discoveryResults)||!/^[A-E]$/.test(value.masterBoard))return;
 const attempt={at:new Date(value.discoveryAt).toISOString(),expectedMaster:value.masterBoard,results:identityResults(value.discoveryResults,value.discoveryAt)};
 if(!attempt.results.length||s.boardDetection.attempts.some(item=>JSON.stringify(item)===JSON.stringify(attempt)))return;
 s.boardDetection.attempts.push(attempt);s.boardDetection.attempts=s.boardDetection.attempts.slice(-20);
 record('Read-only USB address check: '+(attempt.results.filter(item=>item.status==='responded').map(item=>item.board).join(', ')||'no valid board replies')+'. Locker master remains '+attempt.expectedMaster+'.');
}
function adoptDetectedBoard(board){
 const current=snapshot();
 if(!idle()||s.step!=='connect'||selectedBoard()||!usb.connected||current.phase!=='attention'||current.reason!=='different-board'||current.masterBoard!==activeMaster())return;
 const results=identityResults(current.discoveryResults,current.discoveryAt);
 if(!/^[A-E]$/.test(board)||board===activeMaster()||!results.some(item=>item.board===board&&item.status==='responded')||results.some(item=>item.board===activeMaster()&&item.status==='responded'))return;
 if(!canChooseBoardScope()){toast('Start a new report to choose a single board after locker checks have started.');return;}
 try{
  rememberDiscovery(current);usb.adoptSingleBoard(board);
  s.boardDetection.selection={board,at:new Date().toISOString(),expectedMaster:activeMaster()};
  s.doorTests=freshDoorTests([board],null,{scope:'board'});doorGuide?.reset();s.connection='connected';
  go('single-board','Operator chose to test detected board '+board+' only. No master reset will be sent.');
 }catch(error){toast(error.message||String(error));}
}
function singleBoardContent(){
 const board=selectedBoard(),last=s.boardDetection.checks.at(-1);
 if(!board)return '<h1>Select a detected board first.</h1>'+actions();
 const status=checking?waiting('Reading board '+board+'…','Keep the USB cable connected.'):last?.status==='responded'?success('Board '+board+' replied.','A valid input-status reply was received from this board.'):last?'<div class="guide-status attention"><div><strong>The board check is incomplete.</strong><p>'+esc(last.error||'No reply was received before the timeout.')+'</p></div></div>':'';
 return '<h1>Check board '+board+' only.</h1><p class="lede">You chose a single-board test. The guide will read this board and then let you test one selected door.</p>'+note('The selected locker layout uses master '+activeMaster()+'. That master has not been confirmed. No reset command is sent during this single-board test.')+reconnect()+status+(last?.status==='responded'?'<p class="single-board-bits">Raw sensor inputs: <code>'+esc(last.bits)+'</code></p>':'')+'<button id="read-single-board" class="secondary" '+(idle()&&usb.connected?'':'disabled')+'>Read board '+board+' again</button><p>When you are ready, select Next for the door check. You can record a reason if the door cannot be tested.</p>'+actions();
}
async function runSingleBoardCheck(){
 const board=selectedBoard();if(!board||!usb.connected||!idle())return;
 checking=true;const ownEntry=entry;render();
 let result;
 try{result=await usb.check(board);}
 catch(error){result={board,status:'error',at:new Date().toISOString(),code:error.code||'USB',error:error.message||String(error)};}
 finally{checking=false;}
 if(reportMode!=='live'||entry!==ownEntry||selectedBoard()!==board)return;
 let normalized=identityResults([result],new Date().toISOString())[0];
 if(!normalized||normalized.board!==board)normalized={board,status:'error',at:new Date().toISOString(),code:'PROTOCOL',error:'The selected board did not return a valid addressed input-status reply.',raw:bounded(result?.raw,1024)};
 if(normalized){delete normalized.stage;s.boardDetection.checks.push(normalized);s.boardDetection.checks=s.boardDetection.checks.slice(-100);record('Single-board ISB#'+board+': '+normalized.status);}
 save();render();
}
function connectionContent(){
 if(selectedBoard())return '<h1>Continue with board '+selectedBoard()+'.</h1><p class="lede">This report is limited to the selected board. The locker master and other columns are not included.</p>'+reconnect()+actions();
 if(checksPaused)return `<h1>The connection check is paused.</h1><p class="lede">Your report is unchanged. When you are ready, restart the 60-second connection check before continuing.</p><button class="primary" id="retry-connection">Check the connection again</button>${actions()}`;
 const c=snapshot(),ready=shouldProceed(c,activeMaster());
 if(usb.connected&&c.phase==='attention'&&c.reason==='different-board'&&Array.isArray(c.discoveryResults)){
  const found=identityResults(c.discoveryResults,c.discoveryAt).filter(item=>item.status==='responded').map(item=>item.board).filter((board,index,boards)=>boards.indexOf(board)===index&&board!==activeMaster());
  if(found.length)return '<h1>'+esc(found.length===1?'Board '+found[0]+' replied.':'These boards replied: '+found.join(', ')+'.')+'</h1><p class="lede">The expected master '+activeMaster()+' was not confirmed. Do you want to test one of the detected boards on its own?</p>'+note('Continuing will test only the board you choose, including one selected-door check. The guide will not send a master reset or test the other columns.')+'<div class="detected-board-actions">'+found.map(board=>'<button class="primary" data-use-detected-board="'+board+'" '+(idle()&&usb.connected&&canChooseBoardScope()?'':'disabled')+'>Continue with board '+board+' only</button>').join('')+'</div>'+(canChooseBoardScope()?'':note('Locker checks have already started in this report. Save it and start a new report to choose a single board.'))+'<div class="guide-help"><button class="secondary" id="retry-connection" '+(idle()?'':'disabled')+'>Check the addresses again</button><button class="text-button" id="disconnect-guide" '+(idle()?'':'disabled')+'>Choose a different USB port</button></div>'+actions();
 }
 if(!usb.supported)return `<h1>Open the guide in Chrome or Edge.</h1><p class="lede">Use a desktop browser on the computer connected to the lockers. This browser cannot access the USB COM port.</p><button class="secondary" id="connection-unavailable">Continue with the physical self-test</button>${actions()}`;
 let status;
 if(c.phase==='ready'&&!ready)status=waiting('Repeat the master connection check.',`This connection proof does not belong to master ${activeMaster()}. Select Check the connection again.`);
 else if(ready)status=advancePending?waiting('Finishing the current connection check…','We will continue automatically when this reply has been checked.'):success('We are happy with the connection.',`Master ${activeMaster()} has replied throughout the 60-second check. Select Next to reset the master.`);
 else if(c.phase==='watching')status=success(`Master ${activeMaster()} is responding.`,`We are checking that it stays connected. ${c.remainingSeconds} seconds remain.`);
 else if(c.phase==='attention')status=`<div class="guide-status attention"><span aria-hidden="true">?</span><div><strong>${c.reason==='connection-timeout'?'It has been 60 seconds. Are the power and USB cable connected?':'We need to check the connection again.'}</strong><p>Make sure the lockers have power. Connect the black USB cable to this computer. Close the parkIT app.</p><p>${esc(c.reason==='connection-timeout'?`We have not received a valid reply from master ${activeMaster()}.`:`The last check did not confirm a reply from master ${activeMaster()}. This does not identify a faulty board.`)}</p></div></div>`;
 else if(c.discoveryRunning)status=waiting('Looking for a responding board…','Checking addresses A to E with input-status requests. No reset or door-opening command is sent.');
 else status=waiting(usb.connected?`The USB port is open. Checking master ${activeMaster()}…`:'Waiting for the locker USB connection.',usb.connected?'We will confirm the connection from an actual board reply.':`Choose the locker COM port below. We will check with you again in ${c.remainingSeconds} seconds.`);
 return `<h1>${ready?'The connection is ready.':'Connect the black USB cable.'}</h1><p class="lede">Connect master ${activeMaster()} to this computer. Select the locker COM port when the browser asks.</p>${status}${['watching','waiting'].includes(c.phase)?`<div class="guide-countdown" role="progressbar" aria-label="${c.phase==='watching'?'Connection stability check':'Connection wait'}" aria-valuemin="0" aria-valuemax="60" aria-valuenow="${Math.max(0,60-c.remainingSeconds)}"><span style="width:${Math.max(0,Math.min(100,(60-c.remainingSeconds)/60*100))}%"></span></div>`:''}${!usb.connected?connectButton():''}${c.phase==='attention'||c.phase==='ready'&&!ready?`<div class="guide-help"><button class="primary" id="retry-connection" ${idle()?'':'disabled'}>Check the connection again</button>${usb.connected?'<button class="secondary" id="disconnect-guide">Choose a different USB port</button>':''}<button class="text-button" id="connection-unavailable" ${idle()?'':'disabled'}>I cannot connect · run the physical self-test</button></div>`:''}${actions()}`;
}
function content(){switch(s.step){
 case 'welcome':return welcomeContent();
 case 'identify':return identificationContent();
 case 'before-restart':return beforeRestartContent();
 case 'power':case 'startup':return `<h1>Turn the locker power off.<br>Then turn it back on.</h1><ol class="physical-steps"><li>Switch off the mains supply to the locker system.</li><li>Switch it back on.</li><li>Wait for the system to finish starting.</li></ol>${note('Restarting the PC alone does not cycle the locker mains supply.')}<p>When the system is back on, select Next. We will connect the USB cable next.</p>${actions()}`;
 case 'connect':return connectionContent();
 case 'single-board':return singleBoardContent();
 case 'reset':case 'retry':return `<h1>${resetComplete===entry?'The reset command has been sent.':`We will reset master ${activeMaster()}.`}</h1><p class="lede">Keep the USB cable connected. We send the reset command to ${activeMaster()} only.</p>${reconnect()}${checking?waiting(`Resetting master ${activeMaster()}…`,'Wait for the master’s five-second reset sequence. You do not need to type a command.'):resetComplete===entry?success('The reset wait is complete.','Select Next. We will check the installed boards automatically.'):usb.connected?waiting('Preparing the reset…',`The guide will send RST to master ${activeMaster()}.`):''}${note('A reset sent to a slave does not perform a meaningful system reset. The board checks verify communication after the master reset.')}${problemExit()}${actions()}`;
 case 'initial':case 'recheck':{const complete=allChecked(s[s.step],activeBoards());return `<h1>${checking?'We are checking each board.':complete?'The board checks are complete.':'Check the installed boards.'}</h1><p class="lede">Keep the USB cable connected. We check ${boardNames()} one at a time.</p>${reconnect()}${boardResults(s.step)}${checking?'<p>You do not need to press anything while the checks run.</p>':complete&&!failedBoards(s[s.step],activeBoards()).length?success('All installed boards replied.','We are happy with communication during this check. Select Next to see the result.'):complete?note('One or more boards did not reply. Select Next. We will guide you through the next check.'):''}${problemExit()}${actions()}`;}
 case 'selftest':return `<h1>Hold the red button<br>for 10 seconds.</h1><p class="lede">Use the red button on master ${activeMaster()}, directly in front of the black USB cable.</p>${selftestHelpContent()}<p>Press and hold the physical button. Use the timer below to help you hold it for 10 seconds.</p><div class="timer-wrap"><div><div class="timer-number" id="timer-number">${selftestDeadline?Math.max(0,Math.ceil((selftestDeadline-Date.now())/1000)):10} s</div><div class="timer-help" id="timer-help">Hold the physical button while the timer runs.</div></div><button class="secondary" id="timer-start">Start 10-second timer</button></div><p>Did the self-test start?</p><div class="choices">${[['ran','Yes, the self-test started'],['did-not-run','No, it did not start'],['uncertain','I could not confirm it']].map(([value,text])=>`<button class="choice ${s.selftest===value?'selected':''}" data-selftest="${value}" aria-pressed="${s.selftest===value}">${text}</button>`).join('')}</div>${note('A running self-test shows that the board can execute it. It does not confirm communication or every firmware function.')}<p>Select Next. We will reset master ${activeMaster()} and try the board checks again.</p>${actions()}`;
 case 'select':{const failed=failedBoards(s.recheck,activeBoards()).filter(b=>b!==activeMaster());const neighbors=workingNeighbors(s.affected,s.recheck,activeBoards(),activeMaster());const anyPair=failed.some(b=>workingNeighbors(b,s.recheck,activeBoards(),activeMaster()).length);return `<h1>Choose one board<br>to investigate.</h1><p class="lede">We will compare an affected slave with a working slave next to it.</p><div class="fields"><label class="field">Board that did not reply<select id="affected"><option value="">Choose a board</option>${failed.map(b=>`<option value="${b}" ${s.affected===b?'selected':''}>Board ${b}</option>`).join('')}</select></label><label class="field">Working board next to it<select id="neighbor" ${neighbors.length?'':'disabled'}><option value="">Choose a working board</option>${neighbors.map(b=>`<option value="${b}" ${s.neighbor===b?'selected':''}>Board ${b}</option>`).join('')}</select></label></div>${note(`Keep each board identified by its letter. Master ${activeMaster()} is not a slave for this comparison.`)}${!anyPair||(s.affected&&!neighbors.length)?'<p>No adjacent working slave is available for this comparison.</p><button class="secondary" id="finish-incomplete">Save this result for support</button>':''}${actions()}`;}
 case 'connector':return `<h1>Before you move<br>the connections.</h1><p class="lede">We will compare board ${s.affected} with working board ${s.neighbor}.</p>${warning()}<p>Read these handling instructions. Then select Next to see which connections to swap.</p>${actions()}`;
 case 'swap':return !physicalDone?`<h1>Swap the connections<br>on ${s.affected} and ${s.neighbor}.</h1><p class="lede">Swap the communication connections at the two boards. Each board must now use the other board’s cable and hub connection.</p>${warning()}<p>Keep the board letters unchanged. If these connections are already swapped, leave them in place. Select Next when ready. We will check both boards.</p>${reconnect()}${actions()}`:`<h1>${checking?'We are checking both boards.':'The connection comparison is complete.'}</h1>${boardResults('swapped',[s.affected,s.neighbor])}${reconnect()}${problemExit()}${actions()}`;
 case 'cable':return !physicalDone?`<h1>Replace the suspect cable<br>with a working cable.</h1><p class="lede">Keep board ${s.neighbor} on the same suspect hub connection. Change only the cable.</p>${warning()}<p>When the working cable is in place, select Next. We will check board ${s.neighbor} again.</p>${reconnect()}<button class="text-button" id="cable-uncertain">I cannot complete this cable comparison</button>${actions()}`:`<h1>${checking?'We are checking the replacement cable.':'The cable check is complete.'}</h1>${boardResults('cable',[s.neighbor])}${reconnect()}${problemExit()}${actions()}`;
 case 'doors':return `<div id="door-guide"></div>${reconnect()}${actions()}`;
 case 'result':{const r=outcome(s);const values=selectedBoard()?{[selectedBoard()]:s.boardDetection.checks.at(-1)?.status}:allChecked(s.recheck,activeBoards())?s.recheck:s.initial;return `<div class="outcome-mark ${r.kind}" aria-hidden="true">${r.kind==='success'?'✓':'?'}</div><h1>${esc(r.title)}</h1><p class="lede">${esc(r.summary)}</p><div class="result-callout"><p>${esc(r.next)}</p></div>${doorResultContent()}<p class="check-progress">${selectedBoard()?'Single-board input checks':(allChecked(s.recheck,activeBoards())?'Repeat':'Initial')+' board checks · before connection swaps'}</p><div class="result-chips">${testBoards().map(b=>`<span>${b} · ${values[b]==='responded'?'replied':values[b]==='no-response'?'no reply':'not checked'}</span>`).join('')}</div><label class="field notes-label">Anything else you observed <span class="optional">optional</span><textarea data-detail="notes" maxlength="10000">${esc(s.details.notes)}</textarea></label><div class="step-actions result-actions"><button class="back" id="back" ${s.history.length&&idle()?'':'disabled'}>← Back</button><div class="report-actions"><button class="secondary" id="copy-report">Copy report</button><button class="secondary" id="download-report">Download copy</button><button class="primary" id="save-result">Save to Drive</button></div></div><button class="text-button" id="open-diagnostics">Open sensor monitoring and the USB log</button>`;}
 }}
function render(focus=false){
 if(reportMode!=='live'){renderReportView(focus);return;}
 updateLayoutDisplay();
 const stage=stages[s.step];$('#stage-label').textContent=stageTitle(stage);$('#guide-usb-status').textContent=usb?.connected?'USB port open':'USB not connected';
 $('#progress').innerHTML=STAGES.map((text,i)=>({text:stageTitle(i),i})).filter(item=>!selectedBoard()||item.i!==2).map(({text,i},position)=>`<li class="${i===stage?'active':i<stage?'done':''}" ${i===stage?'aria-current="step"':''}><span class="progress-num">${i<stage?'✓':position+1}</span><div>${text}<small>${['Board setup, current fault, power and USB','Automatic board replies','Follow the next physical test','One door on '+(selectedBoard()||boardNames()),'Save the evidence to Drive'][i]}</small></div></li>`).join('');
 $('#step').innerHTML=`<div class="eyebrow"><span class="mini-dot"></span>${stage===4?'YOUR RESULT':stageTitle(stage)}</div>${content()}`;
 if(s.step==='doors')doorGuide?.render($('#door-guide'));
 else doorGuide?.pauseLive();
 usb?.setControlsEnabled(s.step==='result'&&!checksPaused&&layoutReady());refreshReportControls();$('#advanced-diagnostics').hidden=false;
 $('#storage-label').textContent=cacheError?'Browser progress could not be saved':'Draft kept on this device';
 if(checksPaused&&s.step!=='connect')$('#step').insertAdjacentHTML('afterbegin','<div class="note"><p>Automatic locker checks are paused.</p><button class="secondary" id="resume-report">Resume this report</button></div>');
 $('#resume-report')?.addEventListener('click',resumeReport);
 if(reportError||cacheError)$('#step').insertAdjacentHTML('afterbegin',`<p class="report-error" role="alert">${esc(reportError||cacheError)}</p>`);
 $('#next')?.addEventListener('click',next);
 document.querySelectorAll('[data-locker-capacity]').forEach(el=>el.addEventListener('click',()=>{
  if(!idle()||s.step!=='welcome'||!LOCKER_CAPACITIES.some(option=>option.id===el.dataset.lockerCapacity))return;
  if(el.dataset.lockerCapacity!==s.details.lockerCapacity){
   if(capacityLocked()){toast('Start a new report to change capacity after observations or locker checks have been recorded.');return;}
   if(s.beforeRestart.communication||s.beforeRestart.unresponsiveBoards.length){
    record('Capacity changed before the starting observation was confirmed. Previous draft answer: '+s.beforeRestart.communication+'; selected columns: '+(s.beforeRestart.unresponsiveBoards.join(', ')||'none'));
    s.beforeRestart.communication='';s.beforeRestart.unresponsiveBoards=[];toast('Capacity changed. Review the parkIT status for this layout. Your notes are retained.');
   }
   s.details.lockerCapacity=el.dataset.lockerCapacity;s.doorTests=freshDoorTests(activeBoards(),activeMaster());doorGuide?.reset();usb?.refreshLayout?.();
  }
  save();setContextPhoto();render();
 }));
 document.querySelectorAll('[data-board-configuration]').forEach(el=>el.addEventListener('click',()=>{if(!idle()||s.step!=='identify')return;s.details.boardConfiguration=el.dataset.boardConfiguration;save();setContextPhoto();render();}));
 document.querySelectorAll('[data-preview-configuration]').forEach(el=>el.addEventListener('click',()=>showBoardPhoto(el.dataset.previewConfiguration,el.dataset.previewBoard)));

 const editBeforeRestart=()=>idle()&&s.step==='before-restart'&&!s.beforeRestart.recordedAt;
 document.querySelectorAll('[name="pre-restart-communication"]').forEach(el=>el.addEventListener('change',()=>{
  if(!editBeforeRestart()||!el.checked||!BEFORE_RESTART_COMMUNICATION.some(option=>option.id===el.value))return;
  s.beforeRestart.communication=el.value;s.beforeRestart.unresponsiveBoards=[];save();render();document.querySelector('[name="pre-restart-communication"][value="'+el.value+'"]')?.focus({preventScroll:true});
 }));
 document.querySelectorAll('[name="pre-restart-board"]').forEach(el=>el.addEventListener('change',()=>{
  if(!editBeforeRestart()||s.beforeRestart.communication!=='some'||!activeBoards().includes(el.value))return;
  const selected=new Set(s.beforeRestart.unresponsiveBoards);if(el.checked)selected.add(el.value);else selected.delete(el.value);
  s.beforeRestart.unresponsiveBoards=activeBoards().filter(board=>selected.has(board));save();refreshControls();
 }));
 $('#pre-restart-notes')?.addEventListener('input',event=>{if(!editBeforeRestart())return;s.beforeRestart.notes=event.target.value.slice(0,2000);save();refreshReportControls();});
 $('#back')?.addEventListener('click',()=>{if(!idle())return;const previous=s.history.pop();if(previous){connection.stop();usb.stopMonitor();s.step=previous;entry++;attempted=-1;resetComplete=-1;physicalDone=false;save();setContextPhoto();render(true);enterStep();}});
 document.querySelectorAll('[data-use-detected-board]').forEach(element=>element.addEventListener('click',()=>adoptDetectedBoard(element.dataset.useDetectedBoard)));
 $('#read-single-board')?.addEventListener('click',runSingleBoardCheck);
 $('#guide-connect')?.addEventListener('click',()=>{if(idle())usb.connect();});
 $('#retry-connection')?.addEventListener('click',()=>{if(!idle()||selectedBoard())return;checksPaused=false;record('Operator requested a new connection check');connection.retry();connection.notifyConnection(usb.connected);});
 $('#disconnect-guide')?.addEventListener('click',()=>{if(idle())usb.disconnect();});
 $('#connection-unavailable')?.addEventListener('click',()=>{if(!idle()||selectedBoard())return;s.connection='unavailable';s.connectionIssue=true;s.initial={};s.recheck={};s.selftest='';s.checkErrors={};clearComparison();go('selftest','USB connection could not be verified; continuing to the physical self-test');});
 $('#retry-step')?.addEventListener('click',()=>{if(!idle())return;attempted=-1;if(['swap','cable'].includes(s.step))runChecks(s.step==='swap'?'swapped':'cable',s.step==='swap'?[s.affected,s.neighbor]:[s.neighbor]);else maybeRunStep();});
 $('#finish-incomplete')?.addEventListener('click',()=>{if(!idle())return;if(!usb.connected)s.connection='unavailable';go('result','Incomplete check saved for support');});
 $('#cable-uncertain')?.addEventListener('click',()=>{if(!idle())return;s.cable='uncertain';go('result','Operator could not complete the cable comparison');});
 document.querySelectorAll('[data-detail]').forEach(el=>el.addEventListener('input',()=>{if(reportMode!=='live')return;s.details[el.dataset.detail]=el.value;save();refreshReportControls();}));
 document.querySelectorAll('[data-selftest]').forEach(el=>el.addEventListener('click',()=>{if(!idle())return;s.selftest=el.dataset.selftest;save();render();}));
 $('#affected')?.addEventListener('change',e=>{if(!idle())return;s.affected=e.target.value;s.neighbor='';s.swapped={};s.cable='';s.acknowledged=false;save();render();});
 $('#neighbor')?.addEventListener('change',e=>{if(!idle())return;s.neighbor=e.target.value;s.swapped={};s.cable='';s.acknowledged=false;save();render();});
 $('#timer-start')?.addEventListener('click',()=>{if(!idle())return;selftestDeadline=Date.now()+10000;clearInterval(selftestTimer);selftestTimer=setInterval(updateSelftestTimer,100);updateSelftestTimer();});
 $('#button-help')?.addEventListener('toggle',event=>{buttonHelpOpen=event.target.open;});
 $('#button-help-setup')?.addEventListener('change',event=>{if(reportMode!=='live'||s.step!=='selftest'||!PHOTO_SETUPS[event.target.value])return;buttonHelpSetup=event.target.value;buttonHelpOpen=true;render();});
 $('#copy-report')?.addEventListener('click',()=>copy(report(s),'Report copied'));
 $('#download-report')?.addEventListener('click',download);
 $('#save-result')?.addEventListener('click',()=>saveToDrive());
 $('#open-diagnostics')?.addEventListener('click',()=>{$('#advanced-diagnostics').open=true;$('#advanced-diagnostics').scrollIntoView({behavior:'smooth',block:'start'});});
 if(focus){$('#step').focus({preventScroll:true});$('#main').scrollIntoView({behavior:'instant',block:'start'});}
}
function refreshControls(){if(!usb)return;refreshReportControls();if(reportMode!=='live')return;if($('#next'))$('#next').disabled=!canProceed();if($('#back'))$('#back').disabled=!idle()||!s.history.length;if($('#guide-connect'))$('#guide-connect').disabled=usb.connected||!idle()||!usb.supported;for(const id of ['retry-connection','disconnect-guide','finish-incomplete','connection-unavailable'])if($('#'+id))$('#'+id).disabled=!idle();queueMicrotask(maybeRunStep);}
function updateSelftestTimer(){if(reportMode!=='live'||s.step!=='selftest'){clearInterval(selftestTimer);selftestTimer=null;return;}const seconds=Math.max(0,Math.ceil((selftestDeadline-Date.now())/1000));if($('#timer-number'))$('#timer-number').textContent=seconds+' s';if($('#timer-help'))$('#timer-help').textContent=seconds?'Keep holding the physical red button.':'10 seconds have passed. Tell us whether the self-test started.';if(!seconds){clearInterval(selftestTimer);selftestTimer=null;}}
function next(){if(!canProceed())return;if(s.step==='connect'&&usb.busy){advancePending=true;render();return;}if(s.step==='before-restart'){if(!s.beforeRestart.recordedAt)s.beforeRestart.recordedAt=new Date().toISOString();go('power','Operator recorded parkIT communication before restart: '+s.beforeRestart.communication+(s.beforeRestart.unresponsiveBoards.length?'; columns not responding: '+s.beforeRestart.unresponsiveBoards.join(', '):''));return;}if(s.step==='power'||s.step==='startup'){go('connect','Operator confirmed the locker mains cycle and startup');return;}if(s.step==='connect'&&selectedBoard()){go('single-board','Operator continued the selected-board test');return;}if(s.step==='connect'){s.connection='connected';go('reset',`Master ${activeMaster()} passed the 60-second guided connection check`);return;}if(s.step==='connector')s.acknowledged=true;if(['swap','cable'].includes(s.step)&&!physicalDone){physicalDone=true;record(s.step==='swap'?`Operator confirmed the connection swap at ${s.affected} and ${s.neighbor}`:`Operator confirmed a working cable on board ${s.neighbor} and the same hub connection`);runChecks(s.step==='swap'?'swapped':'cable',s.step==='swap'?[s.affected,s.neighbor]:[s.neighbor]);return;}const step=nextStep(s);if(step)go(step,stepRecord());}
async function sendReset(){if(reportMode!=='live'||selectedBoard()||!usb.connected||!idle())return;const ownEntry=entry;checking=true;resetComplete=-1;if(s.step==='reset'){s.initial={};s.selftest='';}s.recheck={};s.checkErrors={};clearComparison();save();render();try{await usb.reset();if(reportMode!=='live'||entry!==ownEntry)return;resetComplete=entry;s.connection='connected';record(`USB RST#${activeMaster()} transmitted; six-second reset wait completed. Subsequent board checks verify communication.`);}catch(e){s.checkErrors={...s.checkErrors,RST:e.message};record('Master reset check incomplete: '+e.message);}finally{checking=false;save();render();}}
async function runChecks(field,boards){
 if(selectedBoard()||!usb.connected||!idle())return;checking=true;const ownEntry=entry;
 if(field==='initial'){s.recheck={};s.selftest='';clearComparison();}else if(field==='recheck')clearComparison();else if(field==='swapped')s.cable='';
 s.checkErrors||={};delete s.checkErrors.USB;for(const b of boards){delete s.checkErrors[b];if(field==='cable')s.cable='';else delete s[field][b];}readingBoard=boards[0];record(`Starting automatic USB ${field} check: ${boards.join(', ')}`);render();
 try{await usb.scan(boards,result=>{if(reportMode!=='live'||entry!==ownEntry)return;if(result.status==='error')s.checkErrors[result.board]=result.error;else{if(field==='cable')s.cable=result.status;else s[field][result.board]=result.status;delete s.checkErrors[result.board];s.connection='connected';}record(`USB ${field} ISB#${result.board}: ${result.status}${result.bits?' (BIN) '+result.bits:''}${result.error?' — '+result.error:''}`);readingBoard=boards[boards.indexOf(result.board)+1]||'';render();});}catch(e){s.checkErrors.USB=e.message;record('Automatic USB check incomplete: '+e.message);}finally{checking=false;readingBoard='';save();render();}
}
function stepRecord(){if(s.step==='welcome')return 'Operator selected locker capacity: '+(LOCKER_CAPACITIES.find(option=>option.id===s.details.lockerCapacity)?.label||'Not recorded');if(s.step==='identify')return 'Operator identified board setup: '+(BOARD_CONFIGURATIONS.find(option=>option.id===s.details.boardConfiguration)?.label||'Not recorded');if(['initial','recheck'].includes(s.step))return s.step+' board checks reviewed';if(s.step==='selftest')return 'Operator self-test observation: '+s.selftest;if(s.step==='select')return `Comparison selected: ${s.affected} and working slave ${s.neighbor}`;if(s.step==='connector')return 'Operator acknowledged the D9 alignment instructions by selecting Next';if(s.step==='swap')return `Swap results: ${s.affected} ${s.swapped[s.affected]}; ${s.neighbor} ${s.swapped[s.neighbor]}`;if(s.step==='cable')return 'Replacement cable result: '+s.cable;return s.step+' completed';}
async function copy(text,message){try{await navigator.clipboard.writeText(text);toast(message);}catch{toast('Use Download report to save the evidence.');}}
function download(){downloadText(reportMode==='live'?report(s):(pendingRecord||savedRecord)?.reportText||'');}
function downloadText(text){if(!text)return;const record=pendingRecord||savedRecord;const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='locker-check-'+(record?.savedAt||new Date().toISOString()).slice(0,10)+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Copy downloaded. Drive saving is separate.');}

function freezeRecord(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeRecord(child);Object.freeze(value);}return value;}
function showUnfinishedTests(){
 if(['saving','changing'].includes(reportMode)||!ioIdle())return;
 let recovery={entries:[],unreadable:true};
 try{recovery=readRecoverableTests(localStorage);}catch{}
 const currentIds=new Set([s.reportId,(pendingRecord||savedRecord)?.id].filter(Boolean).map(id=>id.toLowerCase()));
 const recovered=new Map(recovery.entries.map(item=>[item.id.toLowerCase(),item]));
 for(const record of volatilePending.values())recovered.set(record.id.toLowerCase(),{id:record.id,kind:'pending',record,location:record.location,technician:record.technician,at:record.savedAt});
 recoveryEntries=[...recovered.values()].filter(item=>!currentIds.has(item.id.toLowerCase()));
 $('#recovery-list').innerHTML=recoveryEntries.length?recoveryEntries.map((item,index)=>`<article class="recovery-item"><strong>${esc(item.location||'Location not entered')}</strong><p>${esc(item.at)}${item.technician?' · '+esc(item.technician):''}</p><p>${item.kind==='pending'?'Waiting for Drive confirmation':'Unfinished test'}</p><button class="secondary" data-recovery="${index}">View report</button></article>`).join(''):'<p>No other unfinished tests were found on this device.</p>';
 $('#recovery-warning').hidden=!recovery.unreadable;
 $('#recovery-dialog').showModal();
}
async function openRecoveredTest(index){
 const item=recoveryEntries[index];
 if(!item||item.id.toLowerCase()===s.reportId.toLowerCase()||['saving','changing'].includes(reportMode)||!ioIdle())return;
 if(reportMode==='live'&&!save()){toast('Save or download the current test before opening another report.');return;}
 let candidate;
 try{candidate=item.kind==='pending'?freezeRecord(item.record):createReportRecord(item.draft,{id:item.id});}
 catch(error){toast(error.message||'This unfinished test could not be opened.');return;}
 recoveryContext||={reportMode,pendingRecord,savedRecord,savedReceipt,reportError,cacheError};
 reportMode='changing';stopReportActivity();$('#recovery-dialog').close();render();
 try{await usb.disconnect();pendingRecord=candidate;savedRecord=null;savedReceipt=null;reportError='';cacheError='';reportMode='pending';render(true);}
 catch(error){returnToCurrentTest();toast('The USB connection could not be closed: '+error.message);}
}
function returnToCurrentTest(){
 if(!recoveryContext||reportMode==='saving')return;
 ({reportMode,pendingRecord,savedRecord,savedReceipt,reportError,cacheError}=recoveryContext);
 recoveryContext=null;checksPaused=reportMode==='live';forkCurrentTestIfSaved();render(true);
}
function forkCurrentTestIfSaved(markerText){
 if(reportMode!=='live')return;
 try{const marker=JSON.parse(markerText??localStorage.getItem(savedKey(s.reportId)));validateSaveResult(marker?.receipt,s.reportId.toLowerCase());}catch{return;}
 s.reportId=crypto.randomUUID();save();
 toast('This test was saved in another window. Further work has a new report ID.');
}
function stopReportActivity(){
 advancePending=false;entry++;attempted=-1;resetComplete=-1;physicalDone=false;
 connection?.stop();usb?.stopMonitor();doorGuide?.stop();clearInterval(selftestTimer);selftestTimer=null;selftestDeadline=0;
 usb?.setControlsEnabled(false);
}
function refreshReportControls(){
 const changing=['saving','changing'].includes(reportMode),live=reportMode==='live',busy=!ioIdle();
 $('#save-report').textContent=reportMode==='saved'?'Saved to Drive':reportMode==='pending'?'Retry Save to Drive':'Save to Drive';
 $('#save-report').disabled=changing||reportMode==='saved'||busy||(live&&!hasReportData(s));
 $('#saved-reports').disabled=changing||busy;
 $('#restart').disabled=changing||busy;
 $('#recover-reports').disabled=changing||busy;
 $('#save-result')?.toggleAttribute('disabled',changing||busy||!hasReportData(s));
}
function renderReportView(focus=false){
 setContextPhoto();
 const record=pendingRecord||savedRecord;
 const saved=reportMode==='saved',saving=reportMode==='saving',changing=reportMode==='changing';
 const heading=changing?'Starting a new report…':saved?'Saved to Google Drive.':saving?'Save this report to Drive.':'This report is waiting to be saved.';
 const message=changing?'Finishing the USB connection before opening a blank report.':saved?'This is a read-only copy of the report confirmed by Google Drive.':saving?'Complete the Google sign-in and save in the report window. Keep this page open until Drive confirms the save.':'The report below is frozen. Retry Save sends the same report and ID, without replacing its observations or save time.';
 $('#stage-label').textContent=saved?'Saved report':'Save the result';
 $('#guide-usb-status').textContent=usb?.connected?'USB port open · checks stopped':'USB not connected';
 $('#progress').innerHTML=STAGES.map((text,i)=>`<li class="${i===3?'active':'done'}"><span class="progress-num">${i===3?'4':'✓'}</span><div>${text}</div></li>`).join('');
 $('#advanced-diagnostics').hidden=true;$('#advanced-diagnostics').open=false;
 usb?.setControlsEnabled(false);
 $('#storage-label').textContent=saved?'Report confirmed in Google Drive':cacheError?'Pending report cache needs attention':'Pending report kept for retry';
 $('#step').innerHTML=`<div class="eyebrow"><span class="mini-dot"></span>${saved?'SAVED REPORT':'REPORT STORAGE'}</div><div class="outcome-mark ${saved?'success':'unresolved'}" aria-hidden="true">${saved?'✓':'↗'}</div><h1>${heading}</h1><p class="lede">${message}</p>${reportError?`<p class="report-error" role="alert">${esc(reportError)}</p>`:''}${cacheError?`<p class="report-error" role="alert">${esc(cacheError)}</p>`:''}${record?`<dl class="saved-report-meta"><div><dt>Result</dt><dd>${esc(record.title)}</dd></div><div><dt>Location</dt><dd>${esc(record.location||'Not entered')}</dd></div><div><dt>Technician</dt><dd>${esc(record.technician||'Not entered')}</dd></div><div><dt>Report time</dt><dd>${esc(record.savedAt)}</dd></div></dl><details class="frozen-report"><summary>Read the frozen report and USB evidence</summary><pre>${esc(record.reportText)}</pre></details>`:''}<div class="step-actions report-view-actions">${saved&&savedReceipt?`<a class="secondary" href="${esc(savedReceipt.url)}" target="_blank" rel="noopener noreferrer">Open Drive report ↗</a>`:''}<button class="secondary" id="download-frozen" ${record?'':'disabled'}>Download copy</button>${saved?'<button class="primary" id="new-report-saved">New report</button>':`<button class="primary" id="retry-save" ${saving||changing?'disabled':''}>${saving?'Waiting for Drive…':'Retry Save to Drive'}</button>`}</div>${!saved&&!saving&&!changing?'<button class="text-button" id="new-report-pending">Save to Drive and start a new report</button>':''}`;
 $('#download-frozen')?.addEventListener('click',download);
 if(recoveryContext){
  $('#storage-label').textContent=saved?'Report confirmed in Google Drive':'Recovered report · read-only';
  $('#step').insertAdjacentHTML('afterbegin',`<div class="note"><p>This report was recovered from this device. It does not restart locker checks.</p><button class="secondary" id="close-recovered" ${saving||changing?'disabled':''}>Back to current test</button></div>`);
  $('#close-recovered').addEventListener('click',returnToCurrentTest);
 }
 $('#retry-save')?.addEventListener('click',()=>saveToDrive());
 $('#new-report-saved')?.addEventListener('click',requestNewReport);
 $('#new-report-pending')?.addEventListener('click',requestNewReport);
 refreshReportControls();
 if(focus){$('#step').focus({preventScroll:true});$('#main').scrollIntoView({behavior:'instant',block:'start'});}
}
async function saveToDrive({startNew=false}={}){
 if(['saving','changing'].includes(reportMode)||!ioIdle())return false;
 if(reportMode==='saved')return startNew?startFreshReport():true;
 if(reportMode==='live'&&!hasReportData(s)){toast('Add observations or complete a check before saving a report.');return false;}
 forkCurrentTestIfSaved();
 const wasLive=reportMode==='live';
 reportMode='saving';reportError='';cacheError='';
 stopReportActivity();
 try{
  if(!pendingRecord){s.usb=usb?.snapshot()||s.usb;s.reportId||=crypto.randomUUID();const candidate=createReportRecord(s,{id:s.reportId});buildReportPayload(payloadForDrive(candidate));pendingRecord=candidate;}
  // Keep the exact retry in this page too when device storage is full/blocked.
  volatilePending.set(pendingRecord.id.toLowerCase(),pendingRecord);
  cacheSet(pendingKey(pendingRecord.id),pendingRecord);if(wasLive)save();
  render(true);
  // Deliberately invoke save before the first await: it opens its authenticated
  // portal synchronously in the original Save click's user gesture.
  const operation=drive.save(payloadForDrive(pendingRecord));
  const receipt=await operation;
  savedRecord=pendingRecord;savedReceipt=freezeRecord(receipt);
  volatilePending.delete(savedRecord.id.toLowerCase());
  const receiptStored=cacheSet(savedKey(savedRecord.id),{schema:1,receipt:savedReceipt});
  if(receiptStored){cacheError='';cacheRemove(pendingKey(savedRecord.id));cacheRemove(draftKey(savedRecord.id));}else cacheError='Google Drive confirmed this report, but this browser could not retain its receipt. Use Saved reports to reopen it from Drive.';
  pendingRecord=null;reportMode='saved';reportError='';render(true);
  if(startNew)return startFreshReport();
  return true;
 }catch(error){reportMode=pendingRecord?'pending':'live';if(reportMode==='live')checksPaused=true;reportError=error?.message||'Google Drive has not confirmed this report. Retry with the same report.';render(true);return false;}
}
function resumeReport(){if(reportMode!=='live'||!ioIdle())return;checksPaused=false;render();enterStep();}
function openSavedReports(){if(['saving','changing'].includes(reportMode)||!ioIdle())return;if(reportMode==='live'){checksPaused=true;advancePending=false;connection.stop();usb.stopMonitor();render();}try{drive.openLibrary();}catch(error){toast(error.message||'The Google Drive report library could not be opened.');}}
function requestNewReport(){
 if(['saving','changing'].includes(reportMode)||!ioIdle())return;
 if(reportMode==='saved'||reportMode==='live'&&!hasReportData(s)){startFreshReport();return;}
 $('#restart-dialog').showModal();
}
async function startFreshReport(){
 if(['saving','changing'].includes(reportMode)||!ioIdle())return false;
 if(reportMode!=='saved'&&hasReportData(s)){requestNewReport();return false;}
 const previousMode=reportMode;reportMode='changing';reportError='';stopReportActivity();render();
 try{
  await usb?.disconnect();
  usb?.clear();
  const draft=freshSession();draft.mode='usb';draft.reportId=crypto.randomUUID();draft.usb=usb?.snapshot()||{};
  s=draft;doorGuide?.reset();usb?.refreshLayout?.();checksPaused=false;pendingRecord=null;savedRecord=null;savedReceipt=null;recoveryContext=null;photoSetup='flat-input-sense';buttonHelpSetup='';buttonHelpOpen=false;
  reportMode='live';entry++;attempted=-1;resetComplete=-1;physicalDone=false;readingBoard='';setContextPhoto();render(true);enterStep();
  return true;
 }catch(error){reportMode=previousMode;reportError='The new report could not be started: '+(error?.message||String(error));render(true);return false;}
}

const masterFacts=$('.reference-facts').innerHTML;
function contextSession(){return reportMode==='live'?s:(pendingRecord||savedRecord)?.session||s;}
function contextMaster(){return (reportMode==='live'?activeMaster():getDoorMaster(contextSession().doorTests))||masterFor(contextSession());}
function contextBoards(){const selected=detectedSelection(contextSession());return selected?[selected]:reportMode==='live'?(layoutReady()?activeBoards():[]):getDoorTargets(contextSession().doorTests);}
function photoExampleNote(){const selected=detectedSelection(contextSession());if(selected)return 'This report tests board '+selected+' only. These photos show a C-master reference system; they do not establish the role of the connected board.';return contextMaster()==='B'?'The photos show a C-master reference system. This 32-bay layout uses master B and slave A.':'';}
function updateLayoutDisplay(){const boards=contextBoards(),master=contextMaster(),selected=detectedSelection(contextSession());$('#board-map-row').innerHTML=boards.map(board=>`<span class="${!selected&&board===master?'master':''}">${board}${!selected&&board===master?'<small>MASTER</small>':''}</span>`).join('');$('#board-map-row').setAttribute('aria-label',selected?'Single-board test: '+selected:boards.length?`Boards ${boards.join(' ')} with ${master} as master`:'Select the locker capacity');$('#board-map-note').textContent=selected?'Testing board '+selected+' only. Locker master '+master+' has not been confirmed.':boards.length?`USB connects to ${master}. All slave boards talk to ${master}.`:'Select the locker capacity to see its columns and master.';$('#master-tab').textContent=!selected&&boards.length?'Master '+master:'Master example';$('#reference-caption').textContent=photoExampleNote();$('#reference-caption').hidden=!photoExampleNote();}
function setPhoto(value){
 photo=value;const setup=PHOTO_SETUPS[photoSetup];
 updateLayoutDisplay();
 document.querySelectorAll('[data-photo]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.photo===photo)));
 $('#reference-setup').value=photoSetup;$('#reference-photo').src=setup[photo];$('#reference-photo').alt=`${photo==='master'?'Master':'Slave'} reference example: ${setup.label}. ${photoExampleNote()}`;
 if(photoSetup==='flat-input-sense')$('.reference-facts').innerHTML=photo==='master'?masterFacts:`<div><i class="cable purple"></i><span>Rainbow link</span><strong>Power + UART to ${contextMaster()}</strong></div><div><i class="cable blue"></i><span>Front connectors</span><strong>Input Sense ribbons</strong></div>`;
 else $('.reference-facts').innerHTML=`<div><i class="cable blue"></i><span>Sensor headers</span><strong>Individual wires</strong></div><div><i class="cable purple"></i><span>Bank communication</span><strong>UART via master ${contextMaster()}</strong></div>${photo==='master'?'<div><i class="cable blue"></i><span>USB connection</span><strong>Master to PC</strong></div>':''}`;
}
function setContextPhoto(){const details=reportMode==='live'?s.details:(pendingRecord||savedRecord)?.session?.details;if(PHOTO_SETUPS[details?.boardConfiguration])photoSetup=details.boardConfiguration;setPhoto(['select','connector','swap','cable'].includes(s.step)?'slave':'master');}
function showBoardPhoto(setupId,role){const setup=PHOTO_SETUPS[setupId];if(!setup||!['master','slave'].includes(role))return;$('#full-photo').src=setup[role];$('#full-photo').alt=`${role==='master'?'Master':'Slave'} reference example: ${setup.label}. ${photoExampleNote()}`;$('#photo-title').textContent=`${role==='master'?'Master':'Slave'} reference · ${setup.label}`;$('#photo-caption').textContent=photoExampleNote()||'Reference photograph. Use the board letters and labels fitted to the locker.';$('#photo-dialog').showModal();}
document.querySelectorAll('[data-photo]').forEach(el=>el.addEventListener('click',()=>setPhoto(el.dataset.photo)));
$('#reference-setup').addEventListener('change',event=>{if(PHOTO_SETUPS[event.target.value]){photoSetup=event.target.value;setPhoto(photo);}});
$('#zoom-photo').addEventListener('click',()=>showBoardPhoto(photoSetup,photo));
$('#close-photo').addEventListener('click',()=>$('#photo-dialog').close());
$('#photo-dialog').addEventListener('click',e=>{if(e.target===$('#photo-dialog'))$('#photo-dialog').close();});
$('#save-report').addEventListener('click',()=>saveToDrive());
$('#saved-reports').addEventListener('click',openSavedReports);
$('#restart').addEventListener('click',requestNewReport);
$('#recover-reports').addEventListener('click',showUnfinishedTests);
$('#close-recovery').addEventListener('click',()=>$('#recovery-dialog').close());
$('#recovery-list').addEventListener('click',event=>{const button=event.target.closest('[data-recovery]');if(button)openRecoveredTest(Number(button.dataset.recovery));});
$('#cancel-restart').addEventListener('click',()=>$('#restart-dialog').close());
$('#confirm-restart').addEventListener('click',()=>{if(!ioIdle()||['saving','changing'].includes(reportMode))return;$('#restart-dialog').close();saveToDrive({startNew:true});});
s.mode='usb';
usb=mountUsbPanel($('#usb-root'),{saved:s.usb,getBoards:()=>layoutReady()?activeBoards():[],getMaster:activeMaster,onSave:data=>{if(reportMode!=='live')return;s.usb=data;save();},onConnection:state=>{if(reportMode!=='live'||checksPaused){refreshReportControls();return;}resetComplete=-1;if(state.connected)s.connection='connected';if(state.error)s.connectionIssue=true;if(!state.connected){const field={initial:'initial',recheck:'recheck',swap:'swapped'}[s.step];if(field)s[field]={};if(s.step==='cable')s.cable='';}else attempted=-1;if(connection&&s.step==='connect'&&!selectedBoard())connection.notifyConnection(state.connected);if(usb){save();render();queueMicrotask(maybeRunStep);}},onBusy:refreshControls});
function guidedChanged(){if(reportMode!=='live'||checksPaused||selectedBoard()||s.step!=='connect'||!usb)return;rememberDiscovery();if(snapshot().phase==='attention')advancePending=false;render();if(advancePending&&shouldProceed(snapshot(),activeMaster())&&!usb.busy)queueMicrotask(()=>{if(reportMode==='live'&&!checksPaused&&s.step==='connect'&&advancePending&&shouldProceed(snapshot(),activeMaster())&&!usb.busy){advancePending=false;next();}});}
doorGuide=createDoorGuide({document,getState:()=>s.doorTests,getBoards:testBoards,getMaster:testMaster,usb,isActive:()=>reportMode==='live'&&s.step==='doors'&&!checksPaused&&layoutReady(),onChange:()=>{save();refreshControls();},onBusy:refreshControls,onEvent:record});
connection=new GuidedConnection({isConnected:()=>usb.connected,getMaster:activeMaster,probe:master=>usb.check(master),discover:()=>usb.discoverBoards(),onStopDiscovery:()=>usb.stopDiscovery(),onChange:guidedChanged,onEvent:event=>record('Guided connection: '+event.message)});
if(reportMode==='live')save();setContextPhoto();render();if(reportMode==='live')enterStep();
// Back/forward navigation can revive an old document without running startup.
// Reset only on that restoration, never on focus returning from Google sign-in.
window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
window.addEventListener('storage',event=>{
 if(reportMode!=='live'||event.key!==savedKey(s.reportId)||!event.newValue)return;
 // A recovered copy may have been saved in another open window. Keep any
 // continued work here under a new ID rather than editing that saved record.
 forkCurrentTestIfSaved(event.newValue);
});
