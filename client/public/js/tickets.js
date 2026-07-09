// client/public/js/tickets.js
var ticketsCache=[],ticketFilter="all",proofFiles=[];
var allTicketsCache=[],allTicketFilter="all";
var ticketMode="import"; // "import" | "manual" (AI is case-only, disabled)
document.addEventListener("DOMContentLoaded",function(){
  var b1=document.getElementById("btn-new-ticket");
  var b2=document.getElementById("btn-submit-ticket");
  var b3=document.getElementById("btn-new-ticket-dash");
  if(b1)b1.addEventListener("click",openTicketModal);
  if(b2)b2.addEventListener("click",submitTicket);
  if(b3)b3.addEventListener("click",openTicketModal);
  document.querySelectorAll("#ticket-filter-tabs .filter-tab").forEach(function(tab){
    tab.addEventListener("click",function(){
      document.querySelectorAll("#ticket-filter-tabs .filter-tab").forEach(function(t){t.classList.remove("active");});
      tab.classList.add("active");ticketFilter=tab.dataset.tfilter;renderTicketsTable();
    });
  });
  document.querySelectorAll("#all-ticket-filter-tabs .filter-tab").forEach(function(tab){
    tab.addEventListener("click",function(){
      document.querySelectorAll("#all-ticket-filter-tabs .filter-tab").forEach(function(t){t.classList.remove("active");});
      tab.classList.add("active");allTicketFilter=tab.dataset.atfilter;renderAllTicketsTable();
    });
  });
  // Import-method selector + transcript import
  document.querySelectorAll("#ticket-mode-tabs .filter-tab").forEach(function(tab){
    if(tab.disabled)return;
    tab.addEventListener("click",function(){setTicketMode(tab.dataset.tmode);});
  });
  var bImp=document.getElementById("btn-import-transcript");
  if(bImp)bImp.addEventListener("click",importTicketFromTranscript);
  var impUrl=document.getElementById("t-import-url");
  if(impUrl)impUrl.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();importTicketFromTranscript();}});
});
// Draft persistence: keep an in-progress ticket while the modal is closed, so
// reopening resumes it. Clears on submit and on page refresh.
var ticketDraftActive=false;
function resetTicketForm(){
  proofFiles=[];
  ["t-roblox-username","t-ticket-type","t-conclusion","t-transcript-link","t-import-url"].forEach(function(id){var el=document.getElementById(id);if(el)el.value="";});
  var g=document.getElementById("proof-preview-grid");if(g)g.innerHTML="";
  var inp=document.getElementById("t-proof-input");if(inp)inp.value="";
  var tag=document.getElementById("ticket-roblox-tag");if(tag)tag.style.display="none";
  var ir=document.getElementById("t-import-result");if(ir)ir.style.display="none";
  // NB: do NOT prefill the Roblox username with the logged-in member's own name —
  // a ticket log is about the ticket *opener*, not the investigator. It stays
  // blank in manual mode and is filled by the transcript import (opener's name).
  presetTicketTime();
  setTicketMode(""); // no method picked yet — show only the selector chips
}
function openTicketModal(){
  if(!ticketDraftActive){ resetTicketForm(); ticketDraftActive=true; }
  openModal("modal-ticket");
}
// ── Import method (Import-from-link vs Build-manually) ────────────
// mode "" / null → nothing picked yet: show only the selector chips.
function setTicketMode(mode){
  ticketMode=mode||"";
  document.querySelectorAll("#ticket-mode-tabs .filter-tab").forEach(function(t){
    if(t.disabled)return;
    t.classList.toggle("active",!!mode&&t.dataset.tmode===mode);
  });
  var panel=document.getElementById("ticket-import-panel");
  var fields=document.getElementById("ticket-fields");
  if(!mode){ // pick a method first — hide the import panel and all fields
    if(panel)panel.style.display="none";
    if(fields)fields.style.display="none";
    return;
  }
  if(panel)panel.style.display=mode==="import"?"":"none";
  if(fields)fields.style.display="";
  // Import mode: fields stay greyed until a successful import fills them.
  // Manual mode: fields are immediately editable.
  setTicketFieldsEnabled(mode!=="import");
}
function setTicketFieldsEnabled(enabled){
  var box=document.getElementById("ticket-fields");if(!box)return;
  box.style.opacity=enabled?"":"0.5";
  box.style.pointerEvents=enabled?"":"none";
  box.querySelectorAll("input,textarea,select").forEach(function(el){el.disabled=!enabled;});
}
function tset(id,v){var el=document.getElementById(id);if(el)el.value=v;}
// Fill the datetime-local from an ISO instant using the viewer's LOCAL wall
// clock, so the transcript time reads correctly for the submitter in their own
// timezone (the timezone field is set to their local zone to match).
function setTicketDateTime(iso){
  var dt=document.getElementById("t-submitted-at");if(!dt)return;
  var d=new Date(iso);if(isNaN(d.getTime()))return;
  var p=function(n){return String(n).padStart(2,"0");};
  dt.value=d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes());
}
async function importTicketFromTranscript(){
  var urlEl=document.getElementById("t-import-url");
  var resEl=document.getElementById("t-import-result");
  var url=urlEl?urlEl.value.trim():"";
  if(!url){showToast("Paste a transcript link first.","error");return;}
  var btn=document.getElementById("btn-import-transcript");
  if(btn){btn.disabled=true;btn.innerHTML="<div class=\"spinner\"></div>";}
  try{
    var d=await api("/api/tickets/import-transcript",{method:"POST",body:JSON.stringify({transcriptLink:url})});
    tset("t-roblox-username",d.robloxUsername||"");
    tset("t-ticket-type",d.ticketType||"");
    tset("t-conclusion",d.conclusion||"");
    tset("t-transcript-link",d.transcriptLink||url);
    if(d.submittedAt)setTicketDateTime(d.submittedAt);
    tset("t-timezone-display",(typeof formatTzLabel==="function")?formatTzLabel():"UTC (GMT+0)");
    var tag=document.getElementById("ticket-roblox-tag");if(tag)tag.style.display="none";
    setTicketFieldsEnabled(true); // unlock now that they're populated
    if(resEl){
      resEl.style.display="";
      var nm=d.meta&&d.meta.ticketName?" · "+escapeHtml(d.meta.ticketName):"";
      var unv=(d.robloxUsername==="Unverified/Unknown")?" (creator could not be resolved — set the username manually)":"";
      resEl.innerHTML="<span style=\"color:var(--green);\">&#x2713; Imported"+nm+"</span>"+escapeHtml(unv);
    }
    showToast("Ticket details imported.","success");
  }catch(err){
    if(resEl){resEl.style.display="";resEl.innerHTML="<span style=\"color:var(--red);\">"+escapeHtml(err.message||"No matching ticket log found.")+"</span>";}
    showToast(err.message||"Import failed.","error");
  }finally{
    if(btn){btn.disabled=false;btn.innerHTML="<i class=\"ti ti-download\"></i> Import";}
  }
}
// Prefill the datetime-local with "now" (editable) and the timezone (editable)
function presetTicketTime(){
  var dt=document.getElementById("t-submitted-at"),ze=document.getElementById("t-timezone-display");
  if(dt){
    var now=new Date();
    var pad=function(n){return String(n).padStart(2,"0");};
    dt.value=now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate())+"T"+pad(now.getHours())+":"+pad(now.getMinutes());
  }
  if(ze)ze.value=formatTzLabel();
}
function handleProofFiles(fileList){
  var MAX=10,MB5=5*1024*1024;
  Array.from(fileList).forEach(function(file){
    if(proofFiles.length>=MAX){showToast("Max 10 images.","error");return;}
    if(file.size>MB5){showToast("File too large (max 5MB).","error");return;}
    var r=new FileReader();
    r.onload=function(e){proofFiles.push({name:file.name,dataUrl:e.target.result});renderProofPreviews();};
    r.readAsDataURL(file);
  });
}
function renderProofPreviews(){
  var g=document.getElementById("proof-preview-grid");if(!g)return;
  g.innerHTML=proofFiles.map(function(f,i){
    return "<div class=\"proof-thumb\"><img src=\""+f.dataUrl+"\" /><button class=\"proof-thumb-remove\" onclick=\"removeProof("+i+")\">&#x2715;</button></div>";
  }).join("");
}
function removeProof(i){proofFiles.splice(i,1);renderProofPreviews();}
async function submitTicket(){
  var ru=(document.getElementById("t-roblox-username")||{value:""}).value.trim();
  var tt=(document.getElementById("t-ticket-type")||{value:""}).value;
  var sa=(document.getElementById("t-submitted-at")||{value:""}).value;
  var tz=(document.getElementById("t-timezone-display")||{value:""}).value.trim();
  var co=(document.getElementById("t-conclusion")||{value:""}).value.trim();
  var tl=(document.getElementById("t-transcript-link")||{value:""}).value.trim();
  if(!ru){showToast("Roblox username is required.","error");return;}
  if(!tt){showToast("Please select a ticket type.","error");return;}
  if(!sa){showToast("Please select a date & time.","error");return;}
  if(!co){showToast("Conclusion is required.","error");return;}
  if(!tl){showToast("Ticket transcript link is required.","error");return;}
  var btn=document.getElementById("btn-submit-ticket");
  btn.disabled=true;btn.innerHTML="Submitting...";
  try{
    var t=await api("/api/tickets",{method:"POST",body:JSON.stringify({
      robloxUsername:ru,ticketType:tt,
      submittedAt:sa,
      timezone:tz||formatTzLabel(),
      conclusion:co,
      transcriptLink:tl,
      proofImages:proofFiles.map(function(f){return f.dataUrl;})
    })});
    closeModal("modal-ticket");
    resetTicketForm(); ticketDraftActive=false; // draft consumed
    showToast("Ticket "+t.ticketRef+" submitted for review.","success");
    loadTickets();
  }catch(err){showToast(err.message||"Failed to submit ticket.","error");}
  finally{btn.disabled=false;btn.innerHTML="<i class=\"ti ti-send\"></i> Submit Ticket Log";}
}
async function loadTickets(){
  var tbody=document.getElementById("tickets-tbody");if(!tbody)return;
  tbody.innerHTML="<tr><td colspan=\"8\" class=\"table-loading\"><div class=\"spinner\"></div></td></tr>";
  try{ticketsCache=await api("/api/tickets")||[];renderTicketsTable();updateTicketNavBadge();}
  catch(e){tbody.innerHTML="<tr><td colspan=\"8\" class=\"table-empty\"><span class=\"table-empty-text\">Failed to load tickets.</span></td></tr>";}
}
function updateTicketNavBadge(){
  // Single source of truth (own pending + all-pending) lives in dashboard.js
  if(typeof loadTicketNavBadge==="function") loadTicketNavBadge();
}
var TL={GENERAL_SUPPORT:"Website Support",HICOMM:"HICOMM",OFFICER_REPORT:"Officer Report",APPEAL:"Disciplinary Action Appeal"};
var TC={GENERAL_SUPPORT:"blue",HICOMM:"amber",OFFICER_REPORT:"red",APPEAL:"green"};
function ticketStatusBadge(s){
  var m={
    PENDING:"<span class=\"badge badge-pending\"><span class=\"badge-dot\"></span>Pending</span>",
    APPROVED:"<span class=\"badge badge-approved\"><span class=\"badge-dot\"></span>Approved</span>",
    DENIED:"<span class=\"badge badge-denied\"><span class=\"badge-dot\"></span>Denied</span>"
  };
  return m[s]||"<span class=\"badge\">"+escapeHtml(s||"")+"</span>";
}
function ticketRowActions(id,ticketType){
  // IA Complaints (HICOMM tickets) are HICOMM/Developer only — Supervisors can't action them.
  if(currentUser&&currentUser.role==="SUPERVISOR"&&ticketType==="HICOMM")
    return "<span style=\"color:var(--text-muted);font-size:11px;\">HICOMM only</span>";
  return "<div class=\"row-actions\">"
    +"<button class=\"row-btn row-btn-approve\" onclick=\"event.stopPropagation();decideTicket('"+id+"','approve')\"><i class=\"ti ti-check\"></i> Approve</button>"
    +"<button class=\"row-btn row-btn-deny\" onclick=\"event.stopPropagation();decideTicket('"+id+"','deny')\"><i class=\"ti ti-x\"></i> Deny</button>"
    +"</div>";
}
function renderTicketsTable(){
  var tbody=document.getElementById("tickets-tbody");if(!tbody)return;
  var elev=currentUser&&["HICOMM","SUPERVISOR","DEVELOPER"].indexOf(currentUser.role)>=0;
  var cols=elev?8:6;
  var filt=ticketFilter==="all"?ticketsCache:ticketsCache.filter(function(t){return t.status===ticketFilter;});
  if(!filt.length){tbody.innerHTML="<tr><td colspan=\""+cols+"\" class=\"table-empty\"><span class=\"table-empty-text\">No tickets found.</span></td></tr>";return;}
  tbody.innerHTML=filt.map(function(t){
    var c=TC[t.ticketType]||"blue",l=TL[t.ticketType]||t.ticketType;
    var pc=t.proofCount>0?"<i class=\"ti ti-photo\"></i> "+t.proofCount:"&mdash;";
    var inv=elev?"<td>"+escapeHtml((t.user&&(t.user.displayName||t.user.discordUsername))||"—")+"</td>":"";
    // You can't review your own ticket (server enforces this too); developers are
    // exempt so they can test the flow. Hide the Approve/Deny controls otherwise.
    var own=currentUser&&t.userId===currentUser.id&&currentUser.role!=="DEVELOPER";
    var dec=elev?"<td onclick=\"event.stopPropagation();\">"+(t.status==="PENDING"&&!own?ticketRowActions(t.id,t.ticketType):"")+"</td>":"";
    return "<tr onclick=\"openTicketDetail('"+t.id+"')\">"
      +"<td><span class=\"case-ref\">"+escapeHtml(t.ticketRef)+"</span></td>"
      +"<td><span style=\"font-size:12px;font-weight:500;\">"+escapeHtml(t.robloxUsername)+"</span></td>"
      +"<td><span class=\"badge badge-"+c+"\"><span class=\"badge-dot\"></span>"+escapeHtml(l)+"</span></td>"
      +"<td>"+ticketStatusBadge(t.status)+"</td>"
      +"<td>"+pc+"</td>"
      +"<td><span class=\"date-cell\">"+formatDateTime(t.createdAt)+"</span></td>"
      +inv+dec+"</tr>";
  }).join("");
}
async function decideTicket(ticketId,decision){
  try{
    await api("/api/tickets/"+ticketId+"/"+decision,{method:"PATCH"});
    var verb=decision==="approve"?"approved":"denied";
    showToast("Ticket "+verb+".",decision==="approve"?"success":"info");
    loadTickets();
    if(typeof loadTicketReview==="function")loadTicketReview();
    if(typeof loadAllTickets==="function")loadAllTickets();
    if(typeof loadTicketNavBadge==="function")loadTicketNavBadge();
  }catch(err){showToast(err.message||("Failed to "+decision+" ticket."),"error");}
}
async function deleteTicket(ticketId){
  if(!(await uiConfirm("Permanently delete this ticket log? This cannot be undone.")))return;
  try{
    await api("/api/admin/tickets/"+ticketId,{method:"DELETE"});
    closeModal("modal-ticket-detail");
    showToast("Ticket log deleted.","success");
    loadTickets();
    if(typeof loadAllTickets==="function")loadAllTickets();
    if(typeof loadTicketReview==="function")loadTicketReview();
    if(typeof loadTicketNavBadge==="function")loadTicketNavBadge();
  }catch(err){showToast(err.message||"Failed to delete ticket log.","error");}
}
// ── All Tickets (read-only for IA, decision controls for HICOMM) ──
async function loadAllTickets(){
  var tbody=document.getElementById("all-tickets-tbody");if(!tbody)return;
  tbody.innerHTML="<tr><td colspan=\"8\" class=\"table-loading\"><div class=\"spinner\"></div></td></tr>";
  try{allTicketsCache=await api("/api/tickets/all")||[];renderAllTicketsTable();}
  catch(e){tbody.innerHTML="<tr><td colspan=\"8\" class=\"table-empty\"><span class=\"table-empty-text\">Failed to load tickets.</span></td></tr>";}
}
function renderAllTicketsTable(){
  var tbody=document.getElementById("all-tickets-tbody");if(!tbody)return;
  var elev=currentUser&&["HICOMM","SUPERVISOR","DEVELOPER"].indexOf(currentUser.role)>=0;
  var cols=elev?8:7;
  var filt=allTicketFilter==="all"?allTicketsCache:allTicketsCache.filter(function(t){return t.status===allTicketFilter;});
  if(!filt.length){tbody.innerHTML="<tr><td colspan=\""+cols+"\" class=\"table-empty\"><span class=\"table-empty-text\">No tickets found.</span></td></tr>";return;}
  tbody.innerHTML=filt.map(function(t){
    var c=TC[t.ticketType]||"blue",l=TL[t.ticketType]||t.ticketType;
    var pc=t.proofCount>0?"<i class=\"ti ti-photo\"></i> "+t.proofCount:"&mdash;";
    var inv=(typeof investigatorCell==="function")?investigatorCell(t.user):escapeHtml((t.user&&(t.user.displayName||t.user.discordUsername))||"—");
    var dec=elev?"<td onclick=\"event.stopPropagation();\">"+(t.status==="PENDING"?"<button class=\"row-btn row-btn-approve btn-sm\" onclick=\"goReviewTicket('"+t.id+"')\"><i class=\"ti ti-clipboard-check\"></i> Review</button>":"")+"</td>":"";
    return "<tr onclick=\"openTicketDetail('"+t.id+"')\">"
      +"<td><span class=\"case-ref\">"+escapeHtml(t.ticketRef)+"</span></td>"
      +"<td>"+inv+"</td>"
      +"<td><span style=\"font-size:12px;font-weight:500;\">"+escapeHtml(t.robloxUsername)+"</span></td>"
      +"<td><span class=\"badge badge-"+c+"\"><span class=\"badge-dot\"></span>"+escapeHtml(l)+"</span></td>"
      +"<td>"+ticketStatusBadge(t.status)+"</td>"
      +"<td>"+pc+"</td>"
      +"<td><span class=\"date-cell\">"+formatDateTime(t.createdAt)+"</span></td>"
      +dec+"</tr>";
  }).join("");
}
// ── HICOMM Ticket Review Queue (mirrors the cases Review Queue) ──
async function loadTicketReview(){
  var tbody=document.getElementById("ticket-review-tbody");
  var label=document.getElementById("ticket-pending-count-label");
  if(!tbody)return;
  tbody.innerHTML="<tr><td colspan=\"7\" class=\"table-loading\"><div class=\"spinner\"></div></td></tr>";
  try{
    // ALL pending tickets (every user's), not just the reviewer's own
    var tickets=await api("/api/tickets/all?status=PENDING")||[];
    if(label)label.textContent=tickets.length+" awaiting decision";
    if(!tickets.length){tbody.innerHTML="<tr><td colspan=\"7\" class=\"table-empty\"><span class=\"table-empty-text\">No pending tickets — all caught up.</span></td></tr>";return;}
    tbody.innerHTML=tickets.map(function(t){
      var c=TC[t.ticketType]||"blue",l=TL[t.ticketType]||t.ticketType;
      var inv=(typeof investigatorCell==="function")?investigatorCell(t.user):escapeHtml((t.user&&(t.user.displayName||t.user.discordUsername))||"—");
      var ti=t.submittedAt;
      try{ti=new Date(t.submittedAt).toLocaleString([],{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch(e){}
      return "<tr onclick=\"openTicketDetail('"+t.id+"')\">"
        +"<td><span class=\"case-ref\">"+escapeHtml(t.ticketRef)+"</span></td>"
        +"<td>"+inv+"</td>"
        +"<td><span style=\"font-size:12px;font-weight:500;\">"+escapeHtml(t.robloxUsername)+"</span></td>"
        +"<td><span class=\"badge badge-"+c+"\"><span class=\"badge-dot\"></span>"+escapeHtml(l)+"</span></td>"
        +"<td><span style=\"font-size:11px;color:var(--text-secondary);\">"+escapeHtml(ti)+"</span></td>"
        +"<td><span class=\"date-cell\">"+formatDateTime(t.createdAt)+"</span></td>"
        +"<td onclick=\"event.stopPropagation();\">"+ticketRowActions(t.id,t.ticketType)+"</td>"
        +"</tr>";
    }).join("");
  }catch(e){tbody.innerHTML="<tr><td colspan=\"7\" class=\"table-empty\"><span class=\"table-empty-text\">Failed to load tickets.</span></td></tr>";}
}
// From All Tickets, jump to the Pending Tickets tab and open the ticket detail
// so elevated staff can approve/deny it there.
async function goReviewTicket(ticketId){
  try { if(typeof navigateTo==="function") await navigateTo("ticket-review"); } catch(e){}
  if(typeof openTicketDetail==="function") openTicketDetail(ticketId);
}

async function openTicketDetail(ticketId){
  var body=document.getElementById("tdetail-body"),ref=document.getElementById("tdetail-ref"),foot=document.getElementById("tdetail-footer");
  if(!body)return;
  body.innerHTML="<div class=\"table-loading\"><div class=\"spinner\"></div></div>";
  openModal("modal-ticket-detail");
  try{
    var t=await api("/api/tickets/"+ticketId);
    var c=TC[t.ticketType]||"blue",l=TL[t.ticketType]||t.ticketType;
    if(ref)ref.textContent=t.ticketRef;
    var sd=t.submittedAt;
    try{sd=new Date(t.submittedAt).toLocaleString([],{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch(e2){}
    var invName=(t.user&&(t.user.displayName||t.user.discordUsername))||"—";
    var invHandle=(t.user&&t.user.discordUsername)?(" <span style=\"color:var(--text-muted);font-size:11px;\">@"+escapeHtml(t.user.discordUsername)+"</span>"):"";
    var rev=(t.reviewer&&(t.reviewer.displayName||t.reviewer.discordUsername))||null;
    var createdOn=t.createdAt?formatDateTime(t.createdAt):"—";
    var reviewedOn=t.reviewedAt?formatDateTime(t.reviewedAt):null;
    var ph=Array.isArray(t.proofImages)&&t.proofImages.length
      ?"<div class=\"proof-preview-grid proof-preview-grid-detail\">"+
        t.proofImages.map(function(src,i){return "<a href=\""+src+"\" onclick=\"return openImageNewTab(this.href)\" class=\"proof-thumb\"><img src=\""+src+"\" loading=\"lazy\"/></a>";}).join("")+"</div>"
      :"<span style=\"color:var(--text-muted);\">No proof images attached.</span>";
    // Target Roblox user header (resolved server-side)
    var tg=t.target,targetHeader="";
    if(tg){
      var grpChip=tg.inGroup
        ?"<span class=\"badge badge-green\"><span class=\"badge-dot\"></span>MET Group"+(tg.groupRole?" · "+escapeHtml(tg.groupRole)+(tg.groupRank!=null?" ("+tg.groupRank+")":""):"")+"</span>"
        :"<span class=\"badge badge-red\"><span class=\"badge-dot\"></span>Not in MET Group</span>";
      targetHeader="<div style=\"display:flex;align-items:center;gap:12px;margin-bottom:1.1rem;padding-bottom:1.1rem;border-bottom:1px solid var(--border-dim);\">"
        +(tg.avatar?"<img src=\""+tg.avatar+"\" alt=\"\" style=\"width:54px;height:54px;border-radius:10px;border:1px solid var(--border-dim);flex-shrink:0;\"/>":"")
        +"<div style=\"flex:1;min-width:0;\">"
        +"<div style=\"font-weight:700;font-size:15px;\">"+escapeHtml(tg.displayName||tg.username||t.robloxUsername)+"</div>"
        +"<div style=\"font-size:12px;color:var(--text-muted);\">@"+escapeHtml(tg.username||t.robloxUsername)+" &middot; ID "+escapeHtml(tg.robloxId)+"</div>"
        +"<div style=\"margin-top:6px;\">"+grpChip+"</div>"
        +"</div>"
        +"<a class=\"btn btn-ghost btn-sm\" href=\""+escapeHtml(tg.profileUrl)+"\" target=\"_blank\" rel=\"noopener\" style=\"white-space:nowrap;\"><i class=\"ti ti-external-link\"></i> Profile</a>"
        +"</div>";
    }
    body.innerHTML=targetHeader+"<div class=\"detail-grid\">"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Ticket Ref</span><span class=\"detail-field-value mono\">"+escapeHtml(t.ticketRef)+"</span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Status</span><span class=\"detail-field-value\">"+ticketStatusBadge(t.status)+"</span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Type</span><span class=\"detail-field-value\"><span class=\"badge badge-"+c+"\"><span class=\"badge-dot\"></span>"+escapeHtml(l)+"</span></span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Roblox Username</span><span class=\"detail-field-value mono\">"+escapeHtml(t.robloxUsername)+"</span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Investigator</span><span class=\"detail-field-value\">"+escapeHtml(invName)+invHandle+"</span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Incident Time</span><span class=\"detail-field-value\">"+escapeHtml(sd)+"</span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Timezone</span><span class=\"detail-field-value mono\">"+escapeHtml(displayTz(t.timezone))+"</span></div>"
      +"<div class=\"detail-field\"><span class=\"detail-field-label\">Submitted On</span><span class=\"detail-field-value\">"+escapeHtml(createdOn)+"</span></div>"
      +(rev?"<div class=\"detail-field\"><span class=\"detail-field-label\">"+(t.status==="APPROVED"?"Approved":"Denied")+" By</span><span class=\"detail-field-value\">"+escapeHtml(rev)+"</span></div>":"")
      +(reviewedOn?"<div class=\"detail-field\"><span class=\"detail-field-label\">Reviewed On</span><span class=\"detail-field-value\">"+escapeHtml(reviewedOn)+"</span></div>":"")
      +"<div class=\"detail-divider\"></div>"
      +"<div class=\"detail-field full\"><span class=\"detail-field-label\">Conclusion</span><span class=\"detail-field-value\" style=\"white-space:pre-wrap;line-height:1.7;\">"+escapeHtml(t.conclusion)+"</span></div>"
      +(t.transcriptLink?"<div class=\"detail-field full\"><span class=\"detail-field-label\">Transcript</span><span class=\"detail-field-value\"><a href=\""+escapeHtml(t.transcriptLink)+"\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"color:var(--blue);word-break:break-all;\">"+escapeHtml(t.transcriptLink)+"</a></span></div>":"")
      +"<div class=\"detail-divider\"></div>"
      +"<div class=\"detail-field full\"><span class=\"detail-field-label\">Proof Images</span><span class=\"detail-field-value\">"+ph+"</span></div>"
      +"</div>";
    // Footer — approve/deny for HICOMM when pending; delete for developers
    if(foot){
      var elev=currentUser&&["HICOMM","SUPERVISOR","DEVELOPER"].indexOf(currentUser.role)>=0;
      var isDev=currentUser&&currentUser.role==="DEVELOPER";
      // IA Complaints (HICOMM tickets) can only be actioned by HICOMM/Developer.
      var canDecide=elev&&!(t.ticketType==="HICOMM"&&currentUser.role==="SUPERVISOR");
      var html="";
      if(isDev){
        html+="<button class=\"btn btn-danger\" style=\"margin-right:auto;\" onclick=\"deleteTicket('"+t.id+"')\"><i class=\"ti ti-trash\"></i> Delete Log</button>";
      }
      html+="<button class=\"btn btn-ghost\" onclick=\"closeModal('modal-ticket-detail')\">Close</button>";
      html+="<button class=\"btn btn-ghost\" onclick=\"copyTicketLink('"+t.id+"')\"><i class=\"ti ti-link\"></i> Copy link</button>";
      if(elev&&!canDecide&&t.status==="PENDING"){
        html+="<span style=\"color:var(--text-muted);font-size:11px;align-self:center;\">HICOMM only</span>";
      }
      if(canDecide&&t.status==="PENDING"){
        html+="<button class=\"btn btn-danger\" onclick=\"closeModal('modal-ticket-detail');decideTicket('"+t.id+"','deny')\"><i class=\"ti ti-x\"></i> Deny</button>"
          +"<button class=\"btn btn-success\" onclick=\"closeModal('modal-ticket-detail');decideTicket('"+t.id+"','approve')\"><i class=\"ti ti-check\"></i> Approve</button>";
      }
      foot.innerHTML=html;
    }
  }catch(e){body.innerHTML="<p style=\"color:var(--red);padding:1rem;\">Failed to load ticket details.</p>";}
}
