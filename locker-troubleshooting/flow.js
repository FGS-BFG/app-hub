import {freshDoorTests,getDoorTargets,getDoorMaster,doorTestsComplete,formatDoorTests} from './door-test.js?v=20261118-door-response';
import {ALL_BOARDS,LAYOUTS,boardsFor,masterFor} from './layouts.js?v=20261118-master';
import {freshBoardDetection,validateBoardDetection,detectedSelection,formatBoardDetection} from './board-detection.js?v=20261118-detect';

import {freshBeforeRestart,beforeRestartComplete} from './before-restart.js?v=20261118-before-restart';

export const BEFORE_RESTART_COMMUNICATION = Object.freeze([
  Object.freeze({id:'all',label:'Yes, all columns respond'}),
  Object.freeze({id:'some',label:'Only some columns respond'}),
  Object.freeze({id:'none',label:'No columns respond'}),
  Object.freeze({id:'unsure',label:'Not sure'}),
]);
export const BOARDS = ALL_BOARDS;
export const STAGES = ['Prepare the system', 'Check every board', 'Isolate the fault', 'Test one door per column', 'Save the result'];
export const STATES = ['responded', 'no-response'];
export const LOCKER_CAPACITIES = Object.freeze([
  Object.freeze({id:'80',label:'80 bays'}),
  Object.freeze({id:'64',label:'64 bays'}),
  Object.freeze({id:'32',label:'32 bays'}),
]);
export const BOARD_CONFIGURATIONS = Object.freeze([
  Object.freeze({id:'flat-input-sense',label:'Flat Input Sense ribbon connections'}),
  Object.freeze({id:'individual-wires',label:'Individual sensor wires'}),
  Object.freeze({id:'mixed',label:'Mixed configurations across the banks'}),
  Object.freeze({id:'unsure',label:'Not sure'}),
]);
export function freshSession() {
  return {version:1, step:'welcome', details:{location:'', technician:'', notes:'', lockerCapacity:'', boardConfiguration:'', masterBoardLabel:'', slaveBoardLabels:'', configurationNotes:''}, beforeRestart:freshBeforeRestart(), boardDetection:freshBoardDetection(), connection:'', connectionIssue:false, initial:{}, recheck:{}, selftest:'', affected:'', neighbor:'', swapped:{}, cable:'', acknowledged:false, doorTests:freshDoorTests(), history:[], log:[], started:new Date().toISOString()};
}
const validBoards=boards=>Array.isArray(boards)&&boards.length>0&&new Set(boards).size===boards.length&&boards.every(board=>BOARDS.includes(board));
export function allChecked(results, boards=BOARDS) { return validBoards(boards)&&!!results&&boards.every(b=>STATES.includes(results[b])); }
export function allResponded(results, boards=BOARDS) { return validBoards(boards)&&!!results&&boards.every(b=>results[b]==='responded'); }
export function failedBoards(results, boards=BOARDS) { return validBoards(boards)?boards.filter(b=>results?.[b]==='no-response'):[]; }
export function workingNeighbors(board, results, boards=BOARDS,master='C') {
  if(!validBoards(boards)||!BOARDS.includes(master)||!boards.includes(board)||board===master)return[];
  const neighbors=LAYOUTS['80'].adjacentSlavePairs.filter(pair=>pair.includes(board)).flatMap(pair=>pair.filter(other=>other!==board));
  return boards.filter(other=>neighbors.includes(other)&&other!==master&&results?.[other]==='responded');
}
const canCompare=(s,boards)=>{const master=masterFor(s);return boards.includes(master)&&s.recheck[master]==='responded'&&s.recheck[s.affected]==='no-response'&&workingNeighbors(s.affected,s.recheck,boards,master).includes(s.neighbor);};
const currentErrors=(s,boards)=>Object.entries(s.checkErrors||{}).filter(([bank])=>!BOARDS.includes(bank)||boards.includes(bank));
export function swapFinding(s) {
  const a=s.swapped[s.affected], b=s.swapped[s.neighbor];
  if(!STATES.includes(a)||!STATES.includes(b)) return 'incomplete';
  if(a==='responded'&&b==='no-response') return 'moved';
  if(a==='no-response'&&b==='responded') return 'stayed';
  if(a==='responded'&&b==='responded') return 'cleared';
  return 'both-failed';
}
export function validateStep(s) {
  const boards=boardsFor(s);
  const selected=detectedSelection(s);
  if(s.step==='single-board')return !!selected&&s.boardDetection.checks.length>0;
  if(s.step==='welcome') return LOCKER_CAPACITIES.some(option=>option.id===s.details?.lockerCapacity);
  if(s.step==='identify') return boards.length>0&&BOARD_CONFIGURATIONS.some(option=>option.id===s.details?.boardConfiguration);
  if(s.step==='before-restart') return beforeRestartComplete(s.beforeRestart,boards);
  if(s.step==='retry'&&s.connection==='unavailable') return false;
  if(s.step==='initial') return allChecked(s.initial,boards);
  if(s.step==='recheck') return allChecked(s.recheck,boards);
  if(s.step==='selftest') return ['ran','did-not-run','uncertain'].includes(s.selftest);
  if(s.step==='select') return canCompare(s,boards);
  if(s.step==='connector') return canCompare(s,boards)&&s.acknowledged===true;
  if(s.step==='swap') return canCompare(s,boards)&&swapFinding(s)!=='incomplete';
  if(s.step==='cable') return canCompare(s,boards)&&(STATES.includes(s.cable)||s.cable==='uncertain');
  if(s.step==='doors') return (!s.boardDetection?.selection||!!selected)&&doorTestsComplete(s.doorTests,selected?[selected]:boards,selected?null:masterFor(s));
  return true;
}
export function nextStep(s) {
  if(!validateStep(s)) return null;
  const boards=boardsFor(s);
  const master=masterFor(s);
  if(s.step==='connect'&&s.connection==='unavailable') return 'selftest';
  const seq={welcome:'identify',identify:'before-restart','before-restart':'power',power:'connect',startup:'connect',connect:'reset',reset:'initial',selftest:'retry',retry:'recheck',select:'connector',connector:'swap','single-board':'doors'};
  if(seq[s.step]) return seq[s.step];
  if(s.step==='initial') return allResponded(s.initial,boards)?'doors':'selftest';
  if(s.step==='recheck') return allResponded(s.recheck,boards)||s.recheck[master]!=='responded'||!LAYOUTS['80'].adjacentSlavePairs.some(pair=>!pair.includes(master)&&pair.every(board=>boards.includes(board)))?'doors':'select';
  if(s.step==='swap') return swapFinding(s)==='moved'?'cable':'doors';
  if(s.step==='cable') return 'doors';
  if(s.step==='doors') return 'result';
  return null;
}
export function outcome(s) {
  try{validateBoardDetection(s.boardDetection);}catch{return{kind:'unresolved',title:'Board-detection evidence needs review',summary:'The detection or selected-board record could not be validated.',next:'Keep the original evidence. No board selection, locker communication result or component diagnosis is inferred from an invalid record.'};}
  const selected=detectedSelection(s);
  if(selected)return selectedBoardOutcome(s,selected);
  const boards=boardsFor(s);
  const master=masterFor(s);
  if(!boards.length)return{kind:'unresolved',title:'Locker layout is not confirmed',summary:'The selected capacity does not have a confirmed board map. Communication and door-test completion cannot be established.',next:'Record which columns are installed and confirm the master before running locker checks. No board, cable, hub or door fault has been established.'};
  const checks=allChecked(s.recheck,boards)?s.recheck:s.initial;
  const remaining=failedBoards(checks,boards);
  if(s.connection==='unavailable') return {kind:'unresolved',title:'The USB COM connection is unavailable',summary:allChecked(s.initial,boards)?`The tester could not reconnect to master ${master}. The repeat ISB check was not completed.`:Object.keys(s.initial).length||s.usb?.checks?.length?'The USB connection was unavailable before the board checks could be completed.':`The tester could not connect to master ${master}. No ISB checks were performed.`,next:'Save the connection problem and self-test observation for support. An unavailable COM connection does not establish a board, cable or hub fault.'};
  if(currentErrors(s,boards).length) return {kind:'unresolved',title:'The USB check could not be completed',summary:'USB errors, controller messages or unexpected replies prevented a reliable result. Affected checks remain incomplete.',next:'Review the raw USB log and reconnect or repeat the affected check. These messages do not establish a failed board, cable or hub.'};
  if(allResponded(checks,boards)) return {kind:'success', title:boards.length===5?'All five boards responded':boards.length===4?'All four boards responded':boards.length===2?'Both boards responded':`All ${boards.length} boards responded`, summary:'Communication was confirmed with '+(boards.length===2?boards.join(' and '):boards.slice(0,-1).join(', ')+' and '+boards.at(-1))+' during this check.', next:s.mode==='usb'?'Use Watch sensor inputs while operating one locker at a time. Select one board for more frequent reads. Keep unexpected changes in the report. This confirms communication, not every locker function.':'Keep this report as the starting point for further locker and sensor tests. This confirms communication, not every locker function.'};
  if(allChecked(s.recheck,boards)&&s.recheck[master]!=='responded') return {kind:'unresolved',title:`Master ${master} still needs investigation`,summary:`${master} did not respond after the master reset and repeat ISB check.`,next:'The slave cable comparison cannot reliably isolate this result. Save the report for support; no board, cable or hub fault has been established.'};
  const finding=canCompare(s,boards)?swapFinding(s):'incomplete';
  if(finding==='moved'&&s.cable==='responded') return {kind:'possible',title:'The original cable could be responsible',summary:`The fault moved from ${s.affected} to ${s.neighbor} with the connection, then cleared with a known working cable.`,next:`Keep the original cable identified. The comparison used board ${s.neighbor} and the same suspect hub connection.`};
  if(finding==='moved'&&s.cable==='no-response') return {kind:'possible',title:'The hub connection could be responsible',summary:`Board ${s.neighbor} still did not respond with a known working cable on the same suspect hub connection.`,next:'Record the hub connection used and pass the results to support. This is an indication, not a confirmed hub diagnosis.'};
  if(finding==='moved') return {kind:'unresolved',title:'The fault followed the connection',summary:`The fault moved from ${s.affected} to ${s.neighbor}, but the cable replacement result is unconfirmed.`,next:'The cable or hub connection could be responsible. Save the observations without assigning a failed component.'};
  if(finding==='stayed') return {kind:'possible',title:`Board ${s.affected} could be responsible`,summary:`${s.affected} still did not respond after using the previously working connection. ${s.neighbor} responded.`,next:'Record the board letter and both test results. A board fault has not been confirmed.'};
  if(finding==='cleared') return {kind:'unresolved',title:'The fault is no longer present',summary:`Both ${s.affected} and ${s.neighbor} responded after the swap.`,next:'No component has been identified. Keep the connection changes and original failure recorded.'};
  if(finding==='both-failed') return {kind:'unresolved',title:'The swap did not isolate the fault',summary:`Neither ${s.affected} nor ${s.neighbor} responded after the swap.`,next:'Save both results and the connections changed. Do not assign the fault to one board, cable or hub from this test.'};
  return {kind:'unresolved',title:'Further investigation is needed',summary:remaining.length?`Boards without a response: ${remaining.join(', ')}.`:'The communication results are incomplete.',next:'There is no completed comparison with an adjacent working slave board. Save the report for support.'};
}
function selectedBoardOutcome(s,board){
  const latest=s.boardDetection.checks.at(-1);
  const next='This limited result concerns communication with the selected board only, not door functionality or the rest of the locker. No RST was performed on the limited single-board path.';
  if(!latest)return{kind:'unresolved',title:`Board ${board} check is pending (single-board check)`,summary:`Board ${board} was detected and explicitly selected. A subsequent selected-board ISB check has not been recorded.`,next};
  if(latest.status==='responded')return{kind:'success',title:`Board ${board} responded (single-board check)`,summary:`Communication was confirmed with board ${board} only during the selected-board check. No other board or locker-master identity was confirmed.`,next};
  return{kind:'unresolved',title:latest.status==='no-response'?`Board ${board} did not respond (single-board check)`:`Board ${board} check is incomplete (single-board check)`,summary:latest.status==='no-response'?`The latest selected-board check did not receive a reply from ${board}. This is not a hardware diagnosis.`:`The latest selected-board check recorded ${latest.code||'an error'}${latest.error?': '+latest.error:'.'} No component fault has been established.`,next};
}
export function report(s, {savedAt = new Date().toISOString()} = {}) {
  const boards=boardsFor(s);
  const master=masterFor(s);
  let recordedBoards=[],recordedMaster=null,invalidContext=false;
  try{recordedBoards=getDoorTargets(s.doorTests);recordedMaster=getDoorMaster(s.doorTests);}catch{invalidContext=true;}
  const contextMismatch=invalidContext||recordedMaster!==master||recordedBoards.length!==boards.length||recordedBoards.some(bank=>!boards.includes(bank));
  const resetHeading=recordedMaster?'ISB CHECK AFTER RST#'+recordedMaster:'ISB CHECK AFTER RESET (master not confirmed)';
  const masterCaption=contextMismatch?'Current layout master':'Master board';
  const contextNotice=contextMismatch?'\n\nRECORDED CONTROLLER CONTEXT\nRecorded columns: '+(recordedBoards.join(', ')||'Not confirmed')+'\nRecorded master: '+(recordedMaster||'Not confirmed')+'\nExpected layout columns: '+(boards.join(', ')||'Not confirmed')+'\nExpected layout master: '+(master||'Not confirmed')+'\nThe recorded controller context differs from the current capacity mapping. Stage readings and the reset heading retain their recorded context; no controller address has been rewritten.'+(invalidContext?' The recorded context could not be validated.':''):'';
  const result=outcome(s), results=r=>recordedBoards.length?recordedBoards.map(b=>`  ${b}${b===recordedMaster?' (master)':''}: ${r[b]??'not checked'}`).join('\n'):'  Not checked: the locker layout is not confirmed.';
  const observed=value=>typeof value==='string'&&value.trim()?value:'Not recorded';
  const capacity=LOCKER_CAPACITIES.find(option=>option.id===s.details.lockerCapacity)?.label||'Not recorded';
  const selected=BOARD_CONFIGURATIONS.find(option=>option.id===s.details.boardConfiguration);
  const configuration=selected?.label||(s.details.boardConfiguration?`Unrecognised selection: ${s.details.boardConfiguration}`:'Not recorded');
  const boardConfiguration=`BOARD CONFIGURATION\nOperator-observed setup: ${configuration}\nMaster board label: ${observed(s.details.masterBoardLabel)}\nSlave board labels: ${observed(s.details.slaveBoardLabels)}\nConfiguration notes: ${observed(s.details.configurationNotes)}`;
  const detected=detectedSelection(s);
  if(detected)return singleBoardReport(s,{savedAt,board:detected,boards,master,capacity,boardConfiguration,result});
  return `MCI 304 LOCKER FIELD GUIDE\nMCI 304 troubleshooting session\n\nLocation: ${s.details.location||'Not entered'}\nLocker capacity: ${capacity}\n${masterCaption}: ${master||'Not confirmed'}\nTechnician: ${s.details.technician||'Not entered'}\nStarted: ${s.started}\nSaved: ${savedAt}\n\n${boardConfiguration}${contextNotice}\n\n${formatBeforeRestart(s)}\n\n${formatBoardDetection(s.boardDetection)}\n\nRESULT\n${result.title}\n${result.summary}\n${result.next}\n\nUSB COM CONNECTION\n${s.mode==='usb'?(s.usb?.connected?'Port open':'Port closed; completed checks remain historical observations'):(s.connection==='connected'?'Connected':s.connection==='unavailable'?'Unavailable':'Not recorded')}\n${s.connectionIssue?'A connection problem was recorded during this session.\n':''}\nINITIAL ISB CHECK\n${results(s.initial)}\n\nSELF-TEST\n${s.selftest||'Not performed'}\n\n${resetHeading}\n${results(s.recheck)}\n\nCONNECTION COMPARISON\nOriginal affected board: ${s.affected||'Not selected'}\nAdjacent working slave: ${s.neighbor||'Not selected'}\nAfter swap: ${s.affected||'?'} ${s.swapped[s.affected]||'not checked'}; ${s.neighbor||'?'} ${s.swapped[s.neighbor]||'not checked'}\nKnown working cable on same hub connection: ${s.cable||'Not checked'}${historicalReadings(s,recordedBoards)}\n\n${formatDoorTests(s.doorTests,boards,master)}\n\nNOTES\n${s.details.notes||'None'}\n\nSTEP RECORD\n${s.log.map(e=>`${e.at} | ${e.label}`).join('\n')}\n\n${s.mode==='usb'?'USB checks are recorded automatically by this browser. Physical actions and self-test observations are recorded by the operator.':'Commands were sent manually in the test application. Results above were recorded by the operator.'} Possible causes are not confirmed component diagnoses.\n${s.mode==='usb'?usbEvidence(s,recordedBoards):''}`;
}
function singleBoardReport(s,{savedAt,board,boards,master,capacity,boardConfiguration,result}){
 const connection=s.mode==='usb'?(s.usb?.connected?'Port open':'Port closed; completed checks remain historical observations'):(s.connection==='connected'?'Connected':s.connection==='unavailable'?'Unavailable':'Not recorded');
 return `MCI 304 LOCKER FIELD GUIDE\nMCI 304 troubleshooting session\n\nLocation: ${s.details.location||'Not entered'}\nLocker capacity: ${capacity} (context only)\nConfigured layout columns (context only): ${boards.join(', ')||'Not confirmed'}\nConfigured layout master (context only): ${master||'Not confirmed'}\nTechnician: ${s.details.technician||'Not entered'}\nStarted: ${s.started}\nSaved: ${savedAt}\n\n${boardConfiguration}\n\n${formatBeforeRestart(s)}\n\nRESULT\n${result.title}\n${result.summary}\n${result.next}\n\nSINGLE-BOARD TEST SCOPE\nExplicit operator choice: Test detected board ${board} only.\nNo locker-master role is assigned to this board. Other columns and full-locker communication were not assessed on this limited path.\nNo RST was performed on the limited single-board path.\n\n${formatBoardDetection(s.boardDetection)}\n\nUSB COM CONNECTION\n${connection}\n\n${formatDoorTests(s.doorTests,[board],null)}\n\nNOTES\n${s.details.notes||'None'}\n\nSTEP RECORD\n${s.log.map(entry=>`${entry.at} | ${entry.label}`).join('\n')}\n\nUSB checks are recorded automatically by this browser. Physical actions and self-test observations are recorded by the operator. Possible causes are not confirmed component diagnoses.\n${s.mode==='usb'?usbEvidence(s,[board]):''}`;
}
function formatBeforeRestart(s){
 const observation=s.beforeRestart;
 if(!observation?.communication&&!observation?.notes)return 'BEFORE RESTART — OPERATOR OBSERVATION\nNot recorded.';
 const label=BEFORE_RESTART_COMMUNICATION.find(option=>option.id===observation.communication)?.label||'Not recorded';
 const unavailable=observation.communication==='none'?boardsFor(s).join(', '):observation.communication==='all'?'None':observation.communication==='some'?(observation.unresponsiveBoards.join(', ')||'Not selected'):'Not known';
 return `BEFORE RESTART — OPERATOR OBSERVATION\nSource: parkIT app, as reported by the operator. This is separate from the guide USB measurements.\nRecorded: ${observation.recordedAt||'Draft only; not confirmed before restart'}\nCommunication: ${label}\nColumns reported not responding: ${unavailable}\nNotes: ${observation.notes||'None'}`;
}
function historicalReadings(s,boards){
 const lines=[];
 for(const[field,label]of [['initial','Initial ISB'],['recheck','Repeat ISB'],['swapped','After swap']]){
  for(const bank of BOARDS)if(!boards.includes(bank)&&STATES.includes(s[field]?.[bank]))lines.push(`${label} ${bank}: ${s[field][bank]}`);
 }
 for(const[bank,error]of Object.entries(s.checkErrors||{}))if(BOARDS.includes(bank)&&!boards.includes(bank))lines.push(`USB check ${bank}: ${error}`);
 return lines.length?'\n\nHISTORICAL READINGS OUTSIDE THE CURRENT LAYOUT\nThese recorded observations are retained as history, not current missing-column or fault findings.\n'+lines.join('\n'):'';
}
function usbEvidence(s,boards){
 const data=s.usb||{};
 return `\nINCOMPLETE USB CHECKS\n${currentErrors(s,boards).map(([b,e])=>`${b}: ${e}`).join('\n')||'None recorded'}\n\nUSB MEASUREMENTS (most recent 600)\n9600 baud, 8N1. Raw bits are bank 1 followed by bank 0; input 1 is the rightmost bit. No open/closed polarity is assumed.\n${(data.checks||[]).map(r=>`${r.at} ISB#${r.board}: ${r.status}${r.bits?' (BIN) '+r.bits:''}${r.elapsedMs!=null?' '+r.elapsedMs+' ms':''}${r.error?' '+r.code+': '+r.error:''}`).join('\n')||'No USB measurements'}\n\nSENSOR AND USB OBSERVATIONS (most recent 120)\n${(data.observations||[]).map(r=>`${r.at} ${r.message}`).join('\n')||'None recorded'}\n\nRAW USB TRAFFIC (most recent 2000 events; RX strings retain delimiters as escapes)\n${(data.events||[]).map(r=>`${r.at} ${r.type.toUpperCase()} ${r.command||''} ${r.raw!==undefined?JSON.stringify(r.raw):r.message||r.code||''}`).join('\n')||'No traffic recorded'}\n`;
}
