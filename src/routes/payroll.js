import { Router } from 'express';
import { z } from 'zod';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const submitSchema = z.object({ stationId:z.string().uuid(), employeeUserId:z.string().uuid(), periodStart:z.string().regex(datePattern), periodEnd:z.string().regex(datePattern), basicSalary:z.coerce.number().min(0).max(100000000000), allowances:z.coerce.number().min(0).max(100000000000).default(0), deductions:z.coerce.number().min(0).max(100000000000).default(0), reference:z.string().trim().min(3).max(120), notes:z.string().trim().max(1000).optional() });
const reviewSchema=z.object({approve:z.boolean(),note:z.string().trim().max(500).optional()});
const paySchema=z.object({paymentMethod:z.enum(['cash','bank_transfer','pos','other']),paymentReference:z.string().trim().min(3).max(120)});
function fail(res,status,code,message){return res.status(status).json({error:{code,message}})}
function validDate(d){if(!datePattern.test(d||''))return false;const x=new Date(`${d}T00:00:00Z`);return Number.isFinite(x.getTime())&&x.toISOString().slice(0,10)===d}
async function fetchAll(makeQuery, orderColumn, tieBreakers=['id'], cap=100000){const rows=[];for(let offset=0;offset<cap;offset+=1000){let q=makeQuery().order(orderColumn,{ascending:false});for(const col of tieBreakers)q=q.order(col,{ascending:false});q=q.range(offset,Math.min(offset+999,cap-1));const result=await q;if(result.error)throw result.error;rows.push(...(result.data||[]));if(!result.data||result.data.length<1000)return {rows,truncated:false};}return {rows,truncated:true};}
async function membership(req,stationId){
 const s=await req.supabase.from('stations').select('id,name,company_id,status').eq('id',stationId).maybeSingle();if(s.error)throw s.error;if(!s.data)return {missing:true};
 const [c,m]=await Promise.all([req.supabase.from('company_members').select('role,status').eq('company_id',s.data.company_id).eq('user_id',req.user.id).eq('status','active').in('role',['COMPANY_OWNER','COMPANY_ADMIN']).maybeSingle(),req.supabase.from('station_members').select('role,status').eq('station_id',stationId).eq('user_id',req.user.id).eq('status','active').maybeSingle()]);if(c.error)throw c.error;if(m.error)throw m.error;
 return {station:s.data,leader:!!c.data,companyRole:c.data?.role||null,member:m.data?.role||null};
}
async function companyLeader(req){const q=await req.supabase.from('company_members').select('company_id,role').eq('user_id',req.user.id).eq('status','active').in('role',['COMPANY_OWNER','COMPANY_ADMIN']).limit(1).maybeSingle();if(q.error)throw q.error;return q.data}
export default function payrollRoutes(){const r=Router();
 r.get('/',async(req,res,next)=>{try{
   const leader=await companyLeader(req);let stationsQ;
   if(leader)stationsQ=await req.supabase.from('stations').select('id,name,company_id').eq('company_id',leader.company_id).order('name');
   else stationsQ=await req.supabase.from('station_members').select('station_id,role,stations(id,name,company_id)').eq('user_id',req.user.id).eq('status','active').eq('role','STATION_MANAGER');
   if(stationsQ.error)throw stationsQ.error;
   const stations=leader?(stationsQ.data||[]):(stationsQ.data||[]).map(x=>x.stations).filter(Boolean);
   if(!stations.length)return res.json({data:{stations:[],staff:[],payroll:[],expenses:[],truncated:false,permissions:{isLeader:!!leader,canSubmit:false,canReview:!!leader,canMarkPaid:!!leader}}});
   const ids=stations.map(x=>x.id);
   const [staffQ,payQ,expenseQ]=await Promise.all([
     fetchAll(()=>req.supabase.from('station_members').select('station_id,user_id,role,status').in('station_id',ids).eq('status','active').in('role',['STATION_MANAGER','ATTENDANT']),'role',['user_id','station_id']),
     fetchAll(()=>req.supabase.from('branch_payroll').select('*').in('station_id',ids),'period_start'),
     fetchAll(()=>req.supabase.from('operating_expenses').select('*').in('station_id',ids),'incurred_on')
   ]);
   res.json({data:{stations,staff:staffQ.rows,payroll:payQ.rows,expenses:expenseQ.rows,truncated:staffQ.truncated||payQ.truncated||expenseQ.truncated,permissions:{isLeader:!!leader,canSubmit:true,canReview:!!leader,canMarkPaid:!!leader}}});
 }catch(e){next(e)}});
 r.post('/',async(req,res,next)=>{try{
   const p=submitSchema.safeParse(req.body);if(!p.success)return fail(res,400,'VALIDATION_ERROR','Enter a branch, employee, valid pay period, non-negative salary amounts and supporting payroll reference.');
   if(!validDate(p.data.periodStart)||!validDate(p.data.periodEnd)||p.data.periodEnd<p.data.periodStart)return fail(res,400,'INVALID_PAY_PERIOD','Pay period dates must be valid and end on or after the start date.');
   if((new Date(`${p.data.periodEnd}T00:00:00Z`)-new Date(`${p.data.periodStart}T00:00:00Z`))/86400000>366)return fail(res,400,'INVALID_PAY_PERIOD','Pay period cannot exceed 367 days.');
   if(p.data.basicSalary+p.data.allowances<p.data.deductions)return fail(res,400,'INVALID_NET_PAY','Deductions cannot exceed basic salary plus allowances.');
   const a=await membership(req,p.data.stationId);if(a.missing)return fail(res,404,'NOT_FOUND','Branch not found.');if(!a.leader&&a.member!=='STATION_MANAGER')return fail(res,403,'FORBIDDEN','Only a company owner/director or the assigned branch manager can submit payroll.');
   const emp=await req.supabase.from('station_members').select('user_id,role,status').eq('station_id',p.data.stationId).eq('user_id',p.data.employeeUserId).eq('status','active').maybeSingle();if(emp.error)throw emp.error;
   if(!emp.data||!['STATION_MANAGER','ATTENDANT'].includes(emp.data.role))return fail(res,400,'EMPLOYEE_NOT_ASSIGNED','Payroll can only be recorded for an active manager or attendant assigned to this branch.');
   if(!a.leader&&emp.data.role==='STATION_MANAGER'&&emp.data.user_id!==req.user.id)return fail(res,403,'MANAGER_SCOPE','A branch manager can record their own salary and attendants in their branch, not another manager’s salary.');
   const currencyResult=await req.supabase.from('companies').select('currency').eq('id',a.station.company_id).single();if(currencyResult.error)throw currencyResult.error;const q=await req.supabase.from('branch_payroll').insert({company_id:a.station.company_id,currency:currencyResult.data.currency||'NGN',station_id:p.data.stationId,employee_user_id:emp.data.user_id,employee_role:emp.data.role,period_start:p.data.periodStart,period_end:p.data.periodEnd,basic_salary:p.data.basicSalary,allowances:p.data.allowances,deductions:p.data.deductions,reference:p.data.reference,notes:p.data.notes||null,submitted_by:req.user.id}).select('*').single();
   if(q.error){if(q.error.code==='23505')return fail(res,409,'PAYROLL_PERIOD_EXISTS','Payroll has already been submitted for this employee and pay period.');throw q.error;}res.status(201).json({data:q.data,message:'Payroll submitted for independent company approval. It is not counted as an expense until approved.'});
 }catch(e){next(e)}});
 r.post('/:id/review',async(req,res,next)=>{try{
   const p=reviewSchema.safeParse(req.body);if(!p.success)return fail(res,400,'VALIDATION_ERROR','Choose approve or reject and provide an optional review note.');const leader=await companyLeader(req);if(!leader)return fail(res,403,'FORBIDDEN','Only a company owner or director can approve payroll.');
   const existing=await req.supabase.from('branch_payroll').select('*').eq('id',req.params.id).eq('company_id',leader.company_id).maybeSingle();if(existing.error)throw existing.error;if(!existing.data)return fail(res,404,'NOT_FOUND','Payroll record not found in this company.');if(existing.data.status!=='pending')return fail(res,409,'ALREADY_REVIEWED','This payroll record has already been reviewed.');if(existing.data.submitted_by===req.user.id)return fail(res,409,'SELF_APPROVAL_NOT_ALLOWED','The person who submitted payroll cannot approve their own submission.');
   const q=await req.supabase.from('branch_payroll').update({status:p.data.approve?'approved':'rejected',reviewed_by:req.user.id,reviewed_at:new Date().toISOString(),review_note:p.data.note||null}).eq('id',req.params.id).eq('company_id',leader.company_id).eq('status','pending').select('*').maybeSingle();if(q.error)throw q.error;if(!q.data)return fail(res,409,'ALREADY_REVIEWED','Payroll status changed before this review could be saved.');res.json({data:q.data,message:p.data.approve?'Payroll approved and included in branch expenses.':'Payroll rejected and excluded from branch expenses.'});
 }catch(e){next(e)}});
 r.post('/:id/pay',async(req,res,next)=>{try{
   const p=paySchema.safeParse(req.body);if(!p.success)return fail(res,400,'VALIDATION_ERROR','Provide a payment method and a valid bank, receipt or transaction reference.');const leader=await companyLeader(req);if(!leader)return fail(res,403,'FORBIDDEN','Only a company owner or director can mark payroll paid.');
   const existing=await req.supabase.from('branch_payroll').select('id,status,payment_status,submitted_by,company_id').eq('id',req.params.id).eq('company_id',leader.company_id).maybeSingle();if(existing.error)throw existing.error;if(!existing.data)return fail(res,404,'NOT_FOUND','Payroll record not found in this company.');if(existing.data.status!=='approved')return fail(res,409,'PAYROLL_NOT_APPROVED','Only approved payroll can be paid.');if(existing.data.payment_status==='paid')return fail(res,409,'ALREADY_PAID','This payroll has already been marked paid.');if(existing.data.submitted_by===req.user.id)return fail(res,409,'PAYROLL_SUBMITTER_PAYMENT_REVIEW','For separation of duties, the person who submitted payroll cannot record its payment.');
   const q=await req.supabase.from('branch_payroll').update({payment_status:'paid',paid_by:req.user.id,paid_at:new Date().toISOString(),payment_method:p.data.paymentMethod,payment_reference:p.data.paymentReference}).eq('id',req.params.id).eq('company_id',leader.company_id).eq('status','approved').eq('payment_status','unpaid').select('*').maybeSingle();if(q.error)throw q.error;if(!q.data)return fail(res,409,'ALREADY_PAID','Payroll was paid or changed before this action completed.');res.json({data:q.data,message:'Payment evidence recorded. Keep the referenced bank advice or receipt with company records.'});
 }catch(e){next(e)}});
 return r;
}
