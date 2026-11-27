// CID recruitment applications. Applicant endpoints expose only the caller's
// own status; management endpoints are restricted to Assistant Director+ in CID.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/db');
const { getUserGroupRole, getGroupRolesPublic, getUserGroupRoles } = require('../lib/roblox');
const { tierForRank } = require('../lib/ranks');

const GROUPS = {
  MET: process.env.GROUP_MET || '17275620',
  CID: process.env.GROUP_CID || '12697126',
  SCO19: process.env.GROUP_SCO19 || '14063116',
  FLP: process.env.GROUP_FLP || '233530818',
  IA: process.env.IA_GROUP_ID || '407296071',
  HPC: process.env.GROUP_HPC || '35685825',
};
const QUESTIONS = [
  { id:'roblox', section:'Personal Information', label:'Roblox Username', required:true, max:40 },
  { id:'discord', section:'Personal Information', label:'Discord Username', required:true, max:80 },
  { id:'metRank', section:'Personal Information', label:'Current Metropolitan Police Rank', required:true, max:100 },
  { id:'tenure', section:'Personal Information', label:'How long have you been in the department?', required:true, max:300 },
  { id:'timezone', section:'Personal Information', label:'What is your timezone?', required:true, max:100 },
  { id:'hours', section:'Personal Information', label:'How many hours per week can you dedicate to CID?', required:true, max:100 },
  { id:'knowledge1', section:'CID Knowledge', label:'What does CID stand for?', required:true, max:2000 },
  { id:'knowledge2', section:'CID Knowledge', label:'What is the primary role of CID within the Metropolitan Police?', required:true, max:3000 },
  { id:'knowledge3', section:'CID Knowledge', label:'What is the difference between operating undercover and conducting a patrol in uniform?', required:true, max:3000 },
  { id:'knowledge4', section:'CID Knowledge', label:'Why is it important for undercover officers to avoid revealing their identity unnecessarily?', required:true, max:3000 },
  { id:'knowledge5', section:'CID Knowledge', label:'When would it be appropriate for a CID officer to wear tactical equipment such as a vest instead of operating in plain clothes?', required:true, max:3000 },
  { id:'knowledge6', section:'CID Knowledge', label:'Why is communication with other officers important during an arrest or police operation?', required:true, max:3000 },
  { id:'scenario1', section:'Situational Scenarios', prompt:'You are operating undercover when you notice an individual openly carrying out criminal activity. They have not noticed that you are a police officer.', label:'How would you handle the situation without unnecessarily exposing your undercover identity?', required:true, max:4000 },
  { id:'scenario2', section:'Situational Scenarios', prompt:'You are operating in plain clothes when a suspect attempts to flee after committing an offence.', label:'What would you do to arrest the suspect while maintaining proper roleplay?', required:true, max:4000 },
  { id:'scenario3', section:'Situational Scenarios', prompt:'During an operation, another officer is giving important information over the radio, but several members are talking over them.', label:'What would you do to ensure communication remains clear?', required:true, max:4000 },
  { id:'scenario4', section:'Situational Scenarios', prompt:'You notice another CID member abusing their authority, using unnecessary force or breaking CID regulations.', label:'What would you do?', required:true, max:4000 },
  { id:'scenario5', section:'Situational Scenarios', prompt:'An individual begins questioning whether you are actually a police officer while you are operating undercover.', label:'How would you handle the situation?', required:true, max:4000 },
  { id:'motivation1', section:'Motivation and Commitment', label:'Why do you want to join CID instead of another Metropolitan Police division?', required:true, max:3000 },
  { id:'motivation2', section:'Motivation and Commitment', label:'What makes you suitable for undercover and plainclothes operations?', required:true, max:3000 },
  { id:'motivation3', section:'Motivation and Commitment', label:'How would you contribute to improving CID activity and professionalism?', required:true, max:3000 },
  { id:'motivation4', section:'Motivation and Commitment', label:'How would you react if a supervisor corrected your behaviour or performance during a patrol?', required:true, max:3000 },
  { id:'motivation5', section:'Motivation and Commitment', label:'Are you willing to follow CID leadership instructions and maintain division activity standards?', required:true, max:3000 },
  { id:'declaration', section:'Declaration', label:'Confirm each statement below', required:true, type:'agreement' },
];
const DECLARATION = [
  'All information provided is truthful.',
  'I understand that submitting an application does not guarantee acceptance.',
  'I agree to follow the Metropolitan Police regulations and CID Handbook.',
  'I understand that successful applicants must complete a supervised patrol period.',
  'I understand that my activity, professionalism, communication and roleplay ability will be evaluated.',
  'I understand that failure to meet CID standards may result in rejection.',
];

async function groupRole(user, groupId) {
  if (!user || !user.robloxId) return { available:true, role:null };
  const diag = {};
  try {
    const role = await getUserGroupRole(String(user.robloxId), String(groupId), diag);
    return { available:!diag.failed, role:role || null };
  } catch (e) { return { available:false, role:null }; }
}
async function groupMember(user, groupId) {
  if (!user || !user.robloxId) return { available:true, member:false };
  const diag = {};
  try {
    const roles = await getUserGroupRoles(String(user.robloxId), String(groupId), diag);
    return { available:!diag.failed, member:Array.isArray(roles) && roles.length>0 };
  } catch (e) { return { available:false, member:false }; }
}
async function eligibility(user) {
  if (!user.robloxId) return { available:true, eligible:false, reasons:['Link your Roblox account before applying.'] };
  const [met,cid,sco,flp,ia,hpc,metRoles] = await Promise.all([
    groupRole(user,GROUPS.MET), groupRole(user,GROUPS.CID),
    groupMember(user,GROUPS.SCO19), groupMember(user,GROUPS.FLP),
    groupMember(user,GROUPS.IA), groupMember(user,GROUPS.HPC),
    getGroupRolesPublic(GROUPS.MET).catch(()=>null),
  ]);
  const checks=[met,cid,sco,flp,ia,hpc];
  if (checks.some(x=>!x.available) || !metRoles) return { available:false, eligible:false, reasons:['Roblox eligibility checks are temporarily unavailable. Please try again later.'] };
  const reasons=[];
  const constables=metRoles.filter(r=>/constable/i.test(String(r.name||''))).sort((a,b)=>Number(a.rank)-Number(b.rank));
  const constable=constables[0]||null;
  if (!constable || !met.role || Number(met.role.rank)<Number(constable.rank)) reasons.push('You must be MET Constable or above.');
  if (sco.member) reasons.push('Members of Specialist Firearms Command are not eligible.');
  if (flp.member) reasons.push('Members of a primary division are not eligible for CID applications.');
  if (ia.member && hpc.member) reasons.push('You cannot hold two secondary divisions (IA and HPC) while applying.');
  let multi=false;
  try {
    const perms=await require('../lib/permsGroup').resolveUserPerms(String(user.robloxId));
    multi=perms.some(p=>String(p.key)==='773235023' || /multi division perms/i.test(String(p.label||'')));
  } catch(e) {}
  if ((flp.member || (ia.member && hpc.member)) && multi) {
    const i=reasons.findIndex(x=>/primary division|two secondary divisions/.test(x));
    if(i>=0) reasons.splice(i,1);
  }
  if (!cid.role || !/pending/i.test(String(cid.role.name||''))) reasons.push('Your CID group rank must be Pending before you submit.');
  return { available:true, eligible:reasons.length===0, reasons, metRank:met.role && met.role.name, cidRank:cid.role && cid.role.name, divisions:{ primary:flp.member?['FLP']:[], secondary:[ia.member?'IA':null,hpc.member?'HPC':null].filter(Boolean) }, multiDivisionPermissions:multi };
}
async function adminUser(req) {
  try {
    const fresh=await require('../lib/accessControl').ensureFreshUser(req.user);
    if(fresh) req.user=fresh;
  } catch(e) { /* fail closed below */ }
  const e=(Array.isArray(req.user.divisions)?req.user.divisions:[]).find(x=>x.division==='CID');
  return !!(e && tierForRank('CID',e.rankName)==='HIGH');
}
async function requireCidAdmin(req,res,next) {
  if(!req.user) return res.status(401).json({error:'Sign in required.'});
  if(await adminUser(req)) return next();
  return res.status(403).json({error:'CID Assistant Director or above is required.'});
}
async function settings() {
  return prisma.cidApplicationSettings.upsert({where:{id:'default'},create:{id:'default',isOpen:false},update:{}});
}
function integrityFlags(answers, telemetry) {
  const values=Object.entries(answers||{}).filter(([k,v])=>k!=='declaration' && typeof v==='string' && v.trim());
  const flags=[];
  const normalized=values.map(([id,v])=>({id,text:v.trim().toLowerCase().replace(/\s+/g,' ')}));
  const seen=new Map();
  for(const x of normalized) {
    if(x.text.length<35) flags.push({severity:'info',code:'SHORT_ANSWER',label:'Short response',detail:'One response is unusually brief and may need follow-up.'});
    const key=x.text.slice(0,180);
    if(seen.has(key)) flags.push({severity:'review',code:'REPEATED_ANSWER',label:'Repeated wording',detail:'Two answers contain identical opening text.'});
    else seen.set(key,x.id);
  }
  const combined=normalized.map(x=>x.text).join(' ');
  const phrases=['in conclusion','furthermore','moreover','it is important to note','as an ai'];
  const matches=phrases.filter(p=>combined.includes(p));
  if(matches.length>=3) flags.push({severity:'review',code:'FORMAL_PATTERN',label:'Writing pattern to review',detail:'Several formulaic phrases appear across responses; this is not proof of AI use.'});
  const words=combined.split(/\s+/).filter(Boolean).length;
  if(words>2500) flags.push({severity:'info',code:'HIGH_VOLUME',label:'High response volume',detail:'The combined response is unusually long.'});
  const timings=telemetry && telemetry.answerSeconds && typeof telemetry.answerSeconds==='object' ? Object.values(telemetry.answerSeconds).map(Number).filter(Number.isFinite) : [];
  if(timings.length>=8 && timings.reduce((a,b)=>a+b,0)<90) flags.push({severity:'review',code:'FAST_COMPLETION',label:'Unusually fast completion',detail:'The form was completed unusually quickly. Review alongside the answers; speed alone is not evidence of misconduct.'});
  if(telemetry && Number(telemetry.pasteCount)>0) flags.push({severity:'info',code:'PASTE_ACTIVITY',label:'Paste activity recorded',detail:String(Number(telemetry.pasteCount))+' paste event(s) recorded. Pasting is not proof of AI use.'});
  let similar=false;
  for(let i=0;i<normalized.length;i++) for(let j=i+1;j<normalized.length;j++) {
    const a=new Set(normalized[i].text.split(/\W+/).filter(w=>w.length>3));
    const b=new Set(normalized[j].text.split(/\W+/).filter(w=>w.length>3));
    if(a.size<12 || b.size<12) continue;
    const union=new Set([...a,...b]);
    const overlap=[...a].filter(w=>b.has(w)).length/Math.max(1,union.size);
    if(overlap>.72) similar=true;
  }
  if(similar) flags.push({severity:'review',code:'HIGH_SIMILARITY',label:'Similar responses',detail:'Some answers use unusually similar vocabulary. Consider whether the questions naturally call for similar wording.'});
  return flags;
}
function nextRef(n){return 'CID-'+String(n).padStart(4,'0');}

router.get('/meta', async(req,res)=>{
  try {
    res.set('Cache-Control','no-store');
    const [check,form,existing]=await Promise.all([
      eligibility(req.user), settings(),
      prisma.cidApplication.findFirst({where:{applicantId:req.user.id,status:{in:['SUBMITTED','UNDER_REVIEW','ACCEPTED']}},select:{appRef:true,status:true,submittedAt:true}})
    ]);
    res.json({eligible:check.eligible,checksAvailable:check.available,reasons:check.reasons||[],context:check,open:form.isOpen,existing,questions:QUESTIONS,declaration:DECLARATION,robloxUsername:req.user.robloxUsername||null,discordUsername:req.user.discordUsername||req.user.displayName||'Discord user'});
  } catch(e){console.error('[CID application] meta:',e.message);res.status(500).json({error:'Could not load CID application.'});}
});
router.post('/submit',async(req,res)=>{
  try {
    const [check,form]=await Promise.all([eligibility(req.user),settings()]);
    if(!check.available) return res.status(503).json({error:'Roblox eligibility checks are unavailable. Try again later.'});
    if(!check.eligible) return res.status(403).json({error:(check.reasons||[])[0]||'Not eligible.'});
    if(!form.isOpen) return res.status(423).json({error:'CID applications are currently closed.'});
    const existing=await prisma.cidApplication.findFirst({where:{applicantId:req.user.id,status:{in:['SUBMITTED','UNDER_REVIEW','ACCEPTED']}},select:{appRef:true}});
    if(existing) return res.status(409).json({error:'You already have an active CID application.',appRef:existing.appRef});
    const answers=req.body&&req.body.answers;
    if(!answers || typeof answers!=='object' || Array.isArray(answers)) return res.status(400).json({error:'Complete the application before submitting.'});
    for(const q of QUESTIONS) {
      const v=answers[q.id];
      if(q.type==='agreement') { if(v!==true) return res.status(400).json({error:'You must accept every declaration statement.'}); }
      else if(q.required && (typeof v!=='string' || v.trim().length<2 || v.length>q.max)) return res.status(400).json({error:'Please complete: '+q.label});
    }
    const count=await prisma.cidApplication.count();
    const row=await prisma.cidApplication.create({data:{
      appRef:nextRef(count+1),applicantId:req.user.id,discordId:req.user.discordId,
      discordUsername:req.user.discordUsername||null,robloxId:String(req.user.robloxId),
      robloxUsername:String(req.user.robloxUsername||'').trim(),
      answers:{...answers,roblox:req.user.robloxUsername||'',discord:req.user.discordUsername||'',metRank:check.metRank||''},context:check,flags:integrityFlags(answers,req.body&&req.body.telemetry),status:'SUBMITTED',
    }});
    require('../lib/audit').record({req,action:'CID_APPLICATION_SUBMITTED',category:'recruitment',targetType:'cid_application',targetId:row.id,summary:'Submitted CID application '+row.appRef}).catch(()=>{});
    res.status(201).json({ok:true,appRef:row.appRef});
  } catch(e){console.error('[CID application] submit:',e.message);res.status(500).json({error:'Could not submit your CID application.'});}
});

router.get('/admin',requireCidAdmin,async(req,res)=>{
  try {
    const form=await settings();
    const rows=await prisma.cidApplication.findMany({orderBy:{submittedAt:'desc'},take:250});
    res.set('Cache-Control','no-store');
    res.json({open:form.isOpen,updatedAt:form.updatedAt,responses:rows});
  } catch(e){res.status(500).json({error:'Could not load CID applications.'});}
});
router.post('/admin/state',requireCidAdmin,async(req,res)=>{
  try {
    const open=!!(req.body&&req.body.open);
    const row=await prisma.cidApplicationSettings.upsert({where:{id:'default'},create:{id:'default',isOpen:open,updatedBy:req.user.id},update:{isOpen:open,updatedBy:req.user.id}});
    require('../lib/audit').record({req,action:open?'CID_APPLICATIONS_OPENED':'CID_APPLICATIONS_CLOSED',category:'recruitment',targetType:'cid_application_settings',targetId:'default',summary:open?'Opened CID applications':'Closed CID applications'}).catch(()=>{});
    res.json({ok:true,open:row.isOpen});
  } catch(e){res.status(500).json({error:'Could not update application status.'});}
});
router.patch('/admin/:id',requireCidAdmin,async(req,res)=>{
  try {
    const requested=String(req.body&&req.body.status||'').toUpperCase();
    if(requested && !['UNDER_REVIEW','ACCEPTED','REJECTED'].includes(requested)) return res.status(400).json({error:'Invalid application status.'});
    const existing=await prisma.cidApplication.findUnique({where:{id:req.params.id},select:{status:true}});
    if(!existing) return res.status(404).json({error:'Application not found.'});
    const status=requested||existing.status;
    const note=String(req.body&&req.body.note||'').slice(0,4000);
    const row=await prisma.cidApplication.update({where:{id:req.params.id},data:{status,reviewerNote:note,reviewedAt:new Date(),reviewedById:req.user.id,reviewedByName:req.user.discordUsername||req.user.displayName||'CID reviewer'}});
    require('../lib/audit').record({req,action:'CID_APPLICATION_'+status,category:'recruitment',targetType:'cid_application',targetId:row.id,summary:row.appRef+' marked '+status}).catch(()=>{});
    res.json({ok:true,id:row.id,status:row.status});
  } catch(e){res.status(500).json({error:'Could not update this application.'});}
});
module.exports=router;
module.exports.requireCidAdmin=requireCidAdmin;
module.exports.requireCidAdminPage=async function(req,res,next){if(!req.user)return res.redirect('/login');if(await adminUser(req))return next();return res.redirect('/cid/denied');};
