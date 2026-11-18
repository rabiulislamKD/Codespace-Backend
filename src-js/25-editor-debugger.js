/* ================= integrated Android Local Node debugger =================
   Drives the native DAP-compatible adapter from the existing editor. This is
   intentionally scoped to Android Local + Node.js; it does not pretend to be a
   general-purpose VS Code debug adapter. */
const csDebug = {
  id: 'codespace-editor-debug', terminalId: '', port: 0, attached: false,
  polling: false, pollTimer: null, seq: 1, selectedFrame: 0, launching: false,
  breakpoints: new Map(), lastFrames: [], variables: new Map(), stopped: false
};
const csDebugPanel = () => $('csDebugPanel');
const csDebugSetStatus = value => { const el=$('csDebugStatus'); if(el)el.textContent=String(value||'').slice(0,180); };
const csDebugAppend = (value, error=false) => {
  const box=$('csDebugOutput'); if(!box)return;
  const row=document.createElement('div'); if(error)row.className='err'; row.textContent=String(value||'').slice(0,4000); box.appendChild(row);
  while(box.childNodes.length>250)box.removeChild(box.firstChild); box.scrollTop=box.scrollHeight;
};
function csDebugShow(open=true){const panel=csDebugPanel();if(!panel)return;panel.hidden=!open;if(open){const packages=$('csNodePackagesPanel'),pythonPackages=$('csPythonPackagesPanel'),lsp=$('csLspSetupPanel'),body=panel.querySelector('.cs-debug-body');if(packages)packages.hidden=true;if(pythonPackages)pythonPackages.hidden=true;if(lsp)lsp.hidden=true;if(body)body.hidden=false;$('csDebugOpen')?.setAttribute('aria-expanded','true');}else $('csDebugOpen')?.setAttribute('aria-expanded','false');}
function csDebugButtons(){
  const live=csDebug.attached, stopped=live&&csDebug.stopped;
  const pause=$('csDebugPause');if(pause)pause.disabled=!live||stopped;const stop=$('csDebugStop');if(stop)stop.disabled=!live&&!csDebug.terminalId;
  ['csDebugContinue','csDebugNext','csDebugIn','csDebugOut','csDebugEval'].forEach(id=>{const el=$(id);if(el)el.disabled=!stopped;});
  const launch=$('csDebugLaunch');if(launch)launch.disabled=live||csDebug.launching;
}
function csDebugLineSet(path){let rows=csDebug.breakpoints.get(path);if(!rows){rows=new Set();csDebug.breakpoints.set(path,rows);}return rows;}
function csDebugPaintGutter(){
  const gutter=$('edGutter'),ta=$('edTa');if(!gutter||!ta)return;
  const path=String(ta.dataset.path||''),marks=csDebug.breakpoints.get(path)||new Set(),count=ta.value.split('\n').length;
  const max=Math.min(count,12000);let html='';
  for(let line=1;line<=max;line++)html+='<button type="button" class="cs-line-number'+(marks.has(line)?' has-breakpoint':'')+'" data-line="'+line+'" aria-label="'+(marks.has(line)?'Remove':'Add')+' breakpoint at line '+line+'">'+line+'</button>';
  gutter.innerHTML=html;
}
const csDebugBasePaintEditor=paintEditor;
paintEditor=function(){csDebugBasePaintEditor();csDebugPaintGutter();};
$('edGutter')?.addEventListener('click',async e=>{
  const btn=e.target.closest('[data-line]');if(!btn)return;const tab=activeFileTab();if(!tab)return;
  e.preventDefault();const line=Number(btn.dataset.line);if(!Number.isInteger(line)||line<1)return;
  const set=csDebugLineSet(tab.path);if(set.has(line))set.delete(line);else set.add(line);
  csDebugPaintGutter();
  if(csDebug.attached&&csDebug.activePath===tab.path){
    try{await csDebugSendBreakpoints(tab.path);csDebugSetStatus('Breakpoints updated');}
    catch(err){csDebugAppend('Breakpoint update failed: '+(err.message||err),true);}
  }
  $('edTa').focus();
});
function csDebugAppendEmpty(target,text){const el=$(target);if(el){el.replaceChildren();const n=document.createElement('div');n.className='cs-debug-empty';n.textContent=text;el.appendChild(n);}}
async function csDebugRequest(command,args={}){
  if(!csDebug.attached)throw new Error('No active Node debugger session');
  const seq=csDebug.seq++;
  const response=await bcall('/runtime/node/dap/request',{id:csDebug.id,seq,command,arguments:args});
  const body=response&&response.body||{};
  if(response&&response.success===false)throw new Error(response.message||('DAP '+command+' failed'));
  return body;
}
function csDebugAbsolutePath(path){const root=String(B.info&&B.info.root||'').replace(/\/$/,'');if(!root)throw new Error('Native workspace root is unavailable');return root+'/'+String(path||'').replace(/^\/+/, '');}
async function csDebugSendBreakpoints(path){
  const rows=[...(csDebug.breakpoints.get(path)||new Set())].sort((a,b)=>a-b).map(line=>({line}));
  return csDebugRequest('setBreakpoints',{source:{name:path.split('/').pop(),path:csDebugAbsolutePath(path)},breakpoints:rows});
}
async function csDebugLaunch(){
  const tab=activeFileTab();if(!tab)throw new Error('Open a JavaScript file before starting the Node debugger');
  if(!androidLspLocal()||!B.ok)throw new Error('The integrated debugger is available in Android Local mode.');
  if(!/\.(?:js|cjs|mjs)$/i.test(tab.path))throw new Error('Node debugging supports .js, .cjs and .mjs files only.');
  if(csDebug.attached||csDebug.launching)throw new Error('Stop or wait for the current debug session first.');
  csDebug.launching=true;csDebugButtons();
  if(tab.dirty){await saveTab(tab);if(tab.dirty)throw new Error('Save the active file before debugging.');}
  csDebugShow(true);csDebugSetStatus('Starting Node.js…');$('csDebugOutput').replaceChildren();
  const started=await bcall('/runtime/node/debug/start',{path:tab.path,cwd:(B.info&&B.info.root)||'',timeout:600});
  csDebug.launching=false;csDebug.terminalId=String(started.terminalId||'');csDebug.port=Number(started.debugPort||0);csDebug.activePath=tab.path;
  if(!csDebug.terminalId||!csDebug.port)throw new Error('Android Node runtime did not return a debugger port/session.');
  csDebugAppend('Started '+tab.path+' under Node.js '+(started.nodeVersion||'')+'.');
  csDebugSetStatus('Waiting for Node Inspector…');
  let targetReady=false,lastError='';
  for(let i=0;i<60;i++){
    try{const targets=await bcall('/runtime/node/debug/targets',{port:csDebug.port});if((targets.targets||[]).some(x=>x.webSocketDebuggerUrl)){targetReady=true;break;}}
    catch(err){lastError=err.message||String(err);}
    await sleep(250);
  }
  if(!targetReady)throw new Error('Node Inspector did not become ready'+(lastError?': '+lastError:''));
  csDebugSetStatus('Attaching debugger…');
  const attached=await bcall('/runtime/node/dap/attach',{id:csDebug.id,port:csDebug.port});
  if(!attached.attached)throw new Error('DAP adapter did not attach.');
  csDebug.attached=true;csDebug.stopped=true;csDebugButtons();
  await csDebugSendBreakpoints(tab.path);
  await csDebugRequest('configurationDone',{});
  csDebug.stopped=false;csDebugButtons();csDebugSetStatus('Running · '+tab.path);
  csDebugStartPolling();
}
async function csDebugRefreshStack(){
  const body=await csDebugRequest('stackTrace',{threadId:1,startFrame:0,levels:100});
  const rows=body.stackFrames||[];csDebug.lastFrames=rows;const host=$('csDebugStack');host.replaceChildren();
  if(!rows.length){csDebugAppendEmpty('csDebugStack','No stack frames are available.');return;}
  rows.forEach(frame=>{const b=document.createElement('button');b.type='button';b.className='cs-debug-item'+(frame.id===csDebug.selectedFrame?' selected':'');b.textContent=(frame.name||'(anonymous)')+' · '+(frame.source&&frame.source.name||'')+':'+(frame.line||1);b.addEventListener('click',()=>csDebugSelectFrame(frame.id));host.appendChild(b);});
  const top=rows.find(x=>x.id===csDebug.selectedFrame)||rows[0];csDebug.selectedFrame=top.id;await csDebugSelectFrame(top.id);
}
async function csDebugSelectFrame(frameId){
  csDebug.selectedFrame=frameId;const host=$('csDebugVars');host.replaceChildren();
  const frame=csDebug.lastFrames.find(x=>x.id===frameId);if(frame){[...host.parentElement.querySelectorAll('.cs-debug-item')].forEach((b,i)=>b.classList.toggle('selected',csDebug.lastFrames[i]&&csDebug.lastFrames[i].id===frameId));}
  const scopes=await csDebugRequest('scopes',{frameId});const scopeRows=scopes.scopes||[];
  if(!scopeRows.length){csDebugAppendEmpty('csDebugVars','No variables available for this frame.');return;}
  for(const scope of scopeRows){const heading=document.createElement('div');heading.className='cs-debug-title';heading.textContent=scope.name||'Scope';host.appendChild(heading);
    const result=await csDebugRequest('variables',{variablesReference:scope.variablesReference});
    for(const variable of (result.variables||[]).slice(0,200)){const row=document.createElement('div');row.className='cs-debug-item';row.textContent=variable.name+' : '+variable.value;row.title=variable.type||'';host.appendChild(row);}
  }
}
async function csDebugPoll(){
  if(!csDebug.attached||csDebug.polling)return;csDebug.polling=true;
  try{
    const result=await bcall('/runtime/node/dap/events',{id:csDebug.id,limit:120});
    for(const event of result.events||[]){const name=event.event,body=event.body||{};
      if(name==='stopped'){csDebug.stopped=true;csDebugButtons();csDebugSetStatus('Paused · '+(body.reason||'breakpoint'));csDebugAppend('Paused: '+(body.description||body.reason||'stopped'));await csDebugRefreshStack().catch(e=>csDebugAppend('Could not load stack: '+e.message,true));}
      else if(name==='continued'){csDebug.stopped=false;csDebugButtons();csDebugSetStatus('Running');}
      else if(name==='output')csDebugAppend(body.output||'');
      else if(name==='loadedSource')csDebugAppend('Loaded source: '+(body.source&&body.source.path||body.source&&body.source.name||'script'));
    }
  }catch(err){csDebugSetStatus('Debugger connection lost');csDebugAppend(err.message||err,true);await csDebugFinish(true);}
  finally{csDebug.polling=false;}
}
function csDebugStartPolling(){if(csDebug.pollTimer)clearInterval(csDebug.pollTimer);csDebug.pollTimer=setInterval(csDebugPoll,350);}
async function csDebugControl(command){
  await csDebugRequest(command,command==='continue'?{threadId:1}:{threadId:1, singleThread:false});
  if(command==='continue'){csDebug.stopped=false;csDebugSetStatus('Running');}
  csDebugButtons();
}
async function csDebugEvaluate(){const input=$('csDebugExpr'),expression=input.value.trim();if(!expression)return;input.value='';
  const result=await csDebugRequest('evaluate',{expression,frameId:csDebug.selectedFrame,context:'repl'});
  csDebugAppend('> '+expression+'\n'+(result.result||'undefined'));
}
async function csDebugFinish(stopProcess=true){
  if(csDebug.pollTimer){clearInterval(csDebug.pollTimer);csDebug.pollTimer=null;}
  if(csDebug.attached){await bcall('/runtime/node/dap/disconnect',{id:csDebug.id}).catch(()=>{});}
  if(stopProcess&&csDebug.terminalId)await bcall('/term/stop',{id:csDebug.terminalId}).catch(()=>{});
  csDebug.attached=false;csDebug.stopped=false;csDebug.launching=false;csDebugButtons();csDebugSetStatus(stopProcess?'Stopped':'Disconnected');
  csDebugAppend(stopProcess?'Debug session stopped.':'Debugger disconnected.');
  csDebug.terminalId='';csDebug.port=0;
  csDebugAppendEmpty('csDebugStack','Start a Node.js debug session.');csDebugAppendEmpty('csDebugVars','Variables appear when execution pauses.');
}
$('csDebugOpen')?.addEventListener('click',()=>csDebugShow(true));
$('csDebugClose')?.addEventListener('click',()=>csDebugShow(false));
$('csDebugLaunch')?.addEventListener('click',()=>csDebugLaunch().catch(e=>{csDebugSetStatus('Launch failed');csDebugAppend(e.message||e,true);csDebugButtons();}));
$('csDebugPause')?.addEventListener('click',()=>csDebugControl('pause').catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugContinue')?.addEventListener('click',()=>csDebugControl('continue').catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugNext')?.addEventListener('click',()=>csDebugControl('next').catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugIn')?.addEventListener('click',()=>csDebugControl('stepIn').catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugOut')?.addEventListener('click',()=>csDebugControl('stepOut').catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugStop')?.addEventListener('click',()=>csDebugFinish(true).catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugEval')?.addEventListener('click',()=>csDebugEvaluate().catch(e=>csDebugAppend(e.message||e,true)));
$('csDebugExpr')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!$('csDebugEval').disabled){e.preventDefault();csDebugEvaluate().catch(err=>csDebugAppend(err.message||err,true));}});
csDebugButtons();

window.addEventListener('keydown',e=>{if(document.activeElement!==$('edTa')||!csDebugPanel())return;if(e.key==='F5'&&e.shiftKey){e.preventDefault();if(csDebug.attached||csDebug.terminalId)csDebugFinish(true).catch(err=>csDebugAppend(err.message||err,true));}else if(e.key==='F5'){e.preventDefault();(csDebug.attached?csDebugControl('continue'):csDebugLaunch()).catch(err=>csDebugAppend(err.message||err,true));}else if(e.key==='F10'&&csDebug.attached){e.preventDefault();csDebugControl('next').catch(err=>csDebugAppend(err.message||err,true));}else if(e.key==='F11'&&csDebug.attached){e.preventDefault();csDebugControl(e.shiftKey?'stepOut':'stepIn').catch(err=>csDebugAppend(err.message||err,true));}});
