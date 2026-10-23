import { Router } from 'express';
import { z } from 'zod';
import { isActiveCreatorAdmin } from '../services/creatorAccess.js';

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const uuid = z.string().uuid();
const createSchema = z.object({ subject: z.string().trim().min(4).max(160), category: z.enum(['account','billing','sales','inventory','staff','technical','feature_request','other']).default('technical'), priority: z.enum(['low','normal','high','urgent']).default('normal'), message: z.string().trim().min(10).max(5000) });
const replySchema = z.object({ message: z.string().trim().min(1).max(5000) });
const statusSchema = z.object({ status: z.enum(['open','in_progress','waiting_on_customer','resolved','closed']), assignedRepresentativeId: z.string().uuid().nullable().optional() });

export default function supportRoutes(config = {}) {
  const r = Router();
  async function scope(req) {
    const [companyQ, stationQ, repQ, creator] = await Promise.all([
      req.supabase.from('company_members').select('company_id,role').eq('user_id', req.user.id).eq('status','active'),
      req.supabase.from('station_members').select('station_id,role').eq('user_id', req.user.id).eq('status','active'),
      req.supabase.from('support_representatives').select('user_id,display_name').eq('user_id', req.user.id).eq('active',true).maybeSingle(),
      isActiveCreatorAdmin(req.supabase, req.user.id),
    ]);
    for (const q of [companyQ, stationQ, repQ]) if (q.error) throw q.error;
    const companyIds = [...new Set([...(companyQ.data||[]).map(x=>x.company_id), ...(stationQ.data||[]).map(x=>x.station_id)])];
    let stationCompanyIds = [];
    if ((stationQ.data||[]).length) {
      const sq = await req.supabase.from('stations').select('company_id').in('id', stationQ.data.map(x=>x.station_id));
      if (sq.error) throw sq.error;
      stationCompanyIds = (sq.data||[]).map(x=>x.company_id);
    }
    const companies = [...new Set([...companyIds.filter(id => (companyQ.data||[]).some(c=>c.company_id===id)), ...stationCompanyIds])];
    return { companyIds: companies, representative: repQ.data || null, creator };
  }
  async function audit(req, companyId, action, ticketId, metadata={}) {
    const q = await req.supabase.from('audit_events').insert({ company_id: companyId, actor_user_id: req.user.id, action, entity_type:'support_ticket', entity_id:String(ticketId), metadata });
    if (q.error && q.error.code !== '42P01') throw q.error;
  }
  async function notifyUsers(req, userIds, ticket, title, message) {
    const ids=[...new Set((userIds||[]).filter(id=>id && id!==req.user.id))];
    if(!ids.length) return;
    const now=Date.now();
    const rows=ids.map(user_id=>({user_id,company_id:ticket.company_id,fingerprint:`support:${ticket.id}:${now}:${user_id}`.slice(0,500),title,message,severity:'info',notification_type:'support_ticket',action_path:'/support'}));
    const saved=await req.supabase.from('notification_inbox').upsert(rows,{onConflict:'user_id,fingerprint',ignoreDuplicates:true});
    if(saved.error) req.log?.warn?.({err:saved.error,ticketId:ticket.id},'Support notification could not be queued');
  }
  async function notifyRepresentatives(req,ticket,title,message) {
    const reps=await req.supabase.from('support_representatives').select('user_id').eq('active',true);
    if(reps.error) { req.log?.warn?.({err:reps.error},'Could not load support representatives for notification'); return; }
    await notifyUsers(req,(reps.data||[]).map(x=>x.user_id),ticket,title,message);
  }
  r.get('/faqs', async (req,res,next) => {
    try {
      const q = await req.supabase.from('support_faqs').select('id,category,question,answer,keywords,updated_at').eq('published',true).order('sort_order').order('question').limit(200);
      if(q.error) throw q.error;
      const term = String(req.query.q||'').trim().toLowerCase().slice(0,120);
      const faqs=(q.data||[]).filter(f=>!term || `${f.question} ${f.answer} ${f.category} ${(f.keywords||[]).join(' ')}`.toLowerCase().includes(term));
      res.json({data:{faqs}});
    } catch(e){next(e);}
  });
  r.get('/tickets', async(req,res,next)=>{
    try {
      const s=await scope(req); let q=req.supabase.from('support_tickets').select('id,company_id,created_by,subject,category,priority,status,assigned_representative_id,created_at,updated_at,last_message_at,resolved_at,satisfaction_rating,satisfaction_comment').order('last_message_at',{ascending:false}).limit(200);
      if(!s.representative && !s.creator) { if(!s.companyIds.length) return res.json({data:{tickets:[],representative:false}}); q=q.in('company_id',s.companyIds).eq('created_by',req.user.id); }
      const result=await q; if(result.error) throw result.error;
      res.json({data:{tickets:result.data||[],representative:Boolean(s.representative||s.creator)}});
    }catch(e){next(e);}
  });
  r.post('/tickets', async(req,res,next)=>{
    const p=createSchema.safeParse(req.body); if(!p.success) return fail(res,400,'VALIDATION_ERROR','Enter a subject and a message of at least 10 characters.');
    try {
      const s=await scope(req); if(!s.companyIds.length) return fail(res,403,'COMPANY_REQUIRED','Join a company workspace before creating a support ticket.');
      const companyId=String(req.body.companyId||s.companyIds[0]); if(!s.companyIds.includes(companyId)) return fail(res,403,'COMPANY_SCOPE_DENIED','You cannot create a ticket for another company.');
      const ticket=await req.supabase.from('support_tickets').insert({company_id:companyId,created_by:req.user.id,subject:p.data.subject,category:p.data.category,priority:p.data.priority,status:'open',last_message_at:new Date().toISOString()}).select('*').single();
      if(ticket.error) throw ticket.error;
      const msg=await req.supabase.from('support_ticket_messages').insert({ticket_id:ticket.data.id,author_user_id:req.user.id,author_type:'customer',message:p.data.message}).select('id').single();
      if(msg.error) { await req.supabase.from('support_tickets').delete().eq('id',ticket.data.id).eq('created_by',req.user.id); throw msg.error; }
      await audit(req,companyId,'SUPPORT_TICKET_CREATED',ticket.data.id,{category:p.data.category,priority:p.data.priority});
      await notifyRepresentatives(req,ticket.data,`New support ticket: ${ticket.data.subject}`,`${ticket.data.priority.toUpperCase()} priority · ${ticket.data.category.replaceAll('_',' ')}`);
      res.status(201).json({data:{ticket:ticket.data}});
    }catch(e){next(e);}
  });
  r.get('/tickets/:id/messages', async(req,res,next)=>{
    if(!uuid.safeParse(req.params.id).success) return fail(res,400,'INVALID_TICKET_ID','Invalid ticket id.');
    try {
      const s=await scope(req); let tq=req.supabase.from('support_tickets').select('id,company_id,created_by,subject,category,priority,status,assigned_representative_id,created_at,updated_at,last_message_at,resolved_at,satisfaction_rating,satisfaction_comment').eq('id',req.params.id);
      if(!s.representative && !s.creator) { if(!s.companyIds.length) return fail(res,403,'FORBIDDEN','Ticket access denied.'); tq=tq.in('company_id',s.companyIds).eq('created_by',req.user.id); }
      const ticket=await tq.maybeSingle(); if(ticket.error) throw ticket.error; if(!ticket.data) return fail(res,404,'TICKET_NOT_FOUND','Ticket not found.');
      const m=await req.supabase.from('support_ticket_messages').select('id,author_user_id,author_type,message,created_at').eq('ticket_id',ticket.data.id).order('created_at'); if(m.error) throw m.error;
      res.json({data:{ticket:ticket.data,messages:m.data||[],representative:Boolean(s.representative||s.creator)}});
    }catch(e){next(e);}
  });
  r.post('/tickets/:id/messages', async(req,res,next)=>{
    if(!uuid.safeParse(req.params.id).success) return fail(res,400,'INVALID_TICKET_ID','Invalid ticket id.');
    const p=replySchema.safeParse(req.body); if(!p.success) return fail(res,400,'VALIDATION_ERROR','Enter a message.');
    try {
      const s=await scope(req); let tq=req.supabase.from('support_tickets').select('id,company_id,created_by,status,assigned_representative_id').eq('id',req.params.id);
      if(!s.representative && !s.creator) { if(!s.companyIds.length) return fail(res,403,'FORBIDDEN','Ticket access denied.'); tq=tq.in('company_id',s.companyIds).eq('created_by',req.user.id); }
      const found=await tq.maybeSingle(); if(found.error) throw found.error; if(!found.data) return fail(res,404,'TICKET_NOT_FOUND','Ticket not found.');
      if(['closed','resolved'].includes(found.data.status) && !s.representative && !s.creator) return fail(res,409,'TICKET_CLOSED','Reopen this ticket by creating a new ticket to continue the conversation.');
      const authorType=(s.representative||s.creator)?'representative':'customer';
      const saved=await req.supabase.from('support_ticket_messages').insert({ticket_id:found.data.id,author_user_id:req.user.id,author_type:authorType,message:p.data.message}).select('id,author_user_id,author_type,message,created_at').single(); if(saved.error) throw saved.error;
      const patch={last_message_at:saved.data.created_at,updated_at:saved.data.created_at};
      if(s.representative||s.creator){patch.status='in_progress';if(s.representative)patch.assigned_representative_id=req.user.id;} else if(found.data.status==='waiting_on_customer') patch.status='in_progress';
      const up=await req.supabase.from('support_tickets').update(patch).eq('id',found.data.id); if(up.error) throw up.error;
      await audit(req,found.data.company_id,(s.representative||s.creator)?'SUPPORT_TICKET_REPLIED':'SUPPORT_TICKET_CUSTOMER_REPLIED',found.data.id,{authorType});
      if(s.representative||s.creator) await notifyUsers(req,[found.data.created_by],{...found.data,company_id:found.data.company_id},`Support replied: ${found.data.subject}`,'A service representative has replied to your support ticket.');
      else if(found.data.assigned_representative_id) await notifyUsers(req,[found.data.assigned_representative_id],{...found.data,company_id:found.data.company_id},`Customer replied: ${found.data.subject}`,'A customer has replied to an assigned support ticket.');
      else await notifyRepresentatives(req,{...found.data,company_id:found.data.company_id},`Customer replied: ${found.data.subject}`,'A customer has added a message to a support ticket.');
      res.status(201).json({data:{message:saved.data}});
    }catch(e){next(e);}
  });
  r.patch('/tickets/:id/status', async(req,res,next)=>{
    if(!uuid.safeParse(req.params.id).success) return fail(res,400,'INVALID_TICKET_ID','Invalid ticket id.');
    const p=statusSchema.safeParse(req.body); if(!p.success) return fail(res,400,'VALIDATION_ERROR','Choose a valid ticket status.');
    try {
      const s=await scope(req); if(!s.representative && !s.creator) return fail(res,403,'REPRESENTATIVE_REQUIRED','Only an enabled HySmart service representative can update ticket status.');
      const patch={status:p.data.status,updated_at:new Date().toISOString()};
      if(p.data.assignedRepresentativeId!==undefined) patch.assigned_representative_id=p.data.assignedRepresentativeId;
      if(p.data.status==='resolved'||p.data.status==='closed') patch.resolved_at=new Date().toISOString(); else patch.resolved_at=null;
      const saved=await req.supabase.from('support_tickets').update(patch).eq('id',req.params.id).select('id,company_id,status,assigned_representative_id,resolved_at').maybeSingle(); if(saved.error) throw saved.error; if(!saved.data) return fail(res,404,'TICKET_NOT_FOUND','Ticket not found.');
      await audit(req,saved.data.company_id,'SUPPORT_TICKET_STATUS_CHANGED',saved.data.id,{status:saved.data.status});
      const customer=await req.supabase.from('support_tickets').select('created_by,subject').eq('id',saved.data.id).maybeSingle();
      if(!customer.error && customer.data) await notifyUsers(req,[customer.data.created_by],{...saved.data,company_id:saved.data.company_id},`Support ticket ${saved.data.status.replaceAll('_',' ')}: ${customer.data.subject}`,`Your ticket status is now ${saved.data.status.replaceAll('_',' ')}.`);
      res.json({data:{ticket:saved.data}});
    }catch(e){next(e);}
  });
  r.post('/tickets/:id/satisfaction', async(req,res,next)=>{
    if(!uuid.safeParse(req.params.id).success) return fail(res,400,'INVALID_TICKET_ID','Invalid ticket id.');
    const p=z.object({rating:z.number().int().min(1).max(5),comment:z.string().trim().max(1000).optional().default('')}).safeParse(req.body);
    if(!p.success) return fail(res,400,'VALIDATION_ERROR','Choose a rating from 1 to 5.');
    try { const s=await scope(req); const q=await req.supabase.from('support_tickets').select('id,company_id,created_by,status').eq('id',req.params.id).maybeSingle(); if(q.error)throw q.error; if(!q.data)return fail(res,404,'TICKET_NOT_FOUND','Ticket not found.'); if(q.data.created_by!==req.user.id || s.creator || s.representative)return fail(res,403,'FORBIDDEN','Only the customer who opened this ticket can rate support.'); if(!['resolved','closed'].includes(q.data.status))return fail(res,409,'TICKET_NOT_RESOLVED','Rate the support experience after the ticket is resolved.'); const saved=await req.supabase.from('support_tickets').update({satisfaction_rating:p.data.rating,satisfaction_comment:p.data.comment||null}).eq('id',q.data.id).select('id,satisfaction_rating,satisfaction_comment').single(); if(saved.error)throw saved.error; await audit(req,q.data.company_id,'SUPPORT_SATISFACTION_SUBMITTED',q.data.id,{rating:p.data.rating}); res.json({data:{ticket:saved.data}}); } catch(e){next(e);}
  });
  return r;
}
