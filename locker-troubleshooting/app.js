import {BOARDS,STAGES,STATES,freshSession,allChecked,failedBoards,workingNeighbors,validateStep,nextStep,outcome,report} from './flow.js?v=20261117-drive';
import {mountUsbPanel} from './usb-ui.js?v=20261117-drive';
import {GuidedConnection,shouldProceed} from './guided-connection.js?v=20261117-drive';
import {createReportRecord,payloadForDrive,hasReportData} from './report-record.js';
import {DriveReportClient,validateSaveResult,buildReportPayload} from './drive-reports.js';
import {FIELD_REPORTS} from './drive-config.js';

const KEY='fgs-mci-guided-usb-v4';
const PENDING_KEY=KEY+'-pending-report',SAVED_KEY=KEY+'-saved-report';
const drive=new DriveReportClient({endpoint:FIELD_REPORTS.endpoint});
let checksPaused=false;
let reportMode='live',pendingRecord=null,savedRecord=null,savedReceipt=null,reportError='',cacheError='';
const stages={welcome:0,power:0,startup:0,connect:0,reset:0,initial:1,selftest:1,retry:2,recheck:2,select:2,connector:2,swap:2,cable:2,result:3};
const $=q=>document.querySelector(q);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let s=freshSession(),restored=false,usb,connection;
try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved?.version===1&&Object.hasOwn(stages,saved.step)){s={...s,...saved,details:{...s.details,...saved.details}};for(const key of ['initial','recheck','swapped'])if(!s[key]||typeof s[key]!=='object')s[key]={};if(!Array.isArray(s.log))s.log=[];if(!Array.isArray(s.history))s.history=[];restored=true;}}catch{}
const restoredDraftId=s.reportId;
s.reportId||=crypto.randomUUID();
restoreReportView();
let entry=0,attempted=-1,checking=false,resetComplete=-1,physicalDone=false,readingBoard='',photo='master';
let selftestDeadline=0,selftestTimer=null,advancePending=false;
const snapshot=()=>connection?.snapshot()||{phase:'waiting',remainingSeconds:60};
function cacheSet(key,value){try{const text=JSON.stringify(value);localStorage.setItem(key,text);if(localStorage.getItem(key)!==text)throw Error('The browser did not retain the report.');return true;}catch{cacheError='This browser cannot keep a local retry copy. Keep this page open and download a copy. Saving to Google Drive can still be attempted.';return false;}}
function cacheRemove(key){try{localStorage.removeItem(key);return true;}catch{cacheError='The current report is saved, but this browser could not finish clearing its old cache.';return false;}}
function save(){const ok=cacheSet(KEY,s);if(!ok)$('#storage-label').textContent='Browser progress could not be saved';return ok;}
function record(label){if(reportMode!=='live')return;s.log.push({at:new Date().toISOString(),label});save();}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),2400);}
function clearComparison(){s.affected='';s.neighbor='';s.swapped={};s.cable='';s.acknowledged=false;}
function ioIdle(){return !checking&&!usb?.busy;}
function idle(){return reportMode==='live'&&ioIdle();}
function go(step,label){if(reportMode!=='live')return;advancePending=false;connection.stop();usb.stopMonitor();clearInterval(selftestTimer);selftestTimer=null;selftestDeadline=0;s.history.push(s.step);if(label)record(label);s.step=step;entry++;attempted=-1;resetComplete=-1;physicalDone=false;readingBoard='';save();setContextPhoto();render(true);enterStep();}
function enterStep(){if(reportMode!=='live'||checksPaused)return;if(s.step==='connect'){connection.start();connection.notifyConnection(usb.connected);}else queueMicrotask(maybeRunStep);}
function maybeRunStep(){if(reportMode!=='live'||checksPaused||!usb?.connected||!idle()||attempted===entry)return;if(['reset','retry'].includes(s.step)){attempted=entry;sendReset();}else if(['initial','recheck'].includes(s.step)){attempted=entry;runChecks(s.step,BOARDS);}}
function canProceed(){if(reportMode!=='live'||checksPaused)return false;if(s.step==='connect')return !checking&&!advancePending&&usb.connected&&shouldProceed(snapshot());if(!idle())return false;if(['reset','retry'].includes(s.step))return usb.connected&&resetComplete===entry;if(s.step==='connector')return true;if(['swap','cable'].includes(s.step)&&!physicalDone)return usb.connected;if(['initial','recheck','swap','cable'].includes(s.step)&&Object.keys(s.checkErrors||{}).length)return false;return validateStep(s);}
function nextLabel(){if(s.step==='welcome')return restored?'Continue the guide':'Start the guide';if(s.step==='swap'&&!physicalDone)return 'Connections swapped · Next';if(s.step==='cable'&&!physicalDone)return 'Cable replaced · Next';return 'Next';}
function actions(){return `<div class="step-actions"><button id="back" class="back" ${s.history.length&&idle()?'':'disabled'}>← Back</button><button id="next" class="primary" ${canProceed()?'':'disabled'}>${nextLabel()} <span aria-hidden="true">→</span></button></div>`;}
function note(text){return `<div class="note">${text}</div>`;}
function success(title,text){return `<div class="guide-status good"><span aria-hidden="true">✓</span><div><strong>${title}</strong><p>${text}</p></div></div>`;}
function waiting(title,text){return `<div class="guide-status waiting"><span class="guide-spinner" aria-hidden="true"></span><div><strong>${title}</strong><p>${text}</p></div></div>`;}
function warning(){return `<div class="warning"><span class="warning-icon" aria-hidden="true">△</span><div><strong>Align each D9 connector carefully.</strong><p>Keep the pins and housing aligned. Do not force a connector. Misalignment can cause sparks, incorrect connections and board damage.</p></div></div>`;}
function connectButton(){return `<button class="primary" id="guide-connect" ${usb.connected||!idle()||!usb.supported?'disabled':''}>Choose the locker USB port</button>`;}
function reconnect(){return !usb.connected?`<div class="guide-status attention"><div><strong>The USB port is disconnected.</strong><p>Connect the black USB cable. Close the other locker applications, then choose the locker port.</p>${connectButton()}</div></div>`:'';}
function problemExit(){return Object.keys(s.checkErrors||{}).length||!usb.connected?`<div class="guide-help">${Object.keys(s.checkErrors||{}).length?'<p>This check is incomplete. A USB error or unexpected reply does not identify a faulty board.</p>':''}<button class="secondary" id="retry-step" ${usb.connected&&idle()?'':'disabled'}>Try this check again</button><button class="text-button" id="finish-incomplete" ${idle()?'':'disabled'}>Save the incomplete result for support</button></div>`:'';}
function boardResults(field,boards=BOARDS){const values=field==='cable'?{[s.neighbor]:s.cable}:s[field];return `<div class="guided-board-results" aria-label="Automatic board checks">${boards.map(b=>{const state=values[b];const text=state==='responded'?'Reply received':state==='no-response'?'No reply before the timeout':s.checkErrors?.[b]?'Check incomplete':checking&&readingBoard===b?'Checking now…':'Waiting for this check';return `<div class="guided-board-row ${state==='responded'?'pass':state==='no-response'||s.checkErrors?.[b]?'fail':''}"><b>${b}</b><div><strong>${b==='C'?'Master C':'Board '+b}</strong><span>${esc(text)}</span></div><span aria-hidden="true">${state==='responded'?'✓':checking&&readingBoard===b?'…':'·'}</span></div>`;}).join('')}</div>`;}
function connectionContent(){
 if(checksPaused)return `<h1>The connection check is paused.</h1><p class="lede">Your report is unchanged. When you are ready, restart the 60-second connection check before continuing.</p><button class="primary" id="retry-connection">Check the connection again</button>${actions()}`;
 const c=snapshot();
 if(!usb.supported)return `<h1>Open the guide in Chrome or Edge.</h1><p class="lede">Use a desktop browser on the computer connected to the lockers. This browser cannot access the USB COM port.</p><button class="secondary" id="connection-unavailable">Continue with the physical self-test</button>${actions()}`;
 let status;
 if(c.phase==='ready')status=advancePending?waiting('Finishing the current connection check…','We will continue automatically when this reply has been checked.'):success('We are happy with the connection.','Master C has replied throughout the 60-second check. Select Next to reset the master.');
 else if(c.phase==='watching')status=success('Master C is responding.',`We are checking that it stays connected. ${c.remainingSeconds} seconds remain.`);
 else if(c.phase==='attention')status=`<div class="guide-status attention"><span aria-hidden="true">?</span><div><strong>${c.reason==='connection-timeout'?'It has been 60 seconds. Are the power and USB cable connected?':'We need to check the connection again.'}</strong><p>Make sure the lockers have power. Connect the black USB cable to this computer. Close Phil’s app and the FGS tester.</p><p>${esc(c.reason==='connection-timeout'?'We have not received a valid reply from master C.':'The last check did not confirm a reply from master C. This does not identify a faulty board.')}</p></div></div>`;
 else status=waiting(usb.connected?'The USB port is open. Checking master C…':'Waiting for the locker USB connection.',usb.connected?'We will confirm the connection from an actual board reply.':`Choose the locker COM port below. We will check with you again in ${c.remainingSeconds} seconds.`);
 return `<h1>${c.phase==='ready'?'The connection is ready.':'Connect the black USB cable.'}</h1><p class="lede">Connect master C to this computer. Select the locker COM port when the browser asks.</p>${status}${['watching','waiting'].includes(c.phase)?`<div class="guide-countdown" role="progressbar" aria-label="${c.phase==='watching'?'Connection stability check':'Connection wait'}" aria-valuemin="0" aria-valuemax="60" aria-valuenow="${Math.max(0,60-c.remainingSeconds)}"><span style="width:${Math.max(0,Math.min(100,(60-c.remainingSeconds)/60*100))}%"></span></div>`:''}${!usb.connected?connectButton():''}${c.phase==='attention'?`<div class="guide-help"><button class="primary" id="retry-connection" ${idle()?'':'disabled'}>Check the connection again</button>${usb.connected?'<button class="secondary" id="disconnect-guide">Choose a different USB port</button>':''}<button class="text-button" id="connection-unavailable" ${idle()?'':'disabled'}>I cannot connect · run the physical self-test</button></div>`:''}${actions()}`;
}
function content(){switch(s.step){
 case 'welcome':return `<div class="intro-mark" aria-hidden="true">▦</div><h1>Let’s check the lockers.<br>One step at a time.</h1><p class="lede">We will tell you what to do and check the board replies automatically.</p><p>Start with the mains supply. Then connect the USB cable when the guide asks.</p><div class="fields welcome-details"><label class="field">Location <span class="optional">optional</span><input data-detail="location" maxlength="100" value="${esc(s.details.location)}"></label><label class="field">Your name <span class="optional">optional</span><input data-detail="technician" maxlength="100" value="${esc(s.details.technician)}"></label></div>${actions()}`;
 case 'power':case 'startup':return `<h1>Turn the locker power off.<br>Then turn it back on.</h1><ol class="physical-steps"><li>Switch off the mains supply to the locker system.</li><li>Switch it back on.</li><li>Wait for the system to finish starting.</li></ol>${note('Restarting the PC alone does not cycle the locker mains supply.')}<p>When the system is back on, select Next. We will connect the USB cable next.</p>${actions()}`;
 case 'connect':return connectionContent();
 case 'reset':case 'retry':return `<h1>${resetComplete===entry?'The reset command has been sent.':'We will reset master C.'}</h1><p class="lede">Keep the USB cable connected. We send the reset command to C only.</p>${reconnect()}${checking?waiting('Resetting master C…','Wait for the master’s five-second reset sequence. You do not need to type a command.'):resetComplete===entry?success('The reset wait is complete.','Select Next. We will check all five boards automatically.'):usb.connected?waiting('Preparing the reset…','The guide will send RST to master C.'):''}${note('A reset sent to a slave does not perform a meaningful system reset. The board checks verify communication after the master reset.')}${problemExit()}${actions()}`;
 case 'initial':case 'recheck':{const complete=allChecked(s[s.step]);return `<h1>${checking?'We are checking each board.':complete?'The board checks are complete.':'Check all five boards.'}</h1><p class="lede">Keep the USB cable connected. We check A, B, C, D and E one at a time.</p>${reconnect()}${boardResults(s.step)}${checking?'<p>You do not need to press anything while the checks run.</p>':complete&&!failedBoards(s[s.step]).length?success('All five boards replied.','We are happy with communication during this check. Select Next to see the result.'):complete?note('One or more boards did not reply. Select Next. We will guide you through the next check.'):''}${problemExit()}${actions()}`;}
 case 'selftest':return `<h1>Hold the red button<br>for 10 seconds.</h1><p class="lede">Use the red button on master C, directly in front of the black USB cable.</p><p>Press and hold the physical button. Use the timer below to help you hold it for 10 seconds.</p><div class="timer-wrap"><div><div class="timer-number" id="timer-number">${selftestDeadline?Math.max(0,Math.ceil((selftestDeadline-Date.now())/1000)):10} s</div><div class="timer-help" id="timer-help">Hold the physical button while the timer runs.</div></div><button class="secondary" id="timer-start">Start 10-second timer</button></div><p>Did the self-test start?</p><div class="choices">${[['ran','Yes, the self-test started'],['did-not-run','No, it did not start'],['uncertain','I could not confirm it']].map(([value,text])=>`<button class="choice ${s.selftest===value?'selected':''}" data-selftest="${value}" aria-pressed="${s.selftest===value}">${text}</button>`).join('')}</div>${note('A running self-test shows that the board can execute it. It does not confirm communication or every firmware function.')}<p>Select Next. We will reset master C and try the board checks again.</p>${actions()}`;
 case 'select':{const failed=failedBoards(s.recheck).filter(b=>b!=='C');const neighbors=workingNeighbors(s.affected,s.recheck);const anyPair=failed.some(b=>workingNeighbors(b,s.recheck).length);return `<h1>Choose one board<br>to investigate.</h1><p class="lede">We will compare an affected slave with a working slave next to it.</p><div class="fields"><label class="field">Board that did not reply<select id="affected"><option value="">Choose a board</option>${failed.map(b=>`<option value="${b}" ${s.affected===b?'selected':''}>Board ${b}</option>`).join('')}</select></label><label class="field">Working board next to it<select id="neighbor" ${neighbors.length?'':'disabled'}><option value="">Choose a working board</option>${neighbors.map(b=>`<option value="${b}" ${s.neighbor===b?'selected':''}>Board ${b}</option>`).join('')}</select></label></div>${note('Keep each board identified by its letter. Master C is not a slave for this comparison.')}${!anyPair||(s.affected&&!neighbors.length)?'<p>No adjacent working slave is available for this comparison.</p><button class="secondary" id="finish-incomplete">Save this result for support</button>':''}${actions()}`;}
 case 'connector':return `<h1>Before you move<br>the connections.</h1><p class="lede">We will compare board ${s.affected} with working board ${s.neighbor}.</p>${warning()}<p>Read these handling instructions. Then select Next to see which connections to swap.</p>${actions()}`;
 case 'swap':return !physicalDone?`<h1>Swap the connections<br>on ${s.affected} and ${s.neighbor}.</h1><p class="lede">Swap the communication connections at the two boards. Each board must now use the other board’s cable and hub connection.</p>${warning()}<p>Keep the board letters unchanged. If these connections are already swapped, leave them in place. Select Next when ready. We will check both boards.</p>${reconnect()}${actions()}`:`<h1>${checking?'We are checking both boards.':'The connection comparison is complete.'}</h1>${boardResults('swapped',[s.affected,s.neighbor])}${reconnect()}${problemExit()}${actions()}`;
 case 'cable':return !physicalDone?`<h1>Replace the suspect cable<br>with a working cable.</h1><p class="lede">Keep board ${s.neighbor} on the same suspect hub connection. Change only the cable.</p>${warning()}<p>When the working cable is in place, select Next. We will check board ${s.neighbor} again.</p>${reconnect()}<button class="text-button" id="cable-uncertain">I cannot complete this cable comparison</button>${actions()}`:`<h1>${checking?'We are checking the replacement cable.':'The cable check is complete.'}</h1>${boardResults('cable',[s.neighbor])}${reconnect()}${problemExit()}${actions()}`;
 case 'result':{const r=outcome(s);const values=allChecked(s.recheck)?s.recheck:s.initial;return `<div class="outcome-mark ${r.kind}" aria-hidden="true">${r.kind==='success'?'✓':'?'}</div><h1>${esc(r.title)}</h1><p class="lede">${esc(r.summary)}</p><div class="result-callout"><p>${esc(r.next)}</p></div><p class="check-progress">${allChecked(s.recheck)?'Repeat':'Initial'} board checks · before connection swaps</p><div class="result-chips">${BOARDS.map(b=>`<span>${b} · ${values[b]==='responded'?'replied':values[b]==='no-response'?'no reply':'not checked'}</span>`).join('')}</div><label class="field notes-label">Anything else you observed <span class="optional">optional</span><textarea data-detail="notes" maxlength="10000">${esc(s.details.notes)}</textarea></label><div class="step-actions result-actions"><button class="back" id="back" ${s.history.length&&idle()?'':'disabled'}>← Back</button><div class="report-actions"><button class="secondary" id="copy-report">Copy report</button><button class="secondary" id="download-report">Download copy</button><button class="primary" id="save-result">Save to Drive</button></div></div><button class="text-button" id="open-diagnostics">Open sensor monitoring and the USB log</button>`;}
 }}
function render(focus=false){
 if(reportMode!=='live'){renderReportView(focus);return;}
 const stage=stages[s.step];$('#stage-label').textContent=STAGES[stage];$('#guide-usb-status').textContent=usb?.connected?'USB port open':'USB not connected';
 $('#progress').innerHTML=STAGES.map((text,i)=>`<li class="${i===stage?'active':i<stage?'done':''}" ${i===stage?'aria-current="step"':''}><span class="progress-num">${i<stage?'✓':i+1}</span><div>${text}<small>${['Power, USB and master reset','Automatic board replies','Follow the next physical test','Save the evidence to Drive'][i]}</small></div></li>`).join('');
 $('#step').innerHTML=`<div class="eyebrow"><span class="mini-dot"></span>${stage===3?'YOUR RESULT':STAGES[stage]}</div>${content()}`;
 usb?.setControlsEnabled(s.step==='result'&&!checksPaused);refreshReportControls();$('#advanced-diagnostics').hidden=false;
 $('#storage-label').textContent=cacheError?'Browser progress could not be saved':'Draft kept on this device';
 if(checksPaused&&s.step!=='connect')$('#step').insertAdjacentHTML('afterbegin','<div class="note"><p>Automatic locker checks are paused.</p><button class="secondary" id="resume-report">Resume this report</button></div>');
 $('#resume-report')?.addEventListener('click',resumeReport);
 if(reportError||cacheError)$('#step').insertAdjacentHTML('afterbegin',`<p class="report-error" role="alert">${esc(reportError||cacheError)}</p>`);
 $('#next')?.addEventListener('click',next);
 $('#back')?.addEventListener('click',()=>{if(!idle())return;const previous=s.history.pop();if(previous){connection.stop();usb.stopMonitor();s.step=previous;entry++;attempted=-1;resetComplete=-1;physicalDone=false;save();setContextPhoto();render(true);enterStep();}});
 $('#guide-connect')?.addEventListener('click',()=>{if(idle())usb.connect();});
 $('#retry-connection')?.addEventListener('click',()=>{if(!idle())return;checksPaused=false;record('Operator requested a new connection check');connection.retry();connection.notifyConnection(usb.connected);});
 $('#disconnect-guide')?.addEventListener('click',()=>{if(idle())usb.disconnect();});
 $('#connection-unavailable')?.addEventListener('click',()=>{if(!idle())return;s.connection='unavailable';s.connectionIssue=true;s.initial={};s.recheck={};s.selftest='';s.checkErrors={};clearComparison();go('selftest','USB connection could not be verified; continuing to the physical self-test');});
 $('#retry-step')?.addEventListener('click',()=>{if(!idle())return;attempted=-1;if(['swap','cable'].includes(s.step))runChecks(s.step==='swap'?'swapped':'cable',s.step==='swap'?[s.affected,s.neighbor]:[s.neighbor]);else maybeRunStep();});
 $('#finish-incomplete')?.addEventListener('click',()=>{if(!idle())return;if(!usb.connected)s.connection='unavailable';go('result','Incomplete check saved for support');});
 $('#cable-uncertain')?.addEventListener('click',()=>{if(!idle())return;s.cable='uncertain';go('result','Operator could not complete the cable comparison');});
 document.querySelectorAll('[data-detail]').forEach(el=>el.addEventListener('input',()=>{if(reportMode!=='live')return;s.details[el.dataset.detail]=el.value;save();refreshReportControls();}));
 document.querySelectorAll('[data-selftest]').forEach(el=>el.addEventListener('click',()=>{if(!idle())return;s.selftest=el.dataset.selftest;save();render();}));
 $('#affected')?.addEventListener('change',e=>{if(!idle())return;s.affected=e.target.value;s.neighbor='';s.swapped={};s.cable='';s.acknowledged=false;save();render();});
 $('#neighbor')?.addEventListener('change',e=>{if(!idle())return;s.neighbor=e.target.value;s.swapped={};s.cable='';s.acknowledged=false;save();render();});
 $('#timer-start')?.addEventListener('click',()=>{if(!idle())return;selftestDeadline=Date.now()+10000;clearInterval(selftestTimer);selftestTimer=setInterval(updateSelftestTimer,100);updateSelftestTimer();});
 $('#copy-report')?.addEventListener('click',()=>copy(report(s),'Report copied'));
 $('#download-report')?.addEventListener('click',download);
 $('#save-result')?.addEventListener('click',()=>saveToDrive());
 $('#open-diagnostics')?.addEventListener('click',()=>{$('#advanced-diagnostics').open=true;$('#advanced-diagnostics').scrollIntoView({behavior:'smooth',block:'start'});});
 if(focus){$('#step').focus({preventScroll:true});$('#main').scrollIntoView({behavior:'instant',block:'start'});}
}
function refreshControls(){if(!usb)return;refreshReportControls();if(reportMode!=='live')return;if($('#next'))$('#next').disabled=!canProceed();if($('#back'))$('#back').disabled=!idle()||!s.history.length;if($('#guide-connect'))$('#guide-connect').disabled=usb.connected||!idle()||!usb.supported;for(const id of ['retry-connection','disconnect-guide','finish-incomplete','connection-unavailable'])if($('#'+id))$('#'+id).disabled=!idle();queueMicrotask(maybeRunStep);}
function updateSelftestTimer(){if(reportMode!=='live'||s.step!=='selftest'){clearInterval(selftestTimer);selftestTimer=null;return;}const seconds=Math.max(0,Math.ceil((selftestDeadline-Date.now())/1000));if($('#timer-number'))$('#timer-number').textContent=seconds+' s';if($('#timer-help'))$('#timer-help').textContent=seconds?'Keep holding the physical red button.':'10 seconds have passed. Tell us whether the self-test started.';if(!seconds){clearInterval(selftestTimer);selftestTimer=null;}}
function next(){if(!canProceed())return;if(s.step==='connect'&&usb.busy){advancePending=true;render();return;}if(s.step==='power'||s.step==='startup'){go('connect','Operator confirmed the locker mains cycle and startup');return;}if(s.step==='connect'){s.connection='connected';go('reset','Master C passed the 60-second guided connection check');return;}if(s.step==='connector')s.acknowledged=true;if(['swap','cable'].includes(s.step)&&!physicalDone){physicalDone=true;record(s.step==='swap'?`Operator confirmed the connection swap at ${s.affected} and ${s.neighbor}`:`Operator confirmed a working cable on board ${s.neighbor} and the same hub connection`);runChecks(s.step==='swap'?'swapped':'cable',s.step==='swap'?[s.affected,s.neighbor]:[s.neighbor]);return;}const step=nextStep(s);if(step)go(step,stepRecord());}
async function sendReset(){if(reportMode!=='live'||!usb.connected||!idle())return;const ownEntry=entry;checking=true;resetComplete=-1;if(s.step==='reset'){s.initial={};s.selftest='';}s.recheck={};s.checkErrors={};clearComparison();save();render();try{await usb.reset();if(reportMode!=='live'||entry!==ownEntry)return;resetComplete=entry;s.connection='connected';record('USB RST#C transmitted; six-second reset wait completed. Subsequent board checks verify communication.');}catch(e){s.checkErrors={...s.checkErrors,RST:e.message};record('Master reset check incomplete: '+e.message);}finally{checking=false;save();render();}}
async function runChecks(field,boards){
 if(!usb.connected||!idle())return;checking=true;const ownEntry=entry;
 if(field==='initial'){s.recheck={};s.selftest='';clearComparison();}else if(field==='recheck')clearComparison();else if(field==='swapped')s.cable='';
 s.checkErrors||={};delete s.checkErrors.USB;for(const b of boards){delete s.checkErrors[b];if(field==='cable')s.cable='';else delete s[field][b];}readingBoard=boards[0];record(`Starting automatic USB ${field} check: ${boards.join(', ')}`);render();
 try{await usb.scan(boards,result=>{if(reportMode!=='live'||entry!==ownEntry)return;if(result.status==='error')s.checkErrors[result.board]=result.error;else{if(field==='cable')s.cable=result.status;else s[field][result.board]=result.status;delete s.checkErrors[result.board];s.connection='connected';}record(`USB ${field} ISB#${result.board}: ${result.status}${result.bits?' (BIN) '+result.bits:''}${result.error?' — '+result.error:''}`);readingBoard=boards[boards.indexOf(result.board)+1]||'';render();});}catch(e){s.checkErrors.USB=e.message;record('Automatic USB check incomplete: '+e.message);}finally{checking=false;readingBoard='';save();render();}
}
function stepRecord(){if(['initial','recheck'].includes(s.step))return s.step+' board checks reviewed';if(s.step==='selftest')return 'Operator self-test observation: '+s.selftest;if(s.step==='select')return `Comparison selected: ${s.affected} and working slave ${s.neighbor}`;if(s.step==='connector')return 'Operator acknowledged the D9 alignment instructions by selecting Next';if(s.step==='swap')return `Swap results: ${s.affected} ${s.swapped[s.affected]}; ${s.neighbor} ${s.swapped[s.neighbor]}`;if(s.step==='cable')return 'Replacement cable result: '+s.cable;return s.step+' completed';}
async function copy(text,message){try{await navigator.clipboard.writeText(text);toast(message);}catch{toast('Use Download report to save the evidence.');}}
function download(){downloadText(reportMode==='live'?report(s):(pendingRecord||savedRecord)?.reportText||'');}
function downloadText(text){if(!text)return;const record=pendingRecord||savedRecord;const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='locker-check-'+(record?.savedAt||new Date().toISOString()).slice(0,10)+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Copy downloaded. Drive saving is separate.');}

function freezeRecord(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeRecord(child);Object.freeze(value);}return value;}
function restoreReportView(){
 try{const raw=localStorage.getItem(PENDING_KEY);if(raw){const record=JSON.parse(raw);payloadForDrive(record);if(!restoredDraftId||record.id===restoredDraftId){pendingRecord=freezeRecord(record);reportMode='pending';}}}catch{reportError='The stored pending report could not be read. The current draft has been retained.';}
 try{const raw=localStorage.getItem(SAVED_KEY);if(raw){const data=JSON.parse(raw);payloadForDrive(data.record);const receipt=validateSaveResult(data.receipt,data.record.id.toLowerCase());if((!restoredDraftId||data.record.id===restoredDraftId)&&(!pendingRecord||pendingRecord.id===data.record.id&&pendingRecord.reportText===data.record.reportText)){savedRecord=freezeRecord(data.record);savedReceipt=freezeRecord(receipt);pendingRecord=null;reportMode='saved';}}}catch{if(reportMode!=='pending')reportError='The saved report receipt could not be restored. Open Saved reports to check Google Drive.';}
}
function stopReportActivity(){
 advancePending=false;entry++;attempted=-1;resetComplete=-1;physicalDone=false;
 connection?.stop();usb?.stopMonitor();clearInterval(selftestTimer);selftestTimer=null;selftestDeadline=0;
 usb?.setControlsEnabled(false);
}
function refreshReportControls(){
 const changing=['saving','changing'].includes(reportMode),live=reportMode==='live',busy=!ioIdle();
 $('#save-report').textContent=reportMode==='saved'?'Saved to Drive':reportMode==='pending'?'Retry Save to Drive':'Save to Drive';
 $('#save-report').disabled=changing||reportMode==='saved'||busy||(live&&!hasReportData(s));
 $('#saved-reports').disabled=changing||busy;
 $('#restart').disabled=changing||busy;
 $('#save-result')?.toggleAttribute('disabled',changing||busy||!hasReportData(s));
}
function renderReportView(focus=false){
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
 const wasLive=reportMode==='live';
 reportMode='saving';reportError='';cacheError='';
 stopReportActivity();
 try{
  if(!pendingRecord){s.usb=usb?.snapshot()||s.usb;s.reportId||=crypto.randomUUID();const candidate=createReportRecord(s,{id:s.reportId});buildReportPayload(payloadForDrive(candidate));pendingRecord=candidate;}
  cacheSet(PENDING_KEY,pendingRecord);if(wasLive)save();
  render(true);
  // Deliberately invoke save before the first await: it opens its authenticated
  // portal synchronously in the original Save click's user gesture.
  const operation=drive.save(payloadForDrive(pendingRecord));
  const receipt=await operation;
  savedRecord=pendingRecord;savedReceipt=freezeRecord(receipt);
  const receiptStored=cacheSet(SAVED_KEY,{schema:1,record:savedRecord,receipt:savedReceipt});
  if(receiptStored){cacheError='';cacheRemove(PENDING_KEY);}else cacheError='Google Drive confirmed this report, but this browser could not retain its receipt. Use Saved reports to reopen it from Drive.';
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
  if(!cacheSet(KEY,draft)){reportMode=previousMode;render(true);return false;}
  s=draft;restored=false;checksPaused=false;pendingRecord=null;savedRecord=null;savedReceipt=null;
  cacheRemove(PENDING_KEY);cacheRemove(SAVED_KEY);
  reportMode='live';entry++;attempted=-1;resetComplete=-1;physicalDone=false;readingBoard='';setContextPhoto();render(true);enterStep();
  return true;
 }catch(error){reportMode=previousMode;reportError='The new report could not be started: '+(error?.message||String(error));render(true);return false;}
}

const masterFacts=$('.reference-facts').innerHTML;
function setPhoto(value){photo=value;document.querySelectorAll('[data-photo]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.photo===photo)));$('#reference-photo').src=`assets/${photo}.png`;$('#reference-photo').alt=photo==='master'?'Master C connections and the red self-test button in front of the black USB cable':'Slave board communication and sensor connections';$('.reference-facts').innerHTML=photo==='master'?masterFacts:'<div><i class="cable purple"></i><span>Rainbow link</span><strong>Power + UART to C</strong></div><div><i class="cable blue"></i><span>Front connectors</span><strong>Sensor inputs</strong></div>';}
function setContextPhoto(){setPhoto(['select','connector','swap','cable'].includes(s.step)?'slave':'master');}
document.querySelectorAll('[data-photo]').forEach(el=>el.addEventListener('click',()=>setPhoto(el.dataset.photo)));
$('#zoom-photo').addEventListener('click',()=>{$('#full-photo').src=`assets/${photo}.png`;$('#full-photo').alt=$('#reference-photo').alt;$('#photo-title').textContent=photo==='master'?'Master C connections':'Slave board connections';$('#photo-dialog').showModal();});
$('#close-photo').addEventListener('click',()=>$('#photo-dialog').close());
$('#photo-dialog').addEventListener('click',e=>{if(e.target===$('#photo-dialog'))$('#photo-dialog').close();});
$('#save-report').addEventListener('click',()=>saveToDrive());
$('#saved-reports').addEventListener('click',openSavedReports);
$('#restart').addEventListener('click',requestNewReport);
$('#cancel-restart').addEventListener('click',()=>$('#restart-dialog').close());
$('#confirm-restart').addEventListener('click',()=>{if(!ioIdle()||['saving','changing'].includes(reportMode))return;$('#restart-dialog').close();saveToDrive({startNew:true});});
s.mode='usb';
usb=mountUsbPanel($('#usb-root'),{saved:s.usb,onSave:data=>{if(reportMode!=='live')return;s.usb=data;save();},onConnection:state=>{if(reportMode!=='live'||checksPaused){refreshReportControls();return;}resetComplete=-1;if(state.connected)s.connection='connected';if(state.error)s.connectionIssue=true;if(!state.connected){const field={initial:'initial',recheck:'recheck',swap:'swapped'}[s.step];if(field)s[field]={};if(s.step==='cable')s.cable='';}else attempted=-1;if(connection&&s.step==='connect')connection.notifyConnection(state.connected);if(usb){save();render();queueMicrotask(maybeRunStep);}},onBusy:refreshControls});
function guidedChanged(){if(reportMode!=='live'||checksPaused||s.step!=='connect'||!usb)return;if(snapshot().phase==='attention')advancePending=false;render();if(advancePending&&shouldProceed(snapshot())&&!usb.busy)queueMicrotask(()=>{if(reportMode==='live'&&!checksPaused&&s.step==='connect'&&advancePending&&shouldProceed(snapshot())&&!usb.busy){advancePending=false;next();}});}
connection=new GuidedConnection({isConnected:()=>usb.connected,probe:()=>usb.check('C'),onChange:guidedChanged,onEvent:event=>record('Guided connection: '+event.message)});
if(reportMode==='live')save();setContextPhoto();render();if(reportMode==='live')enterStep();
