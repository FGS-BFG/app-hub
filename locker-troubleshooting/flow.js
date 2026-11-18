import {freshDoorTests,doorTestsComplete,formatDoorTests} from './door-test.js?v=20261118-doors';

export const BOARDS = ['A', 'B', 'C', 'D', 'E'];
export const STAGES = ['Prepare the system', 'Check every board', 'Isolate the fault', 'Test one door per column', 'Save the result'];
export const STATES = ['responded', 'no-response'];
export const BOARD_CONFIGURATIONS = Object.freeze([
  Object.freeze({id:'flat-input-sense',label:'Flat Input Sense ribbon connections'}),
  Object.freeze({id:'individual-wires',label:'Individual sensor wires'}),
  Object.freeze({id:'mixed',label:'Mixed configurations across the banks'}),
  Object.freeze({id:'unsure',label:'Not sure'}),
]);
export function freshSession() {
  return {version:1, step:'welcome', details:{location:'', technician:'', notes:'', boardConfiguration:'', masterBoardLabel:'', slaveBoardLabels:'', configurationNotes:''}, connection:'', connectionIssue:false, initial:{}, recheck:{}, selftest:'', affected:'', neighbor:'', swapped:{}, cable:'', acknowledged:false, doorTests:freshDoorTests(), history:[], log:[], started:new Date().toISOString()};
}
export function allChecked(results, boards=BOARDS) { return boards.every(b=>STATES.includes(results[b])); }
export function allResponded(results) { return BOARDS.every(b=>results[b]==='responded'); }
export function failedBoards(results) { return BOARDS.filter(b=>results[b]==='no-response'); }
export function workingNeighbors(board, results) {
  const i=BOARDS.indexOf(board);
  if(i<0||board==='C') return [];
  return BOARDS.filter((b,j)=>Math.abs(i-j)===1&&b!=='C'&&results[b]==='responded');
}
export function swapFinding(s) {
  const a=s.swapped[s.affected], b=s.swapped[s.neighbor];
  if(!STATES.includes(a)||!STATES.includes(b)) return 'incomplete';
  if(a==='responded'&&b==='no-response') return 'moved';
  if(a==='no-response'&&b==='responded') return 'stayed';
  if(a==='responded'&&b==='responded') return 'cleared';
  return 'both-failed';
}
export function validateStep(s) {
  if(s.step==='identify') return BOARD_CONFIGURATIONS.some(option=>option.id===s.details?.boardConfiguration);
  if(s.step==='retry'&&s.connection==='unavailable') return false;
  if(s.step==='initial') return allChecked(s.initial);
  if(s.step==='recheck') return allChecked(s.recheck);
  if(s.step==='selftest') return ['ran','did-not-run','uncertain'].includes(s.selftest);
  if(s.step==='select') return s.recheck.C==='responded' && s.affected!=='C' && s.recheck[s.affected]==='no-response' && workingNeighbors(s.affected,s.recheck).includes(s.neighbor);
  if(s.step==='connector') return s.acknowledged===true;
  if(s.step==='swap') return swapFinding(s)!=='incomplete';
  if(s.step==='cable') return STATES.includes(s.cable)||s.cable==='uncertain';
  if(s.step==='doors') return doorTestsComplete(s.doorTests);
  return true;
}
export function nextStep(s) {
  if(!validateStep(s)) return null;
  if(s.step==='connect'&&s.connection==='unavailable') return 'selftest';
  const seq={welcome:'identify',identify:'power',power:'connect',startup:'connect',connect:'reset',reset:'initial',selftest:'retry',retry:'recheck',select:'connector',connector:'swap'};
  if(seq[s.step]) return seq[s.step];
  if(s.step==='initial') return allResponded(s.initial)?'doors':'selftest';
  if(s.step==='recheck') return allResponded(s.recheck)||s.recheck.C!=='responded'?'doors':'select';
  if(s.step==='swap') return swapFinding(s)==='moved'?'cable':'doors';
  if(s.step==='cable') return 'doors';
  if(s.step==='doors') return 'result';
  return null;
}
export function outcome(s) {
  const checks=allChecked(s.recheck)?s.recheck:s.initial;
  const remaining=failedBoards(checks);
  if(s.connection==='unavailable') return {kind:'unresolved',title:'The USB COM connection is unavailable',summary:allChecked(s.initial)?'The tester could not reconnect to master C. The repeat ISB check was not completed.':Object.keys(s.initial).length||s.usb?.checks?.length?'The USB connection was unavailable before the board checks could be completed.':'The tester could not connect to master C. No ISB checks were performed.',next:'Save the connection problem and self-test observation for support. An unavailable COM connection does not establish a board, cable or hub fault.'};
  if(Object.keys(s.checkErrors||{}).length) return {kind:'unresolved',title:'The USB check could not be completed',summary:'USB errors, controller messages or unexpected replies prevented a reliable result. Affected checks remain incomplete.',next:'Review the raw USB log and reconnect or repeat the affected check. These messages do not establish a failed board, cable or hub.'};
  if(allResponded(checks)) return {kind:'success', title:'All five boards responded', summary:'Communication was confirmed with A, B, C, D and E during this check.', next:s.mode==='usb'?'Use Watch sensor inputs while operating one locker at a time. Select one board for more frequent reads. Keep unexpected changes in the report. This confirms communication, not every locker function.':'Keep this report as the starting point for further locker and sensor tests. This confirms communication, not every locker function.'};
  if(allChecked(s.recheck)&&s.recheck.C!=='responded') return {kind:'unresolved',title:'Master C still needs investigation',summary:'C did not respond after the master reset and repeat ISB check.',next:'The slave cable comparison cannot reliably isolate this result. Save the report for support; no board, cable or hub fault has been established.'};
  const finding=swapFinding(s);
  if(finding==='moved'&&s.cable==='responded') return {kind:'possible',title:'The original cable could be responsible',summary:`The fault moved from ${s.affected} to ${s.neighbor} with the connection, then cleared with a known working cable.`,next:`Keep the original cable identified. The comparison used board ${s.neighbor} and the same suspect hub connection.`};
  if(finding==='moved'&&s.cable==='no-response') return {kind:'possible',title:'The hub connection could be responsible',summary:`Board ${s.neighbor} still did not respond with a known working cable on the same suspect hub connection.`,next:'Record the hub connection used and pass the results to support. This is an indication, not a confirmed hub diagnosis.'};
  if(finding==='moved') return {kind:'unresolved',title:'The fault followed the connection',summary:`The fault moved from ${s.affected} to ${s.neighbor}, but the cable replacement result is unconfirmed.`,next:'The cable or hub connection could be responsible. Save the observations without assigning a failed component.'};
  if(finding==='stayed') return {kind:'possible',title:`Board ${s.affected} could be responsible`,summary:`${s.affected} still did not respond after using the previously working connection. ${s.neighbor} responded.`,next:'Record the board letter and both test results. A board fault has not been confirmed.'};
  if(finding==='cleared') return {kind:'unresolved',title:'The fault is no longer present',summary:`Both ${s.affected} and ${s.neighbor} responded after the swap.`,next:'No component has been identified. Keep the connection changes and original failure recorded.'};
  if(finding==='both-failed') return {kind:'unresolved',title:'The swap did not isolate the fault',summary:`Neither ${s.affected} nor ${s.neighbor} responded after the swap.`,next:'Save both results and the connections changed. Do not assign the fault to one board, cable or hub from this test.'};
  return {kind:'unresolved',title:'Further investigation is needed',summary:remaining.length?`Boards without a response: ${remaining.join(', ')}.`:'The communication results are incomplete.',next:'There is no completed comparison with an adjacent working slave board. Save the report for support.'};
}
export function report(s, {savedAt = new Date().toISOString()} = {}) {
  const result=outcome(s), results=r=>BOARDS.map(b=>`  ${b}${b==='C'?' (master)':''}: ${r[b]??'not checked'}`).join('\n');
  const observed=value=>typeof value==='string'&&value.trim()?value:'Not recorded';
  const selected=BOARD_CONFIGURATIONS.find(option=>option.id===s.details.boardConfiguration);
  const configuration=selected?.label||(s.details.boardConfiguration?`Unrecognised selection: ${s.details.boardConfiguration}`:'Not recorded');
  const boardConfiguration=`BOARD CONFIGURATION\nOperator-observed setup: ${configuration}\nMaster board label: ${observed(s.details.masterBoardLabel)}\nSlave board labels: ${observed(s.details.slaveBoardLabels)}\nConfiguration notes: ${observed(s.details.configurationNotes)}`;
  return `MCI 304 LOCKER FIELD GUIDE\nMCI 304 troubleshooting session\n\nLocation: ${s.details.location||'Not entered'}\nTechnician: ${s.details.technician||'Not entered'}\nStarted: ${s.started}\nSaved: ${savedAt}\n\n${boardConfiguration}\n\nRESULT\n${result.title}\n${result.summary}\n${result.next}\n\nUSB COM CONNECTION\n${s.mode==='usb'?(s.usb?.connected?'Port open':'Port closed; completed checks remain historical observations'):(s.connection==='connected'?'Connected':s.connection==='unavailable'?'Unavailable':'Not recorded')}\n${s.connectionIssue?'A connection problem was recorded during this session.\n':''}\nINITIAL ISB CHECK\n${results(s.initial)}\n\nSELF-TEST\n${s.selftest||'Not performed'}\n\nISB CHECK AFTER RST#C\n${results(s.recheck)}\n\nCONNECTION COMPARISON\nOriginal affected board: ${s.affected||'Not selected'}\nAdjacent working slave: ${s.neighbor||'Not selected'}\nAfter swap: ${s.affected||'?'} ${s.swapped[s.affected]||'not checked'}; ${s.neighbor||'?'} ${s.swapped[s.neighbor]||'not checked'}\nKnown working cable on same hub connection: ${s.cable||'Not checked'}\n\n${formatDoorTests(s.doorTests)}\n\nNOTES\n${s.details.notes||'None'}\n\nSTEP RECORD\n${s.log.map(e=>`${e.at} | ${e.label}`).join('\n')}\n\n${s.mode==='usb'?'USB checks are recorded automatically by this browser. Physical actions and self-test observations are recorded by the operator.':'Commands were sent manually in the test application. Results above were recorded by the operator.'} Possible causes are not confirmed component diagnoses.\n${s.mode==='usb'?usbEvidence(s):''}`;
}
function usbEvidence(s){
 const data=s.usb||{};
 return `\nINCOMPLETE USB CHECKS\n${Object.entries(s.checkErrors||{}).map(([b,e])=>`${b}: ${e}`).join('\n')||'None recorded'}\n\nUSB MEASUREMENTS (most recent 600)\n9600 baud, 8N1. Raw bits are bank 1 followed by bank 0; input 1 is the rightmost bit. No open/closed polarity is assumed.\n${(data.checks||[]).map(r=>`${r.at} ISB#${r.board}: ${r.status}${r.bits?' (BIN) '+r.bits:''}${r.elapsedMs!=null?' '+r.elapsedMs+' ms':''}${r.error?' '+r.code+': '+r.error:''}`).join('\n')||'No USB measurements'}\n\nSENSOR AND USB OBSERVATIONS (most recent 120)\n${(data.observations||[]).map(r=>`${r.at} ${r.message}`).join('\n')||'None recorded'}\n\nRAW USB TRAFFIC (most recent 2000 events; RX strings retain delimiters as escapes)\n${(data.events||[]).map(r=>`${r.at} ${r.type.toUpperCase()} ${r.command||''} ${r.raw!==undefined?JSON.stringify(r.raw):r.message||r.code||''}`).join('\n')||'No traffic recorded'}\n`;
}
