import { Router } from 'express';
import { z } from 'zod';
const uuid = z.string().uuid();
const transactionSchema = z.object({
  stationId: uuid, toUserId: uuid,
  transactionType: z.enum(['funds_issued','cash_handover','cash_remittance','staff_advance','reimbursement','shortage_report','overage_report','other']),
  amount: z.coerce.number().positive().max(100000000000),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(1500),
  evidenceReference: z.string().trim().max(250).optional(), relatedShiftId: uuid.optional(),
});
const responseSchema = z.object({ acknowledge: z.boolean(), note: z.string().trim().max(1000).optional() });
const resolveSchema = z.object({ note: z.string().trim().min(3).max(1500) });
const leaders = ['COMPANY_OWNER','COMPANY_ADMIN'];
const typeLabel = value => ({funds_issued:'Funds issued',cash_handover:'Cash handover',cash_remittance:'Cash remittance',staff_advance:'Staff advance',reimbursement:'Reimbursement',shortage_report:'Shortage report',overage_report:'Overage report',other:'Other'}[value] || value);
function fail(res,status,code,message){return res.status(status).json({error:{code,message}})}
function validDate(d){if(!/^\d{4}-\d{2}-\d{2}$/.test(d||''))return false;const x=new Date(`${d}T00:00:00Z`);return Number.isFinite(x.getTime())&&x.toISOString().slice(0,10)===d}
async function inbox(req,row,userId,state,title,message,severity='info'){
  try { await req.supabase.from('notification_inbox').upsert({user_id:userId,company_id:row.company_id,station_id:row.station_id,fingerprint:`accountability:${row.id}:${state}:${userId}`,title,message,severity,notification_type:'accountability_transaction',action_path:'/accountability'},{onConflict:'user_id,fingerprint',ignoreDuplicates:true}); } catch { /* the transaction and audit trail must not be rolled back by inbox delivery */ }
}
async function notifyCompanyLeaders(req,row,state,title,message,severity='warning'){
  try { const q=await req.supabase.from('company_members').select('user_id').eq('company_id',row.company_id).eq('status','active').in('role',leaders);
    if(!q.error) await Promise.all((q.data||[]).map(x=>inbox(req,row,x.user_id,state,title,message,severity)));
  } catch { /* notification delivery is best-effort; the durable transaction audit is authoritative */ }
}
async function companyRole(req,companyId,userId=req.user.id){const q=await req.supabase.from('company_members').select('role,status').eq('company_id',companyId).eq('user_id',userId).eq('status','active').in('role',leaders).maybeSingle();if(q.error)throw q.error;return q.data||null}
async function stationAccess(req,stationId){const s=await req.supabase.from('stations').select('id,name,company_id,status').eq('id',stationId).maybeSingle();if(s.error)throw s.error;if(!s.data)return null;const [leader,member]=await Promise.all([companyRole(req,s.data.company_id),req.supabase.from('station_members').select('role,status').eq('station_id',stationId).eq('user_id',req.user.id).eq('status','active').maybeSingle()]);if(member.error)throw member.error;return {station:s.data,leader,member:member.data||null}}
async function listRows(q){const all=[];for(let off=0;off<100000;off+=1000){const r=await q().order('transaction_date',{ascending:false}).order('created_at',{ascending:false}).range(off,Math.min(off+999,99999));if(r.error)throw r.error;all.push(...(r.data||[]));if(!r.data||r.data.length<1000)return {rows:all,truncated:false}}return {rows:all,truncated:true}}
export default function accountabilityRoutes(){const r=Router();
 r.get('/',async(req,res,next)=>{try{
   const leaderQ=await req.supabase.from('company_members').select('company_id,role').eq('user_id',req.user.id).eq('status','active').in('role',leaders).limit(1).maybeSingle();if(leaderQ.error)throw leaderQ.error;
   let stations=[];
   if(leaderQ.data){const q=await req.supabase.from('stations').select('id,name,company_id').eq('company_id',leaderQ.data.company_id).order('name');if(q.error)throw q.error;stations=q.data||[]}
   else {const q=await req.supabase.from('station_members').select('station_id,role,stations(id,name,company_id)').eq('user_id',req.user.id).eq('status','active').in('role',['STATION_MANAGER','ATTENDANT']);if(q.error)throw q.error;stations=(q.data||[]).map(x=>x.stations).filter(Boolean)}
   if(!stations.length)return res.json({data:{stations:[],staff:[],companyLeaders:[],transactions:[],truncated:false,permissions:{isLeader:!!leaderQ.data,isAttendant:false,canResolve:!!leaderQ.data}}});
   const ids=stations.map(s=>s.id);const [staffQ,txQ,leadersQ]=await Promise.all([
     req.supabase.from('station_members').select('station_id,user_id,role,status').in('station_id',ids).eq('status','active').in('role',['STATION_MANAGER','ATTENDANT']),
     listRows(()=>req.supabase.from('branch_accountability_transactions').select('*').in('station_id',ids)),
     req.supabase.from('company_members').select('company_id,user_id,role,status').eq('company_id',stations[0].company_id).eq('status','active').in('role',leaders)
   ]);if(staffQ.error)throw staffQ.error;if(leadersQ.error)throw leadersQ.error;
   let transactions=txQ.rows;
   const ownMemberships=await req.supabase.from('station_members').select('station_id,role').eq('user_id',req.user.id).eq('status','active').in('station_id',ids);if(ownMemberships.error)throw ownMemberships.error;
   const managerStationIds=new Set((ownMemberships.data||[]).filter(x=>x.role==='STATION_MANAGER').map(x=>x.station_id));
   const isAttendant=(ownMemberships.data||[]).some(x=>x.role==='ATTENDANT');
   if(!leaderQ.data)transactions=transactions.filter(x=>managerStationIds.has(x.station_id)||x.from_user_id===req.user.id||x.to_user_id===req.user.id);
   res.json({data:{stations,staff:staffQ.data||[],companyLeaders:leadersQ.data||[],transactions,truncated:txQ.truncated,permissions:{isLeader:!!leaderQ.data,isAttendant,canResolve:!!leaderQ.data}}});
 }catch(e){next(e)}});
 r.post('/',async(req,res,next)=>{try{
   const p=transactionSchema.safeParse(req.body);if(!p.success)return fail(res,400,'VALIDATION_ERROR','Provide the branch, recipient, positive amount, valid date, reference and detailed explanation.');if(!validDate(p.data.transactionDate))return fail(res,400,'INVALID_DATE','Transaction date is not a valid calendar date.');
   const a=await stationAccess(req,p.data.stationId);if(!a)return fail(res,404,'STATION_NOT_FOUND','Branch not found.');if(a.station.status!=='active')return fail(res,409,'BRANCH_INACTIVE','New handover records cannot be added to an inactive branch.');if(!a.leader&&!['STATION_MANAGER','ATTENDANT'].includes(a.member?.role))return fail(res,403,'FORBIDDEN','Only active company leaders and assigned branch staff can record a money handover.');
   if(a.member?.role==='ATTENDANT'&&['funds_issued','staff_advance'].includes(p.data.transactionType))return fail(res,403,'ROLE_RESTRICTED','Attendants cannot issue funds or staff advances through this ledger.');
   const [recipientMember,recipientLeader]=await Promise.all([
     req.supabase.from('station_members').select('user_id,role,status').eq('station_id',p.data.stationId).eq('user_id',p.data.toUserId).eq('status','active').maybeSingle(),
     companyRole(req,a.station.company_id,p.data.toUserId)
   ]);if(recipientMember.error)throw recipientMember.error;
   const recipientIsStaff=!!recipientMember.data, recipientIsLeader=!!recipientLeader;
   if(!recipientIsStaff&&!recipientIsLeader)return fail(res,400,'RECIPIENT_NOT_ASSIGNED','Recipient must be an active staff member of this branch or an active company owner/director.');
   if(p.data.toUserId===req.user.id)return fail(res,400,'SELF_TRANSFER_NOT_ALLOWED','The sender and recipient must be different people.');
   const senderRole=a.leader?'COMPANY_LEADER':a.member.role;const receiverRole=recipientIsLeader?'COMPANY_LEADER':recipientMember.data.role;
   const allowed=(senderRole==='COMPANY_LEADER'&&['STATION_MANAGER','ATTENDANT'].includes(receiverRole))||(senderRole==='STATION_MANAGER'&&['ATTENDANT','COMPANY_LEADER'].includes(receiverRole))||(senderRole==='ATTENDANT'&&['STATION_MANAGER','COMPANY_LEADER'].includes(receiverRole));
   if(!allowed)return fail(res,403,'INVALID_HANDOVER_DIRECTION','Supported handovers are company leader to branch staff, manager to attendant/company leader, and attendant to manager/company leader.');
   if(p.data.relatedShiftId){const sh=await req.supabase.from('station_cash_shifts').select('id,station_id').eq('id',p.data.relatedShiftId).eq('station_id',p.data.stationId).maybeSingle();if(sh.error)throw sh.error;if(!sh.data)return fail(res,400,'SHIFT_NOT_IN_BRANCH','The linked cashier shift does not belong to this branch.');}
   const direction=a.leader?'incoming':'outgoing';const currencyResult=await req.supabase.from('companies').select('currency').eq('id',a.station.company_id).single();if(currencyResult.error)throw currencyResult.error;const q=await req.supabase.from('branch_accountability_transactions').insert({company_id:a.station.company_id,currency:currencyResult.data.currency||'NGN',station_id:a.station.id,transaction_type:p.data.transactionType,direction,from_user_id:req.user.id,to_user_id:p.data.toUserId,amount:p.data.amount,transaction_date:p.data.transactionDate,reference:p.data.reference,description:p.data.description,evidence_reference:p.data.evidenceReference||null,related_shift_id:p.data.relatedShiftId||null,recorded_by:req.user.id}).select('*').single();if(q.error){if(q.error.code==='23505')return fail(res,409,'REFERENCE_ALREADY_USED','This transaction reference has already been used in the company. Enter a unique reference to prevent duplicate recording.');throw q.error;}
   await inbox(req,q.data,q.data.to_user_id,'submitted','Money handover awaiting your response',`${typeLabel(q.data.transaction_type)} · ₦${Number(q.data.amount).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2})} · Ref ${q.data.reference}`,'warning');
   res.status(201).json({data:q.data,message:'Transaction recorded. It remains pending until the named recipient acknowledges or disputes it.'});
 }catch(e){next(e)}});
 r.post('/:id/respond',async(req,res,next)=>{try{
   const id=uuid.safeParse(req.params.id),p=responseSchema.safeParse(req.body);if(!id.success||!p.success)return fail(res,400,'VALIDATION_ERROR','Provide a valid transaction and acknowledgement/dispute response.');const q=await req.supabase.from('branch_accountability_transactions').select('*').eq('id',id.data).eq('to_user_id',req.user.id).maybeSingle();if(q.error)throw q.error;if(!q.data)return fail(res,404,'TRANSACTION_NOT_FOUND','This transaction is not assigned to your account.');if(q.data.status!=='pending_acknowledgement')return fail(res,409,'ALREADY_RESPONDED','This transaction has already been acknowledged or disputed.');if(!p.data.acknowledge&&!p.data.note?.trim())return fail(res,400,'DISPUTE_NOTE_REQUIRED','Explain what amount, reference or detail is disputed.');const u=await req.supabase.from('branch_accountability_transactions').update({status:p.data.acknowledge?'acknowledged':'disputed',responded_by:req.user.id,responded_at:new Date().toISOString(),response_note:p.data.note||null}).eq('id',id.data).eq('status','pending_acknowledgement').select('*').maybeSingle();if(u.error)throw u.error;if(!u.data)return fail(res,409,'ALREADY_RESPONDED','This transaction changed before your response was saved.');if(p.data.acknowledge)await inbox(req,u.data,u.data.from_user_id,'acknowledged','Money handover acknowledged',`The recipient acknowledged reference ${u.data.reference}.`,'success');else{await inbox(req,u.data,u.data.from_user_id,'disputed','Money handover disputed',`The recipient disputed reference ${u.data.reference}. A company owner/director review is required.`,'critical');await notifyCompanyLeaders(req,u.data,`disputed:${u.data.id}`,'Money handover needs review',`A recipient disputed reference ${u.data.reference}. Review the details and record a resolution.`,'critical')}
   res.json({data:u.data,message:p.data.acknowledge?'Receipt acknowledged. The original transaction details are locked.':'Dispute recorded for independent company review.'});
 }catch(e){next(e)}});
 r.post('/:id/resolve',async(req,res,next)=>{try{
   const id=uuid.safeParse(req.params.id),p=resolveSchema.safeParse(req.body);if(!id.success||!p.success)return fail(res,400,'VALIDATION_ERROR','Provide a valid transaction and a resolution note.');const q=await req.supabase.from('branch_accountability_transactions').select('id,company_id,status').eq('id',id.data).maybeSingle();if(q.error)throw q.error;if(!q.data)return fail(res,404,'TRANSACTION_NOT_FOUND','Transaction not found.');if(!await companyRole(req,q.data.company_id))return fail(res,403,'FORBIDDEN','Only the company owner/director can resolve a dispute.');if(q.data.status!=='disputed')return fail(res,409,'NOT_DISPUTED','Only disputed transactions can be resolved.');const u=await req.supabase.from('branch_accountability_transactions').update({status:'resolved',resolved_by:req.user.id,resolved_at:new Date().toISOString(),resolution_note:p.data.note}).eq('id',id.data).eq('status','disputed').select('*').maybeSingle();if(u.error)throw u.error;if(!u.data)return fail(res,409,'ALREADY_RESOLVED','The dispute changed before resolution could be saved.');await Promise.all([inbox(req,u.data,u.data.from_user_id,'resolved','Money handover dispute resolved',`Dispute for reference ${u.data.reference} was resolved. See the ledger for the resolution note.`,'success'),inbox(req,u.data,u.data.to_user_id,'resolved','Money handover dispute resolved',`Dispute for reference ${u.data.reference} was resolved. See the ledger for the resolution note.`,'success')]);
   res.json({data:u.data,message:'Dispute resolution saved with an audit trail. The original amount and reference remain unchanged.'});
 }catch(e){next(e)}});
 return r;
}
