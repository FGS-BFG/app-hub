const PREFIX='mci-field-reports-';
const MAX_WAIT=8*60*1000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DriveReportError extends Error{
  constructor(code,message){super(message);this.name='DriveReportError';this.code=code;}
}

function endpointUrl(endpoint){
  let url;
  try{url=new URL(endpoint);}catch{}
  if(!url||url.protocol!=='https:'||url.hostname!=='script.google.com'||url.port||url.username||url.password||!url.pathname.endsWith('/exec')){
    throw new DriveReportError('CONFIG','Google Drive report storage is not configured. Ask support to configure the authenticated report portal.');
  }
  url.hash='';
  return url;
}

export function isReportPortalOrigin(origin){
  try{
    const url=new URL(origin);
    return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&url.origin===origin&&
      (url.hostname==='script.googleusercontent.com'||url.hostname.endsWith('-script.googleusercontent.com'));
  }catch{return false;}
}

export function buildReportPayload(report){
  const reportId=report?.reportId??report?.id;
  if(!report||typeof report!=='object'||Array.isArray(report)||typeof reportId!=='string'||!UUID.test(reportId)||
    (report.id!==undefined&&report.reportId!==undefined&&report.id!==report.reportId)){
    throw new DriveReportError('INVALID_REPORT','The report needs a valid, stable report ID before it can be saved.');
  }
  for(const key of ['savedAt','reportText','title','location','technician']){
    if(typeof report[key]!=='string')throw new DriveReportError('INVALID_REPORT',`The report ${key} is missing or invalid.`);
  }
  if(!Number.isFinite(Date.parse(report.savedAt))||new Date(report.savedAt).toISOString()!==report.savedAt||!report.reportText.trim()||!report.title.trim()){
    throw new DriveReportError('INVALID_REPORT','The report needs a valid save time, title and report text.');
  }
  if(new TextEncoder().encode(report.reportText).length>2*1024*1024)throw new DriveReportError('INVALID_REPORT','The report text is too large to save.');
  for(const key of ['title','location','technician']){
    if(report[key].length>160||/[\x00-\x1f\x7f]/.test(report[key]))throw new DriveReportError('INVALID_REPORT',`The report ${key} must be at most 160 characters without control characters.`);
  }
  return {reportId:reportId.toLowerCase(),savedAt:report.savedAt,reportText:report.reportText,title:report.title,location:report.location,technician:report.technician};
}

export function validateSaveResult(result,reportId){
  let url;
  try{url=new URL(result?.url);}catch{}
  const fileId=result?.fileId;
  const linkedId=url?.searchParams.get('id')||url?.pathname.match(/\/d\/([^/]+)/)?.[1];
  if(!result||typeof fileId!=='string'||! /^[a-zA-Z0-9_-]{10,200}$/.test(fileId)||result.reportId!==reportId||
    !url||url.protocol!=='https:'||url.port||url.username||url.password||!['drive.google.com','docs.google.com'].includes(url.hostname)||linkedId!==fileId){
    throw new DriveReportError('INVALID_RECEIPT','Google Drive returned an invalid report receipt. The report has not been confirmed as saved; retry with the same report.');
  }
  return {...result,url:url.href};
}

// Reading frames.length and frames[n] uses the cross-origin-safe WindowProxy API.
// Never inspect a child document or send report content during discovery.
function popupFrames(popup){
  const found=new Set(),queue=[{frame:popup,depth:0}];
  while(queue.length&&found.size<30){
    const{frame,depth}=queue.shift();
    if(!frame||found.has(frame))continue;
    found.add(frame);
    if(depth>=3)continue;
    try{
      const frames=frame.frames;
      const length=Math.min(Number(frames.length)||0,30);
      for(let i=0;i<length&&queue.length+found.size<30;i++){
        try{const child=frames[i];if(child&&!found.has(child))queue.push({frame:child,depth:depth+1});}catch{}
      }
    }catch{}
  }
  return found;
}

export class DriveReportClient{
  constructor({endpoint,window:browserWindow=globalThis.window,now=()=>Date.now(),timers,
    crypto=browserWindow?.crypto??globalThis.crypto,pollMs=250,timeoutMs=MAX_WAIT}={}){
    this.endpoint=endpoint;
    this.window=browserWindow;
    this.now=now;
    this.crypto=crypto;
    this.pollMs=Number.isFinite(pollMs)&&pollMs>0?pollMs:250;
    this.timeoutMs=Math.min(MAX_WAIT,Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:MAX_WAIT);
    const host=timers??browserWindow??globalThis;
    // Preserve the receiver: detached Window timer methods can throw Illegal invocation.
    this.setTimer=(callback,ms)=>host.setTimeout(callback,ms);
    this.clearTimer=id=>host.clearTimeout(id);
    this.active=null;
  }

  _uuid(){
    if(typeof this.crypto?.randomUUID!=='function')throw new DriveReportError('BROWSER','This browser cannot create a secure report request. Use a current version of Chrome or Edge.');
    return this.crypto.randomUUID();
  }

  _open(url){
    let popup;
    try{popup=this.window?.open(url.href,'_blank','popup=yes,width=920,height=760');}catch{}
    if(!popup)throw new DriveReportError('POPUP_BLOCKED','The Google Drive report window was blocked. Allow pop-ups for this guide and try again.');
    return popup;
  }

  async save(report){
    if(this.active)throw new DriveReportError('BUSY','A report save is already in progress. Complete the Google Drive window before trying again.');
    const url=endpointUrl(this.endpoint),payload=buildReportPayload(report);
    const nonce=this._uuid(),requestId=this._uuid();
    url.searchParams.delete('mode');url.searchParams.set('nonce',nonce);
    // Keep this before any await so a Save click retains its popup user gesture.
    const popup=this._open(url);
    return new Promise((resolve,reject)=>{
      const active={popup,nonce,requestId,payload,known:new Set([popup]),portal:null,
        deadline:this.now()+this.timeoutMs,timer:null,settled:false};
      this.active=active;
      const finish=(error,result)=>{
        if(active.settled)return;
        active.settled=true;
        if(active.timer!==null)this.clearTimer(active.timer);
        this.window.removeEventListener('message',message);
        if(this.active===active)this.active=null;
        if(error)reject(error);else resolve(result);
      };
      const message=event=>{
        if(active.settled||this.active!==active)return;
        if(this.now()>=active.deadline){finish(new DriveReportError('TIMEOUT','Google Drive did not confirm the save within eight minutes. Check the report window, then retry with the same report.'));return;}
        const data=event.data;
        if(!data||typeof data!=='object'||data.nonce!==nonce)return;
        if(data.type===PREFIX+'ready'&&!active.portal){
          if(!active.known.has(event.source)||!isReportPortalOrigin(event.origin))return;
          active.portal={source:event.source,origin:event.origin};
          try{
            event.source.postMessage({type:PREFIX+'request',nonce,requestId,action:'save',report:payload},event.origin);
          }catch{finish(new DriveReportError('PORTAL','The Google Drive report window could not receive the report. Try again with the same report.'));}
          return;
        }
        if(data.type!==PREFIX+'response'||!active.portal||event.source!==active.portal.source||event.origin!==active.portal.origin||data.requestId!==requestId)return;
        if(data.ok===false){
          const detail=typeof data.error==='string'?data.error:data.error?.message;
          finish(new DriveReportError('REJECTED',detail||'Google Drive did not save the report. Check your account access and try again.'));
        }else if(data.ok===true){
          try{finish(null,validateSaveResult(data.result,payload.reportId));}catch(error){finish(error);}
        }
      };
      const poll=()=>{
        if(active.settled)return;
        try{
          if(popup.closed){finish(new DriveReportError('POPUP_CLOSED','The Google Drive report window was closed before saving was confirmed. Try again with the same report.'));return;}
          if(this.now()>=active.deadline){finish(new DriveReportError('TIMEOUT','Google Drive did not confirm the save within eight minutes. Check the report window, then retry with the same report.'));return;}
          if(!active.portal){
            active.known=popupFrames(popup);
            for(const frame of active.known){
              try{frame.postMessage({type:PREFIX+'hello',nonce},'*');}catch{}
            }
          }
          active.timer=this.setTimer(poll,Math.min(this.pollMs,active.deadline-this.now()));
        }catch{finish(new DriveReportError('PORTAL','The Google Drive report window could not be checked. Try again with the same report.'));}
      };
      try{this.window.addEventListener('message',message);poll();}
      catch{finish(new DriveReportError('BROWSER','This browser could not connect to the Google Drive report window.'));}
    });
  }

  openLibrary(){
    const url=endpointUrl(this.endpoint);
    url.searchParams.delete('nonce');url.searchParams.set('mode','library');
    return this._open(url);
  }
}
