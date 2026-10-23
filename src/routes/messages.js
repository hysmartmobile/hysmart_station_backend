import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

const messageSchema = z.object({
  stationId: z.string().uuid().nullable().optional(),
  recipientUserIds: z.array(z.string().uuid()).min(1).max(200),
  title: z.string().trim().min(3).max(120),
  message: z.string().trim().min(1).max(3000),
  requiresAcknowledgement: z.boolean().optional().default(false),
});
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

export default function messageRoutes() {
  const r = Router();

  async function senderScope(req) {
    const [ownerQ, memberQ] = await Promise.all([
      req.supabase.from('company_members').select('company_id,role').eq('user_id', req.user.id).eq('status', 'active').in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']),
      req.supabase.from('station_members').select('station_id,role').eq('user_id', req.user.id).eq('status', 'active'),
    ]);
    if (ownerQ.error) throw ownerQ.error;
    if (memberQ.error) throw memberQ.error;
    if (ownerQ.data?.length) {
      const companyId = ownerQ.data[0].company_id;
      const stationsQ = await req.supabase.from('stations').select('id,name,company_id').eq('company_id', companyId).order('name');
      if (stationsQ.error) throw stationsQ.error;
      return { owner: true, companyId, stations: stationsQ.data || [] };
    }
    const managerMemberships = (memberQ.data || []).filter(m => m.role === 'STATION_MANAGER');
    if (!managerMemberships.length) return null;
    const stationsQ = await req.supabase.from('stations').select('id,name,company_id').in('id', managerMemberships.map(m => m.station_id)).order('name');
    if (stationsQ.error) throw stationsQ.error;
    const companyIds = [...new Set((stationsQ.data || []).map(s => s.company_id))];
    if (companyIds.length !== 1) return { error: true };
    return { owner: false, companyId: companyIds[0], stations: stationsQ.data || [] };
  }

  async function allowedRecipients(req, scope, stationId = null) {
    if (stationId && !scope.stations.some(s => s.id === stationId)) return { error: 'You cannot message staff outside your assigned branch.' };
    if (stationId) {
      const q = await req.supabase.from('station_members').select('user_id,role,station_id').eq('station_id', stationId).eq('status', 'active');
      if (q.error) throw q.error;
      return { rows: q.data || [] };
    }
    if (!scope.owner) return { error: 'Branch managers must select their assigned branch.' };
    const [companyQ, stationQ] = await Promise.all([
      req.supabase.from('company_members').select('user_id,role').eq('company_id', scope.companyId).eq('status', 'active'),
      scope.stations.length ? req.supabase.from('station_members').select('user_id,role,station_id').in('station_id', scope.stations.map(s => s.id)).eq('status', 'active') : Promise.resolve({ data: [], error: null }),
    ]);
    if (companyQ.error) throw companyQ.error;
    if (stationQ.error) throw stationQ.error;
    const rows = [...(companyQ.data || []).map(m => ({ ...m, station_id: null })), ...(stationQ.data || [])];
    return { rows: [...new Map(rows.map(row => [row.user_id, row])).values()] };
  }

  r.get('/recipients', async (req, res, next) => {
    try {
      const scope = await senderScope(req);
      if (!scope) return fail(res, 403, 'FORBIDDEN', 'Only a company owner, director, or assigned branch manager can send staff messages.');
      if (scope.error) return fail(res, 403, 'INVALID_SCOPE', 'Messaging must be scoped to one company.');
      const requestedStation = typeof req.query.stationId === 'string' ? req.query.stationId : null;
      const targetStation = requestedStation || (!scope.owner ? scope.stations[0]?.id || null : null);
      const result = await allowedRecipients(req, scope, targetStation);
      if (result.error) return fail(res, 403, 'FORBIDDEN', result.error);
      const stationById = new Map(scope.stations.map(s => [s.id, s.name]));
      res.json({ data: { canSend: true, owner: scope.owner, stations: scope.stations, recipients: result.rows.filter(row => row.user_id !== req.user.id).map(row => ({ userId: row.user_id, role: row.role, stationId: row.station_id || null, stationName: row.station_id ? stationById.get(row.station_id) || 'Assigned branch' : 'Company' })) } });
    } catch (e) { next(e); }
  });

  r.get('/sent', async (req, res, next) => {
    try {
      const scope = await senderScope(req);
      if (!scope) return fail(res, 403, 'FORBIDDEN', 'Only a company owner, director, or assigned branch manager can view sent-message receipts.');
      if (scope.error) return fail(res, 403, 'INVALID_SCOPE', 'Messaging must be scoped to one company.');
      let query = req.supabase.from('notification_inbox')
        .select('id,message_group_id,user_id,station_id,title,created_at,read_at,requires_acknowledgement,acknowledged_at')
        .eq('sender_user_id', req.user.id).eq('message_type', 'direct')
        .eq('company_id', scope.companyId).order('created_at', { ascending: false }).limit(1000);
      if (!scope.owner) {
        if (!scope.stations.length) return res.json({ data: { messages: [] } });
        query = query.in('station_id', scope.stations.map(s => s.id));
      }
      const q = await query;
      if (q.error) throw q.error;
      const stationNames = new Map(scope.stations.map(s => [s.id, s.name]));
      const grouped = new Map();
      for (const row of (q.data || [])) {
        const key = row.message_group_id || row.id;
        if (!grouped.has(key)) grouped.set(key, { id: key, title: row.title, stationId: row.station_id, stationName: row.station_id ? stationNames.get(row.station_id) || 'Assigned branch' : 'All company branches', sentAt: row.created_at, requiresAcknowledgement: Boolean(row.requires_acknowledgement), recipients: [] });
        grouped.get(key).recipients.push({ userId: row.user_id, readAt: row.read_at, acknowledgedAt: row.acknowledged_at, status: row.read_at ? 'read' : 'unread', acknowledgementStatus: row.acknowledged_at ? 'acknowledged' : 'pending' });
      }
      const messages = [...grouped.values()].map(m => ({ ...m, recipientCount: m.recipients.length, readCount: m.recipients.filter(r => r.readAt).length, unreadCount: m.recipients.filter(r => !r.readAt).length, acknowledgedCount: m.recipients.filter(r => r.acknowledgedAt).length, pendingAcknowledgementCount: m.recipients.filter(r => !r.acknowledgedAt).length }));
      res.json({ data: { messages } });
    } catch (e) { next(e); }
  });

  r.post('/', async (req, res, next) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Provide a title, message, and at least one valid recipient.');
    try {
      const scope = await senderScope(req);
      if (!scope) return fail(res, 403, 'FORBIDDEN', 'Only a company owner, director, or assigned branch manager can send staff messages.');
      if (scope.error) return fail(res, 403, 'INVALID_SCOPE', 'Messaging must be scoped to one company.');
      const stationId = parsed.data.stationId || null;
      const eligible = await allowedRecipients(req, scope, stationId);
      if (eligible.error) return fail(res, 403, 'FORBIDDEN', eligible.error);
      const uniqueIds = [...new Set(parsed.data.recipientUserIds)].filter(id => id !== req.user.id);
      const eligibleIds = new Set(eligible.rows.map(row => row.user_id));
      if (!uniqueIds.length || uniqueIds.some(id => !eligibleIds.has(id))) return fail(res, 403, 'RECIPIENT_OUT_OF_SCOPE', 'One or more recipients are outside your permitted messaging scope. Refresh recipients and try again.');
      const station = stationId ? scope.stations.find(s => s.id === stationId) : null;
      const fingerprintBase = `direct:${req.user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const messageGroupId = crypto.randomUUID();
      const rows = uniqueIds.map((userId, i) => ({
        user_id: userId, company_id: scope.companyId, station_id: stationId, message_group_id: messageGroupId,
        fingerprint: `${fingerprintBase}:${userId}`,
        title: parsed.data.title, message: `From ${req.user.user_metadata?.full_name || req.user.email || 'HySmart management'}: ${parsed.data.message}`,
        severity: 'info', notification_type: 'direct_message', action_path: '/alerts',
        sender_user_id: req.user.id, message_type: 'direct',
      }));
      const inserted = await req.supabase.from('notification_inbox').insert(rows).select('id,user_id,title,message,station_id');
      if (inserted.error) throw inserted.error;
      // Email is an opt-in supplement; the in-app message is delivered regardless of email preference.
      let emailJobsQueued = 0;
      try {
        const prefQ = await req.supabase.from('notification_user_preferences').select('user_id').in('user_id', uniqueIds).eq('direct_message_email_enabled', true);
        if (!prefQ.error && (prefQ.data || []).length) {
          const optedIn = new Set(prefQ.data.map(p => p.user_id));
          const emailJobs = [];
          for (const inboxItem of (inserted.data || [])) {
            if (!optedIn.has(inboxItem.user_id)) continue;
            const userResult = await req.supabase.auth.admin.getUserById(inboxItem.user_id);
            const email = userResult?.data?.user?.email;
            if (userResult?.error || !email) continue;
            const fingerprint = `direct-message:${inboxItem.id}:${email.toLowerCase()}`;
            emailJobs.push({ company_id: scope.companyId, station_id: stationId, channel: 'email', notification_type: 'direct_message', status: 'queued', recipient_masked: email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2'), metadata: { to: email, subject: `[HySmart] ${parsed.data.title}`, text: inboxItem.message, fingerprint, inbox_message_id: inboxItem.id } });
          }
          if (emailJobs.length) {
            const queued = await req.supabase.from('notification_delivery_log').insert(emailJobs);
            if (!queued.error) emailJobsQueued = emailJobs.length;
          }
        }
      } catch { /* Email is best-effort; never block the in-app message. */ }
      try {
        await req.supabase.from('audit_events').insert({ company_id: scope.companyId, station_id: stationId, actor_user_id: req.user.id, action: 'DIRECT_MESSAGE_SENT', entity_type: 'notification_message', entity_id: inserted.data?.[0]?.id || null, metadata: { recipient_count: rows.length, station_name: station?.name || 'All company branches', title: parsed.data.title } });
      } catch { /* Messaging should succeed even if the optional audit write is unavailable. */ }
      res.status(201).json({ data: { sent: rows.length, emailJobsQueued, requiresAcknowledgement: parsed.data.requiresAcknowledgement, message: 'Message delivered to recipients’ in-app notification centres.' } });
    } catch (e) { next(e); }
  });

  return r;
}
