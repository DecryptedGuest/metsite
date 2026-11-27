(function(){
'use strict';
var root=document.getElementById('apply-content'),meta=null,answers={},step=0,groupConfirmed=false,busy=false;
var questions=[
{id:'q1',title:'Patrol restrictions',help:'Successful applicants begin at Community Support Officer (CSO).',type:'check',text:'I understand that, if accepted, I will initially be ranked Community Support Officer. I must not patrol alone until I have attended a supervised patrol event and been promoted to Constable. Patrolling alone before that promotion may result in termination.'},
{id:'q2',title:'Originality and application integrity',help:'Your written answers must reflect your own knowledge and experience.',type:'check',text:'I confirm that I will write my answers myself and will not use AI tools or another person to generate or write them for me. I understand that applications may be reviewed for originality and integrity, and suspected misuse may lead to rejection or further recruitment action.'},
{id:'q3',title:'Why do you want to join the Metropolitan Police Service?',type:'text',placeholder:'Explain your reasons for applying…'},
{id:'q4',title:'What qualities or experience would help you perform well as a police officer?',type:'text',placeholder:'Describe the qualities you would bring…'},
{id:'q5',title:'Have you previously been part of a Roblox police department or emergency services group?',help:'If yes, name the group(s) and briefly describe your role or experience. If not, say so.',type:'text',placeholder:'Your previous experience…',min:1},
{id:'q6',title:'What would you hope to achieve as a member of the Metropolitan Police Service?',type:'text',placeholder:'Describe your goals…'},
{id:'q7',title:'How active can you realistically be in-game each week?',type:'select'},
{id:'q8',title:'What does professionalism mean to you in a roleplay police department?',type:'text',placeholder:'Explain what professionalism looks like in practice…'},
{id:'q9',title:'You witness another officer abusing their powers. How would you respond?',type:'text',placeholder:'Explain the steps you would take…'},
{id:'q10',title:'Application status enquiries',help:'Allow the recruitment team time to review your submission.',type:'check',text:'I understand that I must wait at least 12 hours after submitting before asking anyone about my application status. Contacting staff about its status before that period has passed may result in my application being denied.'}
];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function csrf(){var m=document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);return m?decodeURIComponent(m[1]):'';}
async function api(url,opts){opts=opts||{};opts.credentials='same-origin';opts.headers=Object.assign({'Content-Type':'application/json','X-CSRF-Token':csrf()},opts.headers||{});var r=await fetch(url,opts),d=await r.json().catch(function(){return {};});if(!r.ok)throw new Error(d.error||'Request failed.');return d;}
function status(msg){var el=document.getElementById('apply-status');if(el)el.textContent=msg||'';}
function rail(active){var el=document.getElementById('apply-steps');if(!el)return;var names=['Eligibility','Application','Review'];el.innerHTML=names.map(function(n,i){return '<div class="rail-step '+(i===active?'active':i<active?'done':'')+'"><span class="num">'+(i<active?'✓':'0'+(i+1))+'</span>'+n+'</div>';}).join('');}
function blocked(){
 if(meta.needsRobloxLink){root.innerHTML='<div class="eyebrow">Account setup</div><h2>Link your Roblox account</h2><p class="introline">'+esc(meta.message||'A linked Roblox account is required to check eligibility.')+'</p><div class="apply-actions"><a class="btn primary" href="/login">Go to sign in</a></div>';return true;}
 if(meta.existing){root.innerHTML='<div class="eyebrow">Already received</div><h2>Your application is in the queue</h2><div class="notice success"><strong>Reference '+esc(meta.existing.appRef)+'</strong><br>Your application is awaiting review. You do not need to submit another one.</div>';return true;}
 var e=meta.eligibility||{};
 if(!e.checksAvailable){root.innerHTML='<div class="eyebrow">Eligibility check unavailable</div><h2>We could not verify your account</h2><div class="notice warning">Roblox group checks are temporarily unavailable. Applications are paused until both MET and SAS membership can be checked reliably. Please try again later.</div><button class="btn" id="retry">Retry check</button>';document.getElementById('retry').onclick=refresh;return true;}
 if(!e.eligible){root.innerHTML='<div class="eyebrow">Application unavailable</div><h2>This account is not eligible to apply</h2><p class="introline">The account checks found a restriction. If you believe this is incorrect, contact the appropriate staff team through the normal support route.</p><div class="notice warning">'+(e.restrictions||[]).map(function(x){return '<div>• '+esc(x.label)+'</div>';}).join('')+'</div>';return true;}
 return false;
}
function load(){
 rail(0);
 if(blocked())return;
 if(!meta.isMember&&!groupConfirmed){renderGroup();return;}
 renderQuestion();
}
async function refresh(){root.innerHTML='<div class="status">Checking account eligibility…</div>';try{meta=await api('/api/met-application/meta');load();}catch(e){root.innerHTML='<div class="notice error">'+esc(e.message)+'</div>';}}
function renderGroup(){
 rail(0);
 root.innerHTML='<div class="eyebrow">Step 01 / Group requirement</div><h2>Request to join the MET community</h2><p class="introline">You must submit a request to join the Metropolitan Police SLR Roblox community before applying. Current MET members and SAS members are not eligible for this application.</p><div class="notice"><strong>Linked Roblox account</strong><br>'+esc(meta.robloxUsername||'Linked account')+'<br><strong>Community</strong><br>Metropolitan Police SLR</div><div class="apply-actions"><a class="btn primary" href="'+esc(meta.groupUrl)+'" target="_blank" rel="noopener">Open Roblox community ↗</a><button class="btn" id="check-group">Check membership again</button></div><div class="notice warning"><strong>Pending join requests</strong><br>Roblox does not expose pending join-request status through the permissions currently available to this site. If you have already submitted a request, confirm it below. This confirmation is recorded but is not treated as a Roblox-verified membership.</div><label class="checkline"><input type="checkbox" id="group-confirm"><span>I confirm that I have submitted a request to join the MET Roblox community and understand that my application may be declined if this is not true.</span></label><div class="apply-actions"><button class="btn primary" id="continue-group" disabled>Continue to questions</button></div><div class="status" id="apply-status"></div>';
 document.getElementById('check-group').onclick=async function(){this.disabled=true;status('Checking both Roblox groups…');try{meta=await api('/api/met-application/meta');if(blocked())return;if(meta.isMember===true){status('This account is already in MET and cannot apply.');return;}status('Eligibility rechecked.');}catch(e){status(e.message);}finally{this.disabled=false;}};
 document.getElementById('group-confirm').onchange=function(){document.getElementById('continue-group').disabled=!this.checked;};
 document.getElementById('continue-group').onclick=function(){groupConfirmed=true;step=0;renderQuestion();};
}
function renderQuestion(){
 rail(1);var q=questions[step],value=answers[q.id],control='';
 if(q.type==='check')control='<label class="checkline"><input id="answer" type="checkbox" '+(value===true?'checked':'')+'><span>'+esc(q.text)+'</span></label>';
 else if(q.type==='select')control='<select id="answer"><option value="">Choose a rating</option>'+Array.from({length:11},function(_,i){return '<option value="'+i+'" '+(String(value)===String(i)?'selected':'')+'>'+i+'/10</option>';}).join('')+'</select>';
 else control='<textarea id="answer" maxlength="2500" placeholder="'+esc(q.placeholder||'Write your answer…')+'">'+esc(value||'')+'</textarea>';
 root.innerHTML='<div class="step-label"><span>Application questions</span><span>0'+(step+1)+' / 10</span></div><div class="progress"><span style="width:'+((step+1)/questions.length*100)+'%"></span></div><div class="eyebrow">Question '+(step+1)+' of '+questions.length+'</div><div class="question">'+esc(q.title)+'</div>'+(q.help?'<p class="help">'+esc(q.help)+'</p>':'')+control+'<div class="apply-actions">'+(step?'<button class="btn" id="back">Back</button>':'')+'<button class="btn primary" id="next">'+(step===9?'Review application':'Continue')+'</button></div><div class="status" id="apply-status"></div>';
 var input=document.getElementById('answer');
 function capture(){answers[q.id]=q.type==='check'?input.checked:input.value;}
 input.addEventListener('input',capture);input.addEventListener('change',capture);
 var back=document.getElementById('back');if(back)back.onclick=function(){capture();step--;renderQuestion();};
 document.getElementById('next').onclick=function(){capture();if(q.type==='check'&&answers[q.id]!==true){status('Please confirm this declaration to continue.');return;}if(q.type==='select'&&answers[q.id]===''){status('Please choose your activity rating.');return;}if(q.type==='text'&&String(answers[q.id]||'').trim().length<(q.min||20)){status('Please provide a little more detail.');return;}if(step<9){step++;renderQuestion();}else renderReview();};
}
function renderReview(){
 rail(2);var lines=questions.map(function(q,i){return '<div class="review-answer"><strong>'+(i+1)+'. '+esc(q.title)+'</strong><br>'+esc(q.type==='check'?'Confirmed':answers[q.id])+'</div>';}).join('');
 root.innerHTML='<div class="eyebrow">Step 03 / Final review</div><h2>Review your answers</h2><p class="introline">Check each response before submitting. Your application will be sent to the Hendon Police College review queue.</p>'+lines+'<div class="notice">By submitting, you confirm these answers are your own and that your account details are accurate.</div><div class="apply-actions"><button class="btn" id="edit">Back to answers</button><button class="btn primary" id="submit">Submit MET Application</button></div><div class="status" id="apply-status"></div>';
 document.getElementById('edit').onclick=function(){step=9;renderQuestion();};
 document.getElementById('submit').onclick=async function(){if(busy)return;busy=true;this.disabled=true;status('Submitting securely…');try{var result=await api('/api/met-application/submit',{method:'POST',body:JSON.stringify({answers:answers,groupRequestConfirmed:groupConfirmed})});root.innerHTML='<div class="eyebrow">Submission complete</div><h2>Application received</h2><div class="notice success"><strong>Reference '+esc(result.appRef)+'</strong><br>Your application has been received and added to the Hendon Police College review queue. '+(result.dmSent?'A confirmation was sent to your linked Discord account.':'We could not deliver a Discord DM. Check that your DMs are open; your application is still received.')+'</div><p class="introline">Please allow at least 12 hours before asking about the status of your application.</p><div class="apply-actions"><a class="btn" href="/profile">Return to profile</a></div>';rail(2);}catch(e){status(e.message);this.disabled=false;busy=false;}};
}
api('/api/met-application/meta').then(function(data){meta=data;load();}).catch(function(e){root.innerHTML='<div class="notice error">'+esc(e.message)+'</div><button class="btn" id="retry">Try again</button>';document.getElementById('retry').onclick=refresh;});
})();