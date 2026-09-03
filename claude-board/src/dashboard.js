import { projectHue, monogram } from './color.js';

export function dashboardHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude sessions</title>
<style>
:root{--ground:#F4F6F7;--surface:#fff;--surface-2:#EAEFEF;--ink:#111819;--muted:#5C6B6D;--rule:#DBE2E2;--accent:#0F6E68;--psat:58%;--plum:40%;--pchip:92%;
 --working:#2A63C7;--needs_you:#B4650B;--errored:#B23A2E;--done:#3F7A52;--stale:#6E5BB0;--closed:#6B7280}
@media (prefers-color-scheme:dark){:root{--ground:#0D1314;--surface:#141C1D;--surface-2:#1B2526;--ink:#E8EEEE;--muted:#93A5A6;--rule:#243031;--accent:#4CCFC0;--psat:55%;--plum:64%;--pchip:18%;
 --working:#6E9DF0;--needs_you:#E2A046;--errored:#E4705F;--done:#6BB183;--stale:#A392E8;--closed:#8B93A1}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif}
header{display:flex;align-items:baseline;gap:18px;padding:18px 24px 10px;border-bottom:1px solid var(--rule)}
h1{font:600 20px/1 "IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;margin:0;letter-spacing:-.01em}
.meta{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}.meta b{color:var(--ink);font-weight:500}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(236px,1fr));gap:14px;padding:18px 24px 40px}
.col h2{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--c);margin:0 0 10px;display:flex;justify-content:space-between}
.col h2 span{color:var(--muted)}
.card{--p:hsl(var(--h) var(--psat) var(--plum));background:var(--surface);border:1px solid var(--rule);border-left:4px solid var(--c);margin-bottom:10px;display:flex;flex-direction:column;overflow:hidden}
.card .thumb{display:block;width:100%;height:112px;object-fit:cover;object-position:top;border-bottom:1px solid var(--rule);background:var(--surface-2)}
.card .body{padding:10px 12px 10px;display:flex;flex-direction:column;gap:5px}
.card .top{display:flex;align-items:center;gap:7px;font:12px ui-monospace,Menlo,monospace;color:var(--muted);min-width:0}
.card .top .repo{color:var(--p);font-weight:600;white-space:nowrap}
.card .top .branch{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .top .when{margin-left:auto;white-space:nowrap;flex:none}
.mono{flex:none;width:22px;height:22px;border-radius:4px;background:var(--p);color:#fff;font:700 10px/22px "IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;text-align:center;letter-spacing:.02em}
.card .task{font-size:14px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card .wait{color:var(--needs_you);font-weight:600;font-size:13px}
.card .msg{font-size:13px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .foot{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px}
.chip{font:11px ui-monospace,Menlo,monospace;background:var(--surface-2);border:1px solid var(--rule);padding:1px 6px;border-radius:3px;color:var(--muted)}
.chip.p{background:hsl(var(--h) var(--psat) var(--pchip));border-color:transparent;color:var(--p)}
button{font:12px ui-monospace,Menlo,monospace;background:none;border:1px solid var(--rule);color:var(--accent);padding:2px 8px;border-radius:3px;cursor:pointer}
button:hover{border-color:var(--accent)}a{color:var(--accent);font-size:12px}
.empty{color:var(--muted);font-size:13px;border:1px dashed var(--rule);padding:10px 12px}
.off{color:var(--errored)}
</style></head><body>
<header><h1>Claude sessions</h1><div class="meta" id="meta">connecting…</div></header>
<div class="board" id="board"></div>
<script>
${projectHue.toString()}
${monogram.toString()}
const COLS=[['needs_you','Needs you'],['working','Working'],['errored','Errored'],['stale','Stale'],['done','Done']];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=ms=>{const m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':Math.round(m/60)+' h ago'};
let state={sessions:[],repo:'',projectUrl:''};
function render(){
  const now=Date.now();const live=state.sessions.filter(s=>s.status!=='closed');
  document.getElementById('meta').innerHTML='<b>'+live.length+'</b> live · <b>'+live.filter(s=>s.status==='needs_you').length+'</b> need you'+(state.projectUrl?' · <a href="'+esc(state.projectUrl)+'">board</a>':'')+' · '+(state.connected?'live':'<span class="off">disconnected</span>');
  const b=document.getElementById('board');b.innerHTML='';
  for(const [key,label] of COLS){
    const items=live.filter(s=>s.status===key).sort((a,b)=>key==='needs_you'?(a.blockedSince||now)-(b.blockedSince||now):b.lastEventAt-a.lastEventAt);
    const col=document.createElement('div');col.className='col';col.style.setProperty('--c','var(--'+key+')');
    col.innerHTML='<h2>'+label+'<span>'+items.length+'</span></h2>'+(items.length?'':'<div class="empty">—</div>');
    for(const s of items){
      const d=document.createElement('div');d.className='card';d.style.setProperty('--c','var(--'+key+')');d.style.setProperty('--h',projectHue(s.repo||''));
      const wait=key==='needs_you'&&s.blockedSince?'<div class="wait">waiting '+Math.round((now-s.blockedSince)/60000)+' min</div>':'';
      const resume=s.surface==='cloud'?'claude --teleport '+s.id:'claude --resume '+s.id;
      const thumb=s.thumbnail?'<img class="thumb" src="/thumbs/'+esc(s.thumbnail)+'?v='+(s.thumbnailAt||0)+'" alt="">':'';
      d.innerHTML=thumb+'<div class="body"><div class="top"><span class="mono">'+esc(monogram(s.repo))+'</span><span class="repo">'+esc(s.repo||'?')+'</span>'+(s.branch?'<span class="branch" title="'+esc(s.branch)+'">· '+esc(s.branch)+'</span>':'<span class="branch"></span>')+'<span class="when">'+ago(s.lastEventAt)+'</span></div>'
       +'<div class="task">'+esc(s.currentPrompt||'(no prompt yet)')+'</div>'+wait
       +(s.lastAssistantMessage?'<div class="msg">'+esc(s.lastAssistantMessage)+'</div>':'')
       +'<div class="foot"><span class="chip p">'+esc(s.repo||'?')+'</span><span class="chip">'+esc(s.surface)+'</span>'+(s.permissionMode?'<span class="chip">'+esc(s.permissionMode)+'</span>':'')+'<span class="chip">'+s.turnCount+' turns</span>'
       +'<button data-cmd="'+esc(resume)+'">copy resume</button>'+(s.issue&&s.issue.url?'<a href="'+esc(s.issue.url)+'" target="_blank">#'+s.issue.number+'</a>':'')+'</div></div>';
      col.appendChild(d);
    }
    b.appendChild(col);
  }
}
document.addEventListener('click',e=>{const c=e.target.closest('button[data-cmd]');if(!c)return;navigator.clipboard.writeText(c.dataset.cmd).then(()=>{c.textContent='copied';setTimeout(()=>c.textContent='copy resume',1200)})});
function connect(){const es=new EventSource('/events');es.onmessage=e=>{state={...state,...JSON.parse(e.data),connected:true};render()};es.onerror=()=>{state.connected=false;render();es.close();setTimeout(connect,3000)}}
connect();setInterval(render,30000);
</script></body></html>`;
}
