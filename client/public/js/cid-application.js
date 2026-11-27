(function(){
'use strict';
const root=document.getElementById('cid-apply-root');let meta=null;const csrf=()=>{const m=document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);return m?decodeURIComponent(m[1]):''};
async function api(url,opts){opts=opts||{};opts.credentials='same-origin';opts.headers=Object.assign({'Content-Type':'application/json','X-CSRF-Token':csrf()},opts.headers||{});const r=await fetch(url,opts),d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||'Request failed');e.status=r.status;throw e}return d}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function showError(e){root.innerHTML='<div class="notice">'+esc(e.message)+'</div>'+(e.status===401?'<a class="btn primary" href="/auth/discord?returnTo=%2Fapply%2Fcid">Sign in with Discord</a>':'<button class="btn" id="retry">Retry</button>');const b=document.getElementById('retry');if(b)b.onclick=load}
function render(){
 if(meta.existing){root.innerHTML='<div class="notice">You already have an application: <strong>'+esc(meta.existing.appRef)+'</strong> ('+esc(meta.existing.status)+').</div>';return}
 if(!meta.checksAvailable){root.innerHTML='<div class="notice">We could not verify your Roblox group information. Please try again later.</div><button class="btn" id="retry">Retry</button>';document.getElementById('retry').onclick=load;return}
 if(!meta.eligible){root.innerHTML='<div class="notice"><strong>You are not currently eligible to apply.</strong><br>'+meta.reasons.map(esc).join('<br>')+'</div>';return}
 if(!meta.open){root.innerHTML='<div class="notice">CID applications are currently closed. Please check again later.</div>';return}
 const sections=[...new Set(meta.questions.map(q=>q.section))];let html='<div class="notice">Applicant: <strong>'+esc(meta.robloxUsername||'Linked Roblox account')+'</strong><br>Ensure your CID group rank is Pending before submitting.</div>';
 for(const section of sections){html+='<section class="section"><h2>'+esc(section)+'</h2>';for(const q of meta.questions.filter(x=>x.section===section)){html+='<div class="q"><label for="'+esc(q.id)+'">'+esc(q.label)+' *</label>'+(q.prompt?'<p>'+esc(q.prompt)+'</p>':'');if(q.type==='agreement'){html+='<div>'+meta.declaration.map((s,i)=>'<label class="check"><input type="checkbox" class="declaration" data-index="'+i+'"><span>'+esc(s)+'</span></label>').join('')+'</div>'}else{html+='<textarea id="'+esc(q.id)+'" data-answer="'+esc(q.id)+'" maxlength="'+q.max+'" '+(q.id==='roblox'?'value="'+esc(meta.robloxUsername||'')+'"':'')+' placeholder="Enter your answer…"></textarea>'}html+='</div>'}html+='</section>'}
 html+='<div class="check"><input id="confirm" type="checkbox"><label for="confirm">I confirm that I have reviewed my answers and that they are accurate and my own.</label></div><div class="actions"><button class="btn primary" id="submit">Submit application</button><span class="status" id="status"></span></div>';
 root.innerHTML=html;
 if(meta.robloxUsername)document.getElementById('roblox').value=meta.robloxUsername;
 document.getElementById('submit').onclick=submit;
}
async function submit(){
 const status=document.getElementById('status'),btn=document.getElementById('submit');if(!document.getElementById('confirm').checked){status.textContent='Confirm your answers before submitting.';return}
 const answers={};document.querySelectorAll('[data-answer]').forEach(x=>answers[x.dataset.answer]=x.value.trim());answers.declaration=document.querySelectorAll('.declaration:checked').length===meta.declaration.length;
 if(!answers.declaration){status.textContent='Accept every declaration statement.';return}
 btn.disabled=true;status.textContent='Submitting…';
 try{const out=await api('/api/cid-applications/submit',{method:'POST',body:JSON.stringify({answers})});root.innerHTML='<div class="notice"><strong>Application submitted.</strong><br>Reference: '+esc(out.appRef)+'<br>Your application is now awaiting CID review.</div>'}
 catch(e){status.textContent=e.message;btn.disabled=false}
}
async function load(){root.innerHTML='<div class="notice">Checking eligibility and application status…</div>';try{meta=await api('/api/cid-applications/meta');render()}catch(e){showError(e)}}
load();
})();