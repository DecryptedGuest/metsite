(function(){
'use strict';
const root=document.getElementById('cid-apply-root');let meta=null,termsAccepted=false;const telemetry={startedAt:Date.now(),pasteCount:0,answerStarted:{},answerSeconds:{},perQuestion:{}};const csrf=()=>{const m=document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);return m?decodeURIComponent(m[1]):''};
async function api(url,opts){opts=opts||{};opts.credentials='same-origin';opts.headers=Object.assign({'Content-Type':'application/json','X-CSRF-Token':csrf()},opts.headers||{});const r=await fetch(url,opts),d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||'Request failed');e.status=r.status;throw e}return d}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function draftKey(){return 'cid-application-draft-v1-'+String(meta&&meta.discordId||'account')}
function readDraft(){try{const raw=localStorage.getItem(draftKey());return raw?JSON.parse(raw):{}}catch(e){return {}}}
function saveDraft(){try{const answers={};root.querySelectorAll('[data-answer]').forEach(el=>answers[el.dataset.answer]=el.value);const declarations=[...root.querySelectorAll('.declaration')].map(el=>el.checked);const confirm=!!(root.querySelector('#confirm')&&root.querySelector('#confirm').checked);localStorage.setItem(draftKey(),JSON.stringify({answers,declarations,confirm,savedAt:Date.now()}));const label=root.querySelector('#draft-status');if(label)label.textContent='Draft saved on this device';}catch(e){const label=root.querySelector('#draft-status');if(label)label.textContent='Unable to save draft in this browser';}}
function updateSubmitState(){const btn=root.querySelector('#submit');if(!btn)return;const declarations=[...root.querySelectorAll('.declaration')];const allDeclared=declarations.length===meta.declaration.length&&declarations.every(el=>el.checked);const confirmed=!!(root.querySelector('#confirm')&&root.querySelector('#confirm').checked);btn.disabled=!(allDeclared&&confirmed);}
function showError(e){root.innerHTML='<div class="notice">'+esc(e.message)+'</div>'+(e.status===401?'<a class="btn primary" href="/auth/discord?returnTo=%2Fapply%2Fcid">Sign in with Discord</a>':'<button class="btn" id="retry">Retry</button>');const b=document.getElementById('retry');if(b)b.onclick=load}
function render(){
 if(meta.existing){root.innerHTML='<div class="notice">You already have an application: <strong>'+esc(meta.existing.appRef)+'</strong> ('+esc(meta.existing.status)+').</div>';return}
 if(!meta.checksAvailable){root.innerHTML='<div class="notice">We could not verify your Roblox group information. Please try again later.</div><button class="btn" id="retry">Retry</button>';document.getElementById('retry').onclick=load;return}
 if(!meta.eligible){root.innerHTML='<div class="notice"><strong>You are not currently eligible to apply.</strong><br>'+meta.reasons.map(esc).join('<br>')+'</div>';return}
 if(!meta.open){root.innerHTML='<div class="notice">CID applications are currently closed. Please check again later.</div>';return}
 if(!termsAccepted){renderTerms();return;}
 renderForm();
}
function renderTerms(){
 root.innerHTML='<h1 class="page-title">CID Application</h1><div class="check"><input id="terms-agree" type="checkbox"><label for="terms-agree">I have read and agree to the Terms &amp; Conditions.</label></div><div class="actions"><button class="btn primary" id="terms-continue" disabled>Continue to application</button></div><div id="terms-modal" hidden style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.72);padding:20px;display:none;align-items:center;justify-content:center"><section role="dialog" aria-modal="true" aria-labelledby="terms-title" style="width:min(680px,100%);max-height:85vh;overflow:auto;background:var(--surface);color:var(--text-primary);border:1px solid var(--border);border-radius:12px;padding:22px"><h2 id="terms-title">Application Terms &amp; Conditions</h2><div style="font-size:13px;line-height:1.75;color:var(--text-muted)"><p><strong>1. Application requirements.</strong> Every required question must be completed fully and answered clearly. Incomplete, irrelevant or rushed applications may be rejected.</p><p><strong>2. Honesty and accuracy.</strong> All information must be truthful. Do not exaggerate your experience, misrepresent your knowledge or provide information intended to mislead the reviewing team.</p><p><strong>3. Originality and AI use.</strong> Answers must be written independently and reflect your own knowledge and understanding. AI-generated answers, copied responses and plagiarism are prohibited. Applications may be checked for signs of AI use or copied work. Suspected misconduct may result in rejection and further departmental action where appropriate.</p><p><strong>4. Application review.</strong> Applications are reviewed by CID High Command when reviewers are available. Review times may vary and submission does not guarantee acceptance. Please allow the reviewing team reasonable time to assess your application.</p><p><strong>5. Eligibility.</strong> You are responsible for ensuring that you meet the published eligibility requirements before applying. Applications that do not meet those requirements may be declined.</p><p><strong>6. Conduct.</strong> Applicants must remain respectful throughout the process. Attempts to pressure reviewers, interfere with another application or gain an unfair advantage may result in rejection.</p><p><strong>7. Decisions and consequences.</strong> The reviewing team makes the final application decision. Breaches of these terms, including dishonesty, cheating or plagiarism, may result in rejection and further action where appropriate.</p><p><strong>8. Agreement.</strong> By ticking the acknowledgement box and continuing, you confirm that you have read and understood these terms, that your answers are your own and that the information you provide is accurate.</p></div><div class="actions"><button class="btn" id="terms-close">Close</button></div></section></div>';
 const agree=document.getElementById('terms-agree'),next=document.getElementById('terms-continue'),modal=document.getElementById('terms-modal');agree.onchange=()=>{next.disabled=!agree.checked};next.onclick=()=>{termsAccepted=true;renderForm()};document.getElementById('terms-link').onclick=e=>{e.preventDefault();modal.hidden=false;modal.style.display='flex'};document.getElementById('terms-close').onclick=()=>{modal.hidden=true;modal.style.display='none'};
}
function renderForm(){
 const sections=[...new Set(meta.questions.map(q=>q.section))];
 const discordAvatar=meta.discordAvatar?(String(meta.discordAvatar).startsWith('http')?meta.discordAvatar:'https://cdn.discordapp.com/avatars/'+encodeURIComponent(meta.discordId)+'/'+encodeURIComponent(meta.discordAvatar)+'.png?size=128'):null;
 const avatar=(src,alt,kind)=>src?'<img class="identity-avatar '+kind+'" src="'+esc(src)+'" alt="'+esc(alt)+'" referrerpolicy="no-referrer">':'<div class="identity-avatar '+kind+' identity-fallback">'+esc((alt||'?').slice(0,1).toUpperCase())+'</div>';
 let html='<section class="identity-card"><div class="identity-heading"><div><div class="identity-kicker">Applicant identity</div><h2>Information submitted with your application</h2></div><span class="identity-lock"><i class="ti ti-shield-check" aria-hidden="true"></i> Linked account</span></div><p class="identity-caption">These details are taken from your linked accounts and will be included automatically. You do not need to enter them again.</p><div class="identity-profiles"><div class="identity-profile">'+avatar(meta.robloxAvatar,meta.robloxUsername||"Roblox","roblox-avatar")+'<div class="identity-details"><span class="identity-platform"><i class="ti ti-brand-roblox" aria-hidden="true"></i> Roblox</span><strong>'+esc(meta.robloxUsername||"Not linked")+'</strong><small>MET rank: '+esc(meta.context&&meta.context.metRank||"Unavailable")+'</small></div></div><div class="identity-profile">'+avatar(discordAvatar,meta.discordUsername||"Discord","discord-avatar")+'<div class="identity-details"><span class="identity-platform"><i class="ti ti-brand-discord" aria-hidden="true"></i> Discord</span><strong>'+esc(meta.discordUsername||"Discord user")+'</strong><small>Connected account</small></div></div></div></section>';

 for(const section of sections){
  html+='<section class="section"><h2>'+esc(section)+'</h2>';
  for(const q of meta.questions.filter(x=>x.section===section)){
   html+='<div class="q"><label for="'+esc(q.id)+'">'+esc(q.label)+' *</label>'+(q.prompt?'<p>'+esc(q.prompt)+'</p>':'');
   if(q.type==='agreement'){
    html+='<div class="declaration-list">'+meta.declaration.map((s,i)=>'<label class="custom-check"><input type="checkbox" class="declaration" data-index="'+i+'"><span class="checkmark" aria-hidden="true"><i class="ti ti-check"></i></span><span class="check-copy">'+esc(s)+'</span></label>').join('')+'</div>';
   }else{
    html+='<textarea id="'+esc(q.id)+'" data-answer="'+esc(q.id)+'" maxlength="'+q.max+'" placeholder="Enter your answer…"></textarea>';
   }
   html+='</div>';
  }
  html+='</section>';
 }
 html+='<label class="custom-check final-confirm"><input id="confirm" type="checkbox"><span class="checkmark" aria-hidden="true"><i class="ti ti-check"></i></span><span class="check-copy">I confirm that I have reviewed my answers and that they are accurate and my own.</span></label><div class="actions"><button class="btn primary" id="submit" disabled>Submit application</button><span class="status" id="status"></span><span class="status" id="draft-status" aria-live="polite">Draft saves automatically on this device</span></div>';
 root.innerHTML=html;
 const draft=readDraft();
 root.querySelectorAll('[data-answer]').forEach(el=>{
  const id=el.dataset.answer;telemetry.perQuestion[id]={keystrokes:0,pastedChars:0,pasteCount:0,activeMs:0};
  if(typeof draft.answers?.[id]==='string')el.value=draft.answers[id];
  el.addEventListener('focus',()=>{if(!telemetry.answerStarted[id])telemetry.answerStarted[id]=Date.now()});
  el.addEventListener('input',()=>{if(!telemetry.answerStarted[id])telemetry.answerStarted[id]=Date.now();saveDraft()});
  el.addEventListener('keydown',ev=>{if(ev.key&&ev.key.length===1)telemetry.perQuestion[id].keystrokes++});
  el.addEventListener('paste',ev=>{telemetry.pasteCount++;telemetry.perQuestion[id].pasteCount++;const text=(ev.clipboardData&&ev.clipboardData.getData('text'))||'';telemetry.perQuestion[id].pastedChars+=text.length});
  el.addEventListener('blur',()=>{if(telemetry.answerStarted[id]){telemetry.perQuestion[id].activeMs+=Date.now()-telemetry.answerStarted[id];telemetry.answerStarted[id]=0}});
 });
 root.querySelectorAll('.declaration').forEach((el,i)=>{el.checked=Array.isArray(draft.declarations)?draft.declarations[i]===true:false;el.addEventListener('change',()=>{saveDraft();updateSubmitState()})});
 const confirm=root.querySelector('#confirm');confirm.checked=draft.confirm===true;confirm.addEventListener('change',()=>{saveDraft();updateSubmitState()});
 document.getElementById('submit').onclick=submit;
 updateSubmitState();
 if(draft.savedAt) {const label=root.querySelector('#draft-status');if(label)label.textContent='Saved draft restored from this device';}

}
async function submit(){
 const status=document.getElementById('status'),btn=document.getElementById('submit');const declarationChecks=[...document.querySelectorAll('.declaration')];const allDeclared=declarationChecks.length===meta.declaration.length&&declarationChecks.every(x=>x.checked);if(!allDeclared){status.textContent='Please confirm every declaration statement before submitting.';updateSubmitState();return}if(!document.getElementById('confirm').checked){status.textContent='Confirm that your answers are accurate and your own before submitting.';updateSubmitState();return}
 const answers={};document.querySelectorAll('[data-answer]').forEach(x=>{answers[x.dataset.answer]=x.value.trim();if(telemetry.answerStarted[x.dataset.answer]){telemetry.perQuestion[x.dataset.answer].activeMs+=Date.now()-telemetry.answerStarted[x.dataset.answer];telemetry.answerSeconds[x.dataset.answer]=Math.round(telemetry.perQuestion[x.dataset.answer].activeMs/1000)}else telemetry.answerSeconds[x.dataset.answer]=Math.round((telemetry.perQuestion[x.dataset.answer]||{}).activeMs/1000||0)});answers.declaration=allDeclared;
 btn.disabled=true;status.textContent='Submitting…';
 try{const out=await api('/api/cid-applications/submit',{method:'POST',body:JSON.stringify({answers,telemetry:{startedAt:telemetry.startedAt,submittedAt:Date.now(),totalMs:Date.now()-telemetry.startedAt,pasteCount:telemetry.pasteCount,answerSeconds:telemetry.answerSeconds,perQuestion:telemetry.perQuestion}})});try{localStorage.removeItem(draftKey())}catch(e){}root.innerHTML='<div class="notice"><strong>Application submitted.</strong><br>Reference: '+esc(out.appRef)+'<br>Your application is now awaiting CID review.</div>'}
 catch(e){status.textContent=e.message;btn.disabled=false}
}
async function load(){root.innerHTML='<div class="notice">Checking eligibility and application status…</div>';try{meta=await api('/api/cid-applications/meta');render()}catch(e){showError(e)}}
load();
})();