const BANKS=['A','B','C','D','E'];
const STATUSES=['pending','testing','tested','skipped'];
const ANSWERS=['','yes','no','uncertain'];
const PHASES=['baseline','open','closed'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const invalid=message=>{throw new TypeError('Invalid door tests: '+message);};

export function freshBankDoorTest(){
  return{status:'pending',door:null,startedAt:'',completedAt:'',skipReason:'',
    command:{open:null,lockOff:null},operator:{opened:'',closed:''},
    snapshots:{baseline:{},open:{},closed:{}},samples:[]};
}

export function freshDoorTests(){
  return{version:1,setup:{connections:'not-confirmed',note:''},
    banks:Object.fromEntries(BANKS.map(bank=>[bank,freshBankDoorTest()]))};
}

function shape(value,keys,label){
  if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid(label+' has an invalid structure.');
}
function text(value,label,limit,{optional=false}={}){
  if(optional&&value===undefined)return;
  if(typeof value!=='string'||value.length>limit)invalid(label+' must be text of at most '+limit+' characters.');
}
function timestamp(value,label,{blank=false}={}){
  if(blank&&value==='')return;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||
    !Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)invalid(label+' must be a UTC ISO timestamp.');
}
function validateCommand(command,label){
  if(command===null)return;
  shape(command,['status','at','code','error','raw'],label);
  if(!['sent','error','uncertain'].includes(command.status))invalid(label+' has an invalid status.');
  timestamp(command.at,label+' time');
  text(command.code,label+' code',80,{optional:true});
  text(command.error,label+' error',1000,{optional:true});
  text(command.raw,label+' raw command',4096,{optional:true});
  if(command.status==='error'&&!command.code?.trim()&&!command.error?.trim())invalid(label+' needs its error or code.');
}
function validateSample(sample,label,expectedBoard,{phase=false}={}){
  shape(sample,['board','status','bits','at','elapsedMs','code','error','raw',...(phase?['phase']:[])],label);
  if(!BANKS.includes(sample.board)||expectedBoard&&sample.board!==expectedBoard)invalid(label+' has the wrong bank address.');
  if(!['responded','no-response','error'].includes(sample.status))invalid(label+' has an invalid response status.');
  if(phase&&!['open','closed'].includes(sample.phase))invalid(label+' has an invalid observation phase.');
  timestamp(sample.at,label+' time');
  if(sample.status==='responded'){
    if(typeof sample.bits!=='string'||!/^[01]{16}$/.test(sample.bits))invalid(label+' needs exactly 16 binary inputs.');
  }else if(own(sample,'bits'))invalid(label+' must not attach input bits to a failed read.');
  if(sample.elapsedMs!==undefined&&sample.elapsedMs!==null&&(!Number.isFinite(sample.elapsedMs)||sample.elapsedMs<0))invalid(label+' has an invalid elapsed time.');
  text(sample.code,label+' code',80,{optional:true});
  text(sample.error,label+' error',1000,{optional:true});
  text(sample.raw,label+' raw response',1024,{optional:true});
  if(sample.status==='error'&&!sample.code?.trim()&&!sample.error?.trim())invalid(label+' needs its error or code.');
}

// A missing section is a supported older draft. It is never a completed new test.
export function validateDoorTests(value,{allowMissing=true}={}){
  if(value===undefined&&allowMissing)return value;
  shape(value,['version','setup','banks'],'section');
  if(value.version!==1)invalid('unsupported version.');
  if(value.setup!==undefined){
    shape(value.setup,['connections','note'],'setup');
    if(!['original','changed','not-confirmed'].includes(value.setup.connections))invalid('setup connection choice is invalid.');
    text(value.setup.note,'setup note',1000);
  }
  shape(value.banks,BANKS,'banks');
  for(const bank of BANKS){
    const entry=value.banks[bank],label='bank '+bank;
    shape(entry,['status','door','startedAt','completedAt','skipReason','command','operator','snapshots','samples'],label);
    if(!STATUSES.includes(entry.status))invalid(label+' has an invalid test status.');
    if(entry.door!==null&&(!Number.isInteger(entry.door)||entry.door<1||entry.door>16))invalid(label+' door must be 1 to 16 or blank.');
    timestamp(entry.startedAt,label+' start',{blank:true});timestamp(entry.completedAt,label+' completion',{blank:true});
    if(entry.startedAt&&entry.completedAt&&Date.parse(entry.completedAt)<Date.parse(entry.startedAt))invalid(label+' completion precedes its start.');
    text(entry.skipReason,label+' skip reason',1000);
    shape(entry.command,['open','lockOff'],label+' commands');
    validateCommand(entry.command.open,label+' open command');validateCommand(entry.command.lockOff,label+' lock-off command');
    shape(entry.operator,['opened','closed'],label+' operator observations');
    if(!ANSWERS.includes(entry.operator.opened)||!ANSWERS.includes(entry.operator.closed))invalid(label+' has an invalid operator answer.');
    shape(entry.snapshots,PHASES,label+' snapshots');
    for(const phase of PHASES){
      shape(entry.snapshots[phase],BANKS,label+' '+phase+' snapshot');
      for(const[observedBank,sample]of Object.entries(entry.snapshots[phase]))validateSample(sample,label+' '+phase+' '+observedBank,observedBank);
    }
    if(!Array.isArray(entry.samples)||entry.samples.length>200)invalid(label+' may contain at most 200 samples.');
    if(Object.keys(entry.samples).some(key=>!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=entry.samples.length))invalid(label+' samples must be a plain list.');
    for(let index=0;index<entry.samples.length;index++){
      if(!own(entry.samples,index))invalid(label+' samples must not contain gaps.');
      validateSample(entry.samples[index],label+' sample '+(index+1),undefined,{phase:true});
    }
    if(entry.status==='testing'&&(!entry.door||!entry.startedAt))invalid(label+' in progress needs its door and start time.');
    if(entry.status==='tested'){
      if(!entry.door||!entry.startedAt||!entry.completedAt||!entry.command.open||!entry.operator.opened||!entry.operator.closed)invalid(label+' tested status needs an attempted command, selected door, times and both operator answers.');
      if(!value.setup||!['original','changed'].includes(value.setup.connections))invalid(label+' tested status needs the connection setup observation.');
      if(value.setup.connections==='changed'&&!value.setup.note.trim())invalid(label+' tested with changed connections needs a setup note.');
    }
    if(entry.status==='skipped'&&(!entry.skipReason.trim()||!entry.completedAt))invalid(label+' skipped status needs its reason and completion time.');
  }
  return value;
}

export function doorTestsComplete(value){
  if(value===undefined)return false;
  try{
    validateDoorTests(value,{allowMissing:false});
    if(value.setup?.connections==='changed'&&!value.setup.note.trim())return false;
    return BANKS.every(bank=>['tested','skipped'].includes(value.banks[bank].status));
  }
  catch{return false;}
}

export function hasDoorTestData(value){
  if(value===undefined)return false;
  if(!object(value)||value.version!==1||!object(value.banks))return true;
  if(value.setup!==undefined&&!object(value.setup))return true;
  if(value.setup?.connections&&value.setup.connections!=='not-confirmed')return true;
  if(value.setup?.note!==undefined&&(typeof value.setup.note!=='string'||value.setup.note.trim()))return true;
  return BANKS.some(bank=>{
    const entry=value.banks[bank];
    return !object(entry)||entry.status!=='pending'||entry.door!==null||!!entry.startedAt||!!entry.completedAt||!!entry.skipReason||
      !!entry.command?.open||!!entry.command?.lockOff||!!entry.operator?.opened||!!entry.operator?.closed||
      PHASES.some(phase=>Object.keys(entry.snapshots?.[phase]||{}).length)||!!entry.samples?.length;
  });
}

export function changedDoorInputs(before,bits){
  if(typeof before!=='string'||typeof bits!=='string'||!/^[01]{16}$/.test(before)||!/^[01]{16}$/.test(bits))return[];
  return Array.from({length:16},(_,index)=>index+1).filter(input=>before[16-input]!==bits[16-input]);
}

function bankSummary(entry){
  const changed=Object.fromEntries(BANKS.map(bank=>[bank,new Set()]));
  const missing=new Set();
  for(const sample of [...Object.values(entry.snapshots.open),...Object.values(entry.snapshots.closed),...entry.samples]){
    if(sample.status!=='responded')continue;
    const baseline=entry.snapshots.baseline[sample.board];
    if(baseline?.status!=='responded'){missing.add(sample.board);continue;}
    for(const input of changedDoorInputs(baseline.bits,sample.bits))changed[sample.board].add(input);
  }
  const commandIssues=[];
  const attempted=['testing','tested'].includes(entry.status)||!!entry.command.open||!!entry.command.lockOff;
  for(const[key,label]of [['open','Open command'],['lockOff','Lock-off command']]){
    const command=entry.command[key];
    if(!command){if(attempted)commandIssues.push(label+' not recorded');}
    else if(command.status!=='sent')commandIssues.push(label+': '+command.status+(command.code?' '+command.code:'')+(command.error?' — '+command.error:''));
  }
  return{status:entry.status,door:entry.door,operatorOpened:entry.operator.opened,operatorClosed:entry.operator.closed,
    changes:Object.fromEntries(BANKS.map(bank=>[bank,[...changed[bank]].sort((a,b)=>a-b)])),
    baselineMissing:[...missing].sort(),commandIssues};
}

export function doorTestSummary(value){
  const data=value??freshDoorTests();
  try{validateDoorTests(data);}catch(error){return{complete:false,tested:0,skipped:0,pending:5,banks:{},error:error.message};}
  const entries=Object.values(data.banks);
  return{complete:doorTestsComplete(value),tested:entries.filter(entry=>entry.status==='tested').length,
    skipped:entries.filter(entry=>entry.status==='skipped').length,
    pending:entries.filter(entry=>!['tested','skipped'].includes(entry.status)).length,
    banks:Object.fromEntries(BANKS.map(bank=>[bank,bankSummary(data.banks[bank])]))};
}

function sampleLine(sample){
  return `${sample.board} ${sample.at} ${sample.status}${sample.bits?' (BIN) '+sample.bits:''}${sample.elapsedMs!=null?' '+sample.elapsedMs+' ms':''}${sample.code?' '+sample.code:''}${sample.error?' — '+sample.error:''}${sample.raw!==undefined?' RAW '+JSON.stringify(sample.raw):''}`;
}
function commandLine(command){
  return command?`${command.status} at ${command.at}${command.code?' '+command.code:''}${command.error?' — '+command.error:''}${command.raw!==undefined?' RAW '+JSON.stringify(command.raw):''}`:'Not recorded';
}

export function formatDoorTests(value){
  const header='ONE DOOR PER COLUMN';
  if(value===undefined)return header+'\nNot recorded in this older session. No door operation is inferred.';
  const summary=doorTestSummary(value);
  if(summary.error)return header+'\n'+summary.error+'\nNo completed door test is inferred.';
  const lines=[header,`Recorded attempts: ${summary.tested} tested; ${summary.skipped} skipped; ${summary.pending} pending.`,
    'Tested records an attempted command and operator answers; it is not a door-function pass.',
    'A sent command confirms transmission only. Lock-off is not a claim that the door physically closed.',
    'Raw input 1 is the rightmost bit. Input changes imply no door mapping or open/closed polarity.',
    'Connection setup: '+(value.setup?.connections||'Not recorded'),
    'Setup note: '+(value.setup?.note||'None recorded')];
  for(const bank of BANKS){
    const entry=value.banks[bank],finding=summary.banks[bank];
    lines.push('',`BANK ${bank}: ${entry.status}; selected door ${entry.door??'Not selected'}`,
      'Started: '+(entry.startedAt||'Not started'),'Completed: '+(entry.completedAt||'Not completed'),
      'Skip reason: '+(entry.skipReason||'None recorded'),
      'Open command: '+commandLine(entry.command.open),'Lock-off command: '+commandLine(entry.command.lockOff),
      'Operator observed physically opened: '+(entry.operator.opened||'Not recorded'),
      'Operator observed physically closed: '+(entry.operator.closed||'Not recorded'));
    if(finding.commandIssues.length)lines.push('Command evidence issues: '+finding.commandIssues.join('; '));
    for(const phase of PHASES){
      lines.push(phase.toUpperCase()+' SNAPSHOT');
      for(const observedBank of BANKS)lines.push('  '+(entry.snapshots[phase][observedBank]?sampleLine(entry.snapshots[phase][observedBank]):observedBank+': Not captured'));
    }
    lines.push(`POLLING SAMPLES (${entry.samples.length}; maximum 200)`);
    if(!entry.samples.length)lines.push('  None recorded');
    for(const sample of entry.samples)lines.push('  '+sample.phase+' '+sampleLine(sample));
    lines.push('INPUT CHANGES OBSERVED AGAINST BASELINE (union of snapshots and polling samples)');
    for(const observedBank of BANKS)lines.push(`  ${observedBank}: ${finding.changes[observedBank].length?finding.changes[observedBank].join(', '):'No changes recorded'}`);
    if(finding.baselineMissing.length)lines.push('No valid baseline for observed bank(s): '+finding.baselineMissing.join(', ')+'. No input comparison was inferred.');
  }
  return lines.join('\n');
}
