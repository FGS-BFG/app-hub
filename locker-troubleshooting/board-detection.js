const BOARDS=['A','B','C','D','E'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>{throw new TypeError('Invalid board detection: '+message);};
const own=(value,key)=>Object.hasOwn(value,key);

export function freshBoardDetection(){return{attempts:[],selection:null,checks:[]};}

function shape(value,keys,label){
  if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid(label+' has an invalid structure.');
}
function timestamp(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)invalid(label+' must be a canonical UTC ISO timestamp.');
}
function list(value,limit,label){
  if(!Array.isArray(value)||value.length>limit||Object.keys(value).length!==value.length||Object.keys(value).some((key,index)=>key!==String(index)))invalid(label+' must be a list of at most '+limit+' entries without gaps.');
}
function text(value,limit,label){if(value!==undefined&&(typeof value!=='string'||value.length>limit))invalid(label+' must be text of at most '+limit+' characters.');}
function result(value,label,{discovery=false,board}={}){
  shape(value,['board','status','bits','at','raw','code','error','elapsedMs','stage'],label);
  if(!BOARDS.includes(value.board)||board!==undefined&&value.board!==board)invalid(label+' has an unexpected board address.');
  if(!['responded','no-response','error'].includes(value.status))invalid(label+' has an invalid result status.');
  if(discovery?value.stage!=='discovery':value.stage!==undefined&&value.stage!=='single-board')invalid(label+' has an invalid check stage.');
  timestamp(value.at,label+' time');
  text(value.raw,1024,label+' raw response');text(value.code,80,label+' error code');text(value.error,1000,label+' error');
  if(value.status==='responded'){
    if(typeof value.bits!=='string'||!/^[01]{16}$/.test(value.bits))invalid(label+' needs exactly 16 binary inputs.');
    if(value.code?.trim()||value.error?.trim())invalid(label+' cannot be both a valid reply and an error.');
  }else if(own(value,'bits'))invalid(label+' cannot attach input bits to a failed read.');
  if(value.elapsedMs!==undefined&&value.elapsedMs!==null&&(!Number.isFinite(value.elapsedMs)||value.elapsedMs<0))invalid(label+' has an invalid elapsed time.');
  if(value.status==='error'&&!value.code?.trim()&&!value.error?.trim())invalid(label+' needs an error or error code.');
}

export function validateBoardDetection(value,{allowMissing=true}={}){
  if(value===undefined&&allowMissing)return value;
  shape(value,['attempts','selection','checks'],'section');
  list(value.attempts,20,'attempts');list(value.checks,100,'selected-board checks');
  for(const[attemptIndex,attempt]of value.attempts.entries()){
    const label='attempt '+(attemptIndex+1);shape(attempt,['at','expectedMaster','results'],label);
    timestamp(attempt.at,label+' time');
    if(!BOARDS.includes(attempt.expectedMaster))invalid(label+' needs a valid expected master context.');
    list(attempt.results,5,label+' results');
    if(new Set(attempt.results.map(row=>row?.board)).size!==attempt.results.length)invalid(label+' contains duplicate board results.');
    attempt.results.forEach((row,index)=>result(row,label+' result '+(index+1),{discovery:true}));
  }
  if(value.selection!==null){
    shape(value.selection,['board','at','expectedMaster'],'selection');
    const selection=value.selection;timestamp(selection.at,'selection time');
    if(!BOARDS.includes(selection.board)||!BOARDS.includes(selection.expectedMaster))invalid('selection needs valid board and expected-master addresses.');
    if(!value.attempts.some(attempt=>attempt.expectedMaster===selection.expectedMaster&&attempt.results.some(row=>row.board===selection.board&&row.status==='responded')))invalid('selection must match a valid responder from a recorded attempt with the same expected master.');
  }else if(value.checks.length)invalid('selected-board checks need an explicit detected-board selection.');
  for(const[index,row]of value.checks.entries())result(row,'selected-board check '+(index+1),{board:value.selection?.board});
  return value;
}

export function detectedSelection(session){
  try{validateBoardDetection(session?.boardDetection);return session?.boardDetection?.selection?.board??null;}
  catch{return null;}
}

export function detectionHasData(value){
  if(value===undefined)return false;
  try{validateBoardDetection(value);}catch{return true;}
  return value.attempts.length>0||value.selection!==null||value.checks.length>0;
}

function resultLine(row){
  return `${row.board} ${row.at} ${row.status}${row.bits?' (BIN) '+row.bits:''}${row.elapsedMs!=null?' '+row.elapsedMs+' ms':''}${row.code?' '+row.code:''}${row.error?' — '+row.error:''}${row.raw!==undefined?' RAW '+JSON.stringify(row.raw):''}`;
}

export function formatBoardDetection(value){
  const lines=['BOARD DETECTION'];
  if(value===undefined)return lines[0]+'\nNot recorded in this older session.';
  try{validateBoardDetection(value);}catch(error){return lines[0]+'\n'+error.message+'\nNo detected-board selection is inferred.';}
  if(!detectionHasData(value))return lines[0]+'\nNo discovery was recorded and no limited board was selected.';
  lines.push('Discovery replies are observations of addressed boards, not proof of a locker master, full-locker communication or door functionality.');
  value.attempts.forEach((attempt,index)=>{
    lines.push(`Discovery ${index+1}: ${attempt.at}; expected master context ${attempt.expectedMaster}`);
    if(!attempt.results.length)lines.push('  No results captured in this attempt.');
    attempt.results.forEach(row=>lines.push('  discovery '+resultLine(row)));
  });
  if(value.selection){lines.push(`Explicit limited selection: board ${value.selection.board} at ${value.selection.at}; expected layout master ${value.selection.expectedMaster} remains context only.`);}
  else lines.push('Explicit limited selection: None recorded.');
  lines.push('SELECTED-BOARD ISB CHECKS');
  if(!value.checks.length)lines.push('  None recorded.');
  value.checks.forEach(row=>lines.push('  single-board '+resultLine(row)));
  return lines.join('\n');
}
