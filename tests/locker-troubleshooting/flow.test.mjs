import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARDS, BOARD_CONFIGURATIONS, freshSession, allChecked, allResponded, failedBoards,
  workingNeighbors, swapFinding, validateStep, nextStep, outcome, report,
} from '../../locker-troubleshooting/flow.js';

const replies = (...failed) => Object.fromEntries(
  BOARDS.map(board => [board, failed.includes(board) ? 'no-response' : 'responded']),
);

test('the guide asks for board identification after location and before the power cycle', () => {
  const s=freshSession();
  assert.equal(s.details.location,'');
  assert.equal(s.details.boardConfiguration,'');
  assert.equal(s.details.masterBoardLabel,'');
  assert.equal(s.details.slaveBoardLabels,'');
  assert.equal(s.details.configurationNotes,'');
  assert.equal(nextStep(s),'identify');
  assert.equal(nextStep({...s,step:'identify'}),null);
  assert.equal(nextStep({...s,step:'identify',details:{...s.details,boardConfiguration:'individual-wires'}}),'power');
  assert.equal(nextStep({...s,step:'power'}),'connect');
});

test('identification needs an explicit recognised choice and allows mixed or uncertain setups',()=>{
  assert.deepEqual(BOARD_CONFIGURATIONS.map(option=>option.id),['flat-input-sense','individual-wires','mixed','unsure']);
  for(const boardConfiguration of BOARD_CONFIGURATIONS.map(option=>option.id)){
    const s={...freshSession(),step:'identify'};s.details.boardConfiguration=boardConfiguration;
    assert.equal(validateStep(s),true);
    assert.equal(nextStep(s),'power');
  }
  for(const boardConfiguration of ['',undefined,null,'new firmware','C']){
    const s={...freshSession(),step:'identify'};s.details.boardConfiguration=boardConfiguration;
    assert.equal(validateStep(s),false);
    assert.equal(nextStep(s),null);
  }
});

test('reports preserve operator identification without deriving firmware or changing communication findings',()=>{
  const s=freshSession();s.initial=replies();
  const before=outcome(s);
  Object.assign(s.details,{boardConfiguration:'mixed',masterBoardLabel:'C label as printed',slaveBoardLabels:'A: label one; E: label two',configurationNotes:'Different connections on the end banks.'});
  const text=report(s,{savedAt:'2026-11-18T10:00:00.000Z'});
  assert.match(text,/BOARD CONFIGURATION\nOperator-observed setup: Mixed configurations across the banks/);
  assert.match(text,/Master board label: C label as printed/);
  assert.match(text,/Slave board labels: A: label one; E: label two/);
  assert.match(text,/Configuration notes: Different connections on the end banks\./);
  assert.deepEqual(outcome(s),before);
  assert.doesNotMatch(text,/Firmware:/);
  s.details={location:'',technician:'',notes:''};
  const old=report(s);
  assert.match(old,/Operator-observed setup: Not recorded/);
  assert.match(old,/Master board label: Not recorded/);
  assert.match(old,/Slave board labels: Not recorded/);
  assert.match(old,/Configuration notes: Not recorded/);
});
function comparison(a='responded', b='no-response') {
  return {
    ...freshSession(), step:'swap', initial:replies('A'), recheck:replies('A'),
    affected:'A', neighbor:'B', swapped:{A:a, B:b},
  };
}

test('new sessions have no assumed test outcomes and do not share mutable state', () => {
  const one=freshSession(), two=freshSession();
  assert.deepEqual(one.initial, {});
  assert.deepEqual(one.recheck, {});
  assert.deepEqual(one.swapped, {});
  assert.equal(one.selftest, '');
  assert.equal(one.acknowledged, false);
  assert.equal(one.details.location, '');
  one.initial.A='responded';
  one.details.technician='Technician';
  assert.deepEqual(two.initial, {});
  assert.equal(two.details.technician, '');
});

test('initial ISB check requires an explicit valid answer for every board', () => {
  const s={...freshSession(), step:'initial'};
  for(const board of BOARDS) {
    assert.equal(validateStep(s), false);
    assert.equal(nextStep(s), null);
    s.initial[board]='responded';
  }
  assert.equal(validateStep(s), true);
  assert.equal(nextStep(s), 'result');
  s.initial.C='unknown';
  assert.equal(allChecked(s.initial), false);
  assert.equal(nextStep(s), null);
});

test('all five replies confirm communication without claiming every locker function works', () => {
  const s={...freshSession(), step:'initial', initial:replies()};
  assert.equal(allResponded(s.initial), true);
  const result=outcome(s);
  assert.equal(result.kind, 'success');
  assert.equal(result.title, 'All five boards responded');
  assert.match(result.next, /not every locker function/i);
});

test('an unavailable COM connection reaches the physical self-test without inventing ISB failures', () => {
  const s={...freshSession(), step:'connect', connection:'unavailable', connectionIssue:true};
  s.step=nextStep(s);
  assert.equal(s.step, 'selftest');
  assert.deepEqual(s.initial, {});
  assert.deepEqual(s.recheck, {});
  assert.equal(nextStep(s), null);
  s.selftest='ran';
  s.step=nextStep(s);
  assert.equal(s.step, 'retry');
  assert.equal(validateStep(s), false);
  assert.equal(nextStep(s), null);
  s.step='result';
  const finding=outcome(s), text=report(s);
  assert.equal(finding.kind, 'unresolved');
  assert.match(finding.title, /USB COM connection is unavailable/);
  assert.match(finding.summary, /No ISB checks were performed/);
  assert.match(text, /USB COM CONNECTION\nUnavailable/);
  assert.match(text, /A: not checked/);
  assert.match(text, /C \(master\): not checked/);
  assert.doesNotMatch(text, /A: no-response|C \(master\): no-response/);
  assert.doesNotMatch(finding.summary, /C did not respond|after the master reset/);
});

test('a recovered COM connection permits the actual master reset and fresh five-board check', () => {
  const s={...freshSession(), step:'retry', connection:'unavailable', connectionIssue:true, selftest:'uncertain'};
  assert.equal(nextStep(s), null);
  s.connection='connected';
  s.step=nextStep(s);
  assert.equal(s.step, 'recheck');
  assert.equal(nextStep(s), null);
  for(const board of BOARDS) s.recheck[board]='responded';
  assert.equal(nextStep(s), 'result');
  assert.equal(outcome(s).kind, 'success');
  const text=report(s);
  assert.match(text, /USB COM CONNECTION\nConnected/);
  assert.match(text, /A connection problem was recorded during this session/);
  assert.match(text, /INITIAL ISB CHECK\n  A: not checked/);
  assert.match(text, /ISB CHECK AFTER RST#C\n  A: responded/);
});

test('failed boards are listed in physical board order', () => {
  assert.deepEqual(failedBoards(replies('E','A')), ['A','E']);
  assert.deepEqual(failedBoards({A:'responded'}), []);
});

test('each initial failure follows self-test, master reset and a fresh five-board check', () => {
  for(const failed of BOARDS) {
    const s={...freshSession(), step:'initial', initial:replies(failed)};
    s.step=nextStep(s);
    assert.equal(s.step, 'selftest');
    assert.equal(nextStep(s), null);
    s.selftest='ran';
    s.step=nextStep(s);
    assert.equal(s.step, 'retry');
    s.step=nextStep(s);
    assert.equal(s.step, 'recheck');
    assert.equal(nextStep(s), null);
    s.recheck=replies();
    assert.equal(nextStep(s), 'result');
    assert.equal(outcome(s).kind, 'success');
  }
});

test('failed or uncertain self-test does not invent a failed component or skip the reset retry', () => {
  for(const answer of ['ran','did-not-run','uncertain']) {
    const s={...freshSession(), step:'selftest', initial:replies('A'), selftest:answer};
    assert.equal(validateStep(s), true);
    assert.equal(nextStep(s), 'retry');
    assert.equal(outcome(s).kind, 'unresolved');
  }
});

test('master C failure after reset stops the slave comparison without assigning hardware blame', () => {
  const s={...freshSession(), step:'recheck', initial:replies('A','C'), recheck:replies('C')};
  assert.equal(nextStep(s), 'result');
  assert.equal(outcome(s).kind, 'unresolved');
  assert.match(outcome(s).title, /Master C/);
  assert.match(outcome(s).next, /no board, cable or hub fault has been established/);
});

test('physical comparison neighbours must respond and must be slaves', () => {
  const good=replies();
  assert.deepEqual(workingNeighbors('A',good), ['B']);
  assert.deepEqual(workingNeighbors('B',good), ['A']);
  assert.deepEqual(workingNeighbors('C',good), []);
  assert.deepEqual(workingNeighbors('D',good), ['E']);
  assert.deepEqual(workingNeighbors('E',good), ['D']);
  assert.deepEqual(workingNeighbors('A',replies('B')), []);
  assert.deepEqual(workingNeighbors('B',replies('A')), []);
  assert.deepEqual(workingNeighbors('unknown',good), []);
});

test('a selected comparison requires the affected slave to have failed and its neighbour to have responded', () => {
  const s={...comparison(), step:'select'};
  assert.equal(validateStep(s), true);
  assert.equal(nextStep(s), 'connector');
  for(const change of [
    {affected:'B', neighbor:'A'},
    {affected:'A', neighbor:'C'},
    {affected:'A', neighbor:'D'},
    {affected:'C', neighbor:'B'},
    {recheck:replies('A','B')},
    {recheck:replies('A','C')},
  ]) {
    assert.equal(validateStep({...s,...change}), false, JSON.stringify(change));
    assert.equal(nextStep({...s,...change}), null);
  }
});

test('no working slave comparison produces an unresolved report rather than four board diagnoses', () => {
  const s={...freshSession(), step:'select', initial:replies('A','B','D','E'), recheck:replies('A','B','D','E')};
  assert.equal(validateStep(s), false);
  assert.equal(outcome(s).kind, 'unresolved');
  assert.match(outcome(s).summary, /A, B, D, E/);
  assert.match(outcome(s).next, /no completed comparison/i);
});

test('the D9 warning must be acknowledged before entering the swap test', () => {
  const s={...comparison(), step:'connector'};
  assert.equal(nextStep(s), null);
  s.acknowledged=true;
  assert.equal(nextStep(s), 'swap');
});

test('swap interpretation waits for separate explicit results from both named boards', () => {
  const s=comparison();
  s.swapped={A:'responded'};
  assert.equal(swapFinding(s), 'incomplete');
  assert.equal(validateStep(s), false);
  assert.equal(nextStep(s), null);
});

test('a fault moving to the comparison board leads to the cable check', () => {
  const s=comparison('responded','no-response');
  assert.equal(swapFinding(s), 'moved');
  assert.equal(nextStep(s), 'cable');
  assert.equal(outcome(s).kind, 'unresolved');
  assert.match(outcome(s).summary, /from A to B/);
});

test('a fault staying on the original board is a possible board fault only', () => {
  const s=comparison('no-response','responded');
  assert.equal(swapFinding(s), 'stayed');
  assert.equal(nextStep(s), 'result');
  assert.equal(outcome(s).title, 'Board A could be responsible');
  assert.equal(outcome(s).kind, 'possible');
  assert.match(outcome(s).next, /not been confirmed/);
});

test('both boards responding after the swap does not identify a failed component', () => {
  const s=comparison('responded','responded');
  assert.equal(swapFinding(s), 'cleared');
  assert.equal(nextStep(s), 'result');
  assert.equal(outcome(s).kind, 'unresolved');
  assert.match(outcome(s).next, /No component has been identified/);
});

test('both boards failing after the swap is inconclusive', () => {
  const s=comparison('no-response','no-response');
  assert.equal(swapFinding(s), 'both-failed');
  assert.equal(nextStep(s), 'result');
  assert.equal(outcome(s).kind, 'unresolved');
  assert.match(outcome(s).title, /did not isolate/);
});

test('cable replacement requires an explicit result and keeps the same hub comparison', () => {
  const s={...comparison(), step:'cable'};
  assert.equal(nextStep(s), null);
  for(const response of ['responded','no-response','uncertain']) {
    const checked={...s,cable:response};
    assert.equal(nextStep(checked), 'result');
    const result=outcome(checked);
    if(response==='responded') {
      assert.equal(result.kind, 'possible');
      assert.match(result.title, /original cable could/);
      assert.match(result.next, /board B and the same suspect hub connection/);
    } else if(response==='no-response') {
      assert.equal(result.kind, 'possible');
      assert.match(result.title, /hub connection could/);
      assert.match(result.summary, /Board B.*same suspect hub connection/);
      assert.match(result.next, /not a confirmed hub diagnosis/);
    } else {
      assert.equal(result.kind, 'unresolved');
      assert.match(result.summary, /unconfirmed/);
    }
  }
});

test('report preserves operator observations, step records and untested fields', () => {
  const s={...comparison(), cable:'no-response'};
  s.details={location:'Site A', technician:'Operator 1', notes:'Original A cable moved to B.'};
  s.selftest='uncertain';
  s.log=[{at:'2026-11-17T16:00:00.000Z', label:'Sent RST#C manually'}];
  const text=report(s);
  assert.match(text, /^MCI 304 LOCKER FIELD GUIDE\n/);
  assert.match(text, /Location: Site A/);
  assert.match(text, /Technician: Operator 1/);
  assert.match(text, /SELF-TEST\nuncertain/);
  assert.match(text, /After swap: A responded; B no-response/);
  assert.match(text, /Known working cable on same hub connection: no-response/);
  assert.match(text, /Original A cable moved to B\./);
  assert.match(text, /2026-11-17T16:00:00.000Z \| Sent RST#C manually/);
  assert.match(text, /Commands were sent manually/);
  assert.match(text, /recorded by the operator/);
  assert.match(text, /not confirmed component diagnoses/);
  const blank=report(freshSession());
  assert.match(blank, /Location: Not entered/);
  assert.match(blank, /A: not checked/);
  assert.match(blank, /C \(master\): not checked/);
  assert.match(blank, /SELF-TEST\nNot performed/);
  assert.doesNotMatch(blank, /All five boards responded/);
});

test('USB session reports distinguish automatic checks from operator physical observations', () => {
  const s={...freshSession(), mode:'usb', initial:replies(), usb:{connected:true}};
  const text=report(s);
  assert.match(text, /USB COM CONNECTION\nPort open/);
  assert.match(text, /USB checks are recorded automatically by this browser/);
  assert.match(text, /Physical actions and self-test observations are recorded by the operator/);
  assert.doesNotMatch(text, /Commands were sent manually|Results above were recorded by the operator/);
  s.usb.connected=false;
  assert.match(report(s), /Port closed; completed checks remain historical observations/);
});

test('USB report preserves raw command and reply delimiters, bits, timings and incomplete-check evidence', () => {
  const at='2026-11-17T16:30:00.000Z';
  const tx='ISB#A\r', rx='<A>Ex(BIN):00000000:11111111~\r\n';
  const s={
    ...freshSession(), mode:'usb', connection:'connected', initial:{A:'responded'},
    checkErrors:{B:'PROTOCOL: unexpected reply from E'},
    usb:{connected:true,
      checks:[
        {at,board:'A',status:'responded',bits:'0000000011111111',elapsedMs:73},
        {at,board:'B',status:'error',code:'PROTOCOL',error:'unexpected reply from E',elapsedMs:null},
      ],
      observations:[{at,message:'Board A: inputs 1, 2 changed since the previous valid read.'}],
      events:[{at,type:'tx',command:'ISB#A',raw:tx},{at,type:'rx',raw:rx}],
    },
  };
  const text=report(s);
  assert.match(text, /INCOMPLETE USB CHECKS\nB: PROTOCOL: unexpected reply from E/);
  assert.match(text, /ISB#A: responded \(BIN\) 0000000011111111 73 ms/);
  assert.match(text, /ISB#B: error PROTOCOL: unexpected reply from E/);
  assert.match(text, /Board A: inputs 1, 2 changed since the previous valid read\./);
  assert.ok(text.includes(`${at} TX ISB#A ${JSON.stringify(tx)}`));
  assert.ok(text.includes(`${at} RX  ${JSON.stringify(rx)}`));
  assert.match(text, /input 1 is the rightmost bit/);
  assert.match(text, /No open\/closed polarity is assumed/);
});

test('current protocol and USB errors keep the result unresolved despite old complete healthy checks', () => {
  for(const [key,message] of [
    ['A','PROTOCOL: unexpected reply from board E'],
    ['USB','DISCONNECTED: USB device disconnected'],
    ['RST','WRITE: reset command could not be sent'],
  ]) {
    const s={...freshSession(), mode:'usb', connection:'connected',
      initial:replies(), recheck:replies(), checkErrors:{[key]:message},
      usb:{connected:key!=='USB'},
    };
    const finding=outcome(s), text=report(s);
    assert.equal(finding.kind, 'unresolved', message);
    assert.match(finding.summary, /prevented a reliable result/);
    assert.match(finding.next, /do not establish a failed board, cable or hub/);
    const resultSection=text.split('\nRESULT\n')[1].split('\nUSB COM CONNECTION\n')[0];
    assert.doesNotMatch(resultSection, /All five boards responded|Communication was confirmed/);
    assert.ok(text.includes(`${key}: ${message}`));
    assert.match(text, /ISB CHECK AFTER RST#C\n  A: responded/);
  }
});

test('losing COM after a partial initial check preserves results without claiming no ISB checks occurred', () => {
  const s={...freshSession(), mode:'usb', connection:'unavailable', connectionIssue:true,
    initial:{A:'responded', B:'no-response'}, usb:{connected:false},
  };
  const finding=outcome(s), text=report(s);
  assert.equal(finding.kind, 'unresolved');
  assert.match(finding.summary, /before the board checks could be completed/);
  assert.doesNotMatch(text, /No ISB checks were performed/);
  assert.match(text, /INITIAL ISB CHECK\n  A: responded\n  B: no-response\n  C \(master\): not checked/);
  assert.match(text, /ISB CHECK AFTER RST#C\n  A: not checked/);
  assert.doesNotMatch(finding.summary, /C did not respond|repeat ISB check was not completed/);
});

test('historical USB measurements prevent a no-ISB claim after disconnect clears the current check', () => {
  const s={...freshSession(), mode:'usb', connection:'unavailable', initial:{},
    usb:{connected:false, checks:[{at:'2026-11-17T17:00:00.000Z',board:'A',
      status:'responded',bits:'0000000011111111',elapsedMs:61}]},
  };
  assert.equal(outcome(s).kind, 'unresolved');
  assert.doesNotMatch(outcome(s).summary, /No ISB checks were performed/);
  const text=report(s);
  assert.doesNotMatch(text, /No ISB checks were performed/);
  assert.match(text, /INITIAL ISB CHECK\n  A: not checked/);
  assert.match(text, /ISB#A: responded \(BIN\) 0000000011111111 61 ms/);
});
