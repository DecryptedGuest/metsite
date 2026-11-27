(function(){
'use strict';
var root=document.getElementById('apply-content');
var meta=null,answers={},step=0,groupConfirmed=false,busy=false;
var questions=[
{id:'q1',title:'Patrol restrictions',help:'Successful applicants begin at Community Support Officer (CSO).',type:'check',text:'I understand that, if accepted, I will initially be ranked Community Support Officer. I must not patrol alone until I have attended a supervised patrol event and been promoted to Constable. Patrolling alone before that promotion may result in termination.'},
{id:'q2',title:'Originality and application integrity',help:'Your written answers must reflect your own knowledge and experience.',type:'check',text:'I confirm that I will write my answers myself and will not use AI tools or another person to generate or write them for me. I understand that applications may be reviewed for originality and integrity, and suspected misuse may lead to rejection or further recruitment action.'},
{id:'q3',title:'Why do you want to join the Metropolitan Police Service?',type:'text',placeholder:'Explain your reasons for applying…'},
{id:'q4',title:'What qualities or experience would help you perform well as a police officer?',type:'text',placeholder:'Describe the qualities you would bring…'},
{id:'q5',title:'Have you previously been part of a Roblox police department or emergency services group?',help:'If yes, name the group(s) and briefly describe your role or experience. If not, say so.',type:'text',placeholder:'Your previous experience…'},
{id:'q6',title:'What would you hope to achieve as a member of the Metropolitan Police Service?',type:'text',placeholder:'Describe your goals…'},
{id:'q7',title:'How active can you realistically be in-game each week?',type:'select'},
{id:'q8',title:'What does professionalism mean to you in a roleplay police department?',type:'text',placeholder:'Explain what professionalism looks like in practice…'},
{id:'q9',title:'You witness another officer abusing their powers. How would you respond?',type:'text',placeholder:'Explain the steps you would take…'},
{id:'q10',title:'Application status enquiries',help:'Allow the recruitment team time to review your submission.',type:'check',text:'I understand that I must wait at least 12 hours after submitting before asking anyone about my application status. Contacting staff about its status before that period has passed may result in my application being denied.'}
];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function csrf(){var m=document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);return m?decodeURIComponent(m[1]):'';}
async function api(url,opts){opts=opts||{};opts.credentials='same-origin';opts.headers=Object.assign({'Content-Type':'application/json','X-CSRF-Token':csrf()},opts.headers||{});var r=await fetch(url,opts);var d=await r.json().catch(function(){return {};});if(!r.ok)throw new Error(d.error||'Request failed.');return d;}
function status(msg){var el=document.getElementById('apply-status');if(el)el.textContent=msg||'';}
function load(){
 if(!meta)return;
 if(meta.needsRobloxLink){root.innerHTML='<div class="notice warning"><strong>Roblox account not linked</strong><br>'+esc(meta.message||'Link your Roblox account before applying.')+'</div><div class="apply-actions"><a class="btn primary" href="/login">Go to sign in</a></div>';return;}
 if(meta.existing){root.innerHTML='<div class="notice success"><strong>Application received</strong><br>Your application <b>'+esc(meta.existing.appRef)+'</b> is awaiting review. You do not need to submit another one.</div>';return;}
 if(!meta.canApply){root.innerHTML='<div class="notice warning">You cannot start another application at this time.</div>';return;}
 if(!meta.isMember&&!groupConfirmed){renderGroup();return;}
 renderQuestion();
}
function renderGroup(){
 root.innerHTML='<div class="eyebrow">Before you begin · Group membership</div><div class="question">Request to join the MET Roblox community</div><p class="help">You must request to join the Metropolitan Police SLR community before submitting this application. If your account is already a member, this step is automatically skipped.</p><div class="notice"><strong>Roblox account:</strong> '+esc(meta.robloxUsername||'Linked account')+'<br><strong>Community:</strong> Metropolitan Police SLR</div><div class="apply-actions"><a class="btn primary" href="'+esc(meta.groupUrl)+'" target="_blank" rel="noopener">Open Roblox community</a><button class="btn" id="check-group">Check membership</button></div><div class="notice warning"><strong>Pending requests:</strong> This site can verify current membership, but Roblox does not make an applicant’s pending join-request status available through the permissions currently configured. If you have already sent a request and are waiting for approval, confirm that below to continue. Your request will not be falsely shown as verified.</div><label class="checkline"><input type="checkbox" id="group-confirm"><span>I have requested to join the Metropolitan Police SLR Roblox community and understand that my application may be declined if I have not done so.</span></label><div class="apply-actions"><button class="btn primary" id="continue-group" disabled>Continue to application</button></div><div class="status" id="apply-status"></div>';
 document.getElementById('check-group').onclick=async function(){this.disabled=true;status('Checking current membership…');try{meta=await api('/api/met-application/meta');if(meta.isMember===true){groupConfirmed=true;load();}else if(meta.membershipCheckAvailable===false){status('Roblox did not allow this site to verify membership right now. If you have sent a join request, confirm below to continue.');}else{status('You are not currently listed as a group member. If your join request is pending, confirm below to continue.');}}catch(e){status(e.message);}finally{this.disabled=false;}};
 document.getElementById('group-confirm').onchange=function(){document.getElementById('continue-group').disabled=!this.checked;};
 document.getElementById('continue-group').onclick=function(){groupConfirmed=true;renderQuestion();};
}
function renderQuestion(){
 var q=questions[step],value=answers[q.id];
 var control='';
 if(q.type==='check')control='<label class="checkline"><input id="answer" type="checkbox" '+(value===true?'checked':'')+'><span>'+esc(q.text)+'</span></label>';
 else if(q.type==='select'){control='<select id="answer"><option value="">Choose a rating</option>'+Array.from({length:11},function(_,i){return '<option value="'+i+'" '+(String(value)===String(i)?'selected':'')+'>'+i+'/10</option>';}).join('')+'</select>';}
 else control='<textarea id="answer" maxlength="2500" placeholder="'+esc(q.placeholder||'Write your answer…')+'">'+esc(value||'')+'</textarea>';
 root.innerHTML='<div class="step-label"><span>Application questions</span><span>'+ (step+1)+' of '+questions.length+'</span></div><div class="progress"><span style="width:'+((step+1)/questions.length*100)+'%"></span></div><div class="eyebrow">Question '+(step+1)+'</div><div class="question">'+esc(q.title)+'</div>'+(q.help?'<p class="help">'+esc(q.help)+'</p>':'')+control+'<div class="apply-actions">'+(step?'<button class="btn" id="back">Back</button>':'')+'<button class="btn primary" id="next">'+(step===questions.length-1?'Review and submit':'Continue')+'</button></div><div class="status" id="apply-status"></div>';
 var input=document.getElementById('answer');
 input.addEventListener('input',function(){answers[q.id]=q.type==='check'?input.checked:input.value;});
 input.addEventListener('change',function(){answers[q.id]=q.type==='check'?input.checked:input.value;});
 var back=document.getElementById('back');if(back)back.onclick=function(){answers[q.id]=q.type==='check'?input.checked:input.value;step--;renderQuestion();};
 document.getElementById('next').onclick=function(){answers[q.id]=q.type==='check'?input.checked:input.value;if(q.type==='check'&&answers[q.id]!==true){status('You must confirm this declaration to continue.');return;}if(q.type==='select'&&answers[q.id]===''){status('Please choose your activity rating.');return;}if(q.type==='text'&&String(answers[q.id]||'').trim().length<20){status('Please provide a little more detail (at least 20 characters).');return;}if(step<questions.length-1){step++;renderQuestion();}else renderReview();};
}
function renderReview(){
 var lines=questions.map(function(q,i){var v=answers[q.id];return '<div class="notice"><strong>'+(i+1)+'. '+esc(q.title)+'</strong><br>'+esc(q.type==='check'?'Agreed':v)+'</div>';}).join('');
 root.innerHTML='<div class="eyebrow">Final review</div><div class="question">Check your answers before submitting</div><p class="help">Once submitted, your application will be sent to MET High Command for review. You will not be able to edit it here.</p>'+lines+'<div class="apply-actions"><button class="btn" id="edit">Back to answers</button><button class="btn primary" id="submit">Submit application</button></div><div class="status" id="apply-status"></div>';
 document.getElementById('edit').onclick=function(){step=questions.length-1;renderQuestion();};
 document.getElementById('submit').onclick=async function(){if(busy)return;busy=true;this.disabled=true;status('Submitting application…');try{var result=await api('/api/met-application/submit',{method:'POST',body:JSON.stringify({answers:answers,groupRequestConfirmed:meta.isMember||groupConfirmed})});root.innerHTML='<div class="eyebrow">Submitted</div><div class="question">Application received</div><div class="notice success"><strong>Reference: '+esc(result.appRef)+'</strong><br>Your application has been sent to MET High Command. Please allow at least 12 hours before asking about its status.</div><div class="apply-actions"><a class="btn" href="/profile">Return to profile</a></div>';}catch(e){status(e.message);this.disabled=false;busy=false;}};
}
api('/api/met-application/meta').then(function(data){meta=data;load();}).catch(function(e){root.innerHTML='<div class="notice error">'+esc(e.message)+'</div><button class="btn" onclick="location.reload()">Try again</button>';});
})();