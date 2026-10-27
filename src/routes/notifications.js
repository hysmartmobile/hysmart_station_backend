import { Router } from 'express';
import { buildAlerts } from './alerts.js';

function fail(res, status, code, message) { return res.status(status).json({ error: { code, message } }); }

export default function notificationRoutes() {
  const r = Router();

  async function visibleScope(req) {
    const [ownerQ, memberQ] = await Promise.all([
      req.supabase.from('company_members').select('company_id,role,status').eq('user_id', req.user.id).eq('status', 'active').in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']),
      req.supabase.from('station_members').select('station_id,role,status').eq('user_id', req.user.id).eq('status', 'active'),
    ]);
    if (ownerQ.error) throw ownerQ.error;
    if (memberQ.error) throw memberQ.error;
    const owner = ownerQ.data?.[0] || null;
    if (owner) {
      const q = await req.supabase.from('stations').select('id,name,company_id').eq('company_id', owner.company_id).order('name');
      if (q.error) throw q.error;
      return { companyId: owner.company_id, owner: true, stations: q.data || [] };
    }
    const managers = (memberQ.data || []).filter(m => m.role === 'STATION_MANAGER');
    const ids = managers.map(m => m.station_id);
    if (!ids.length) return { companyId: null, owner: false, stations: [], memberQ: memberQ.data || [] };
    const q = await req.supabase.from('stations').select('id,name,company_id').in('id', ids).order('name');
    if (q.error) throw q.error;
    const companyIds = [...new Set((q.data || []).map(s => s.company_id))];
    if (companyIds.length > 1) return { error: { status: 403, code: 'MULTI_COMPANY_SCOPE', message: 'Notification access must be scoped to one company at a time.' } };
    return { companyId: companyIds[0] || null, owner: false, stations: q.data || [], memberQ: memberQ.data || [] };
  }

  // Delivery operations are scoped to the company owner's company or the manager's assigned branches.
  r.get('/delivery-status', async (req, res, next) => {
    try {
      const scope = await visibleScope(req);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      if (!scope.companyId || (!scope.owner && !scope.stations.length)) return fail(res, 403, 'DELIVERY_SCOPE_REQUIRED', 'Only company owners and assigned station managers can view delivery operations.');
      const stationIds = scope.stations.map(station => station.id);
      let jobsQ = req.supabase.from('notification_delivery_log')
        .select('id,station_id,channel,notification_type,status,recipient_masked,error_code,created_at,attempted_at,sent_at,provider_message_id,metadata')
        .eq('company_id', scope.companyId).eq('channel', 'email')
        .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
        .order('created_at', { ascending: false }).limit(200);
      if (!scope.owner) jobsQ = stationIds.length ? jobsQ.in('station_id', stationIds) : jobsQ.eq('station_id', '00000000-0000-0000-0000-000000000000');
      const [jobsResult, heartbeatResult] = await Promise.all([
        jobsQ,
        req.supabase.from('notification_worker_heartbeat').select('worker_name,status,started_at,completed_at,updated_at,summary,error_message').eq('worker_name', 'notification-delivery').maybeSingle(),
      ]);
      if (jobsResult.error) throw jobsResult.error;
      if (heartbeatResult.error) throw heartbeatResult.error;
      const jobs = jobsResult.data || [];
      const heartbeat = heartbeatResult.data || null;
      const reference = heartbeat?.completed_at || heartbeat?.started_at || heartbeat?.updated_at;
      const ageMs = reference ? Date.now() - new Date(reference).getTime() : null;
      const staleAfterMinutes = Number(process.env.NOTIFICATION_WORKER_STALE_MINUTES || 30);
      res.json({ data: {
        counts: { queued: jobs.filter(j => j.status === 'queued').length, sent: jobs.filter(j => j.status === 'sent').length, failed: jobs.filter(j => j.status === 'failed').length, skipped: jobs.filter(j => j.status === 'skipped').length },
        worker: { status: heartbeat?.status || 'unknown', lastStartedAt: heartbeat?.started_at || null, lastCompletedAt: heartbeat?.completed_at || null, lastUpdatedAt: heartbeat?.updated_at || null, stale: ageMs === null || ageMs > staleAfterMinutes * 60000, staleAfterMinutes, summary: heartbeat?.summary || null, error: heartbeat?.error_message || null },
        jobs: jobs.map(({ metadata, ...job }) => ({ ...job, retryable: job.status === 'failed' && ['EMAIL_PROVIDER_NOT_CONFIGURED', 'RESEND_HTTP_400', 'RESEND_HTTP_401', 'RESEND_HTTP_403', 'RESEND_HTTP_404', 'RESEND_HTTP_409', 'RESEND_HTTP_422', 'RESEND_HTTP_429'].includes(job.error_code), retryCount: Number(metadata?.retry_count || 0), lastError: metadata?.last_error || null }))
      } });
    } catch (e) { next(e); }
  });

  r.post('/delivery/:id/retry', async (req, res, next) => {
    try {
      const scope = await visibleScope(req);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      if (!scope.companyId || (!scope.owner && !scope.stations.length)) return fail(res, 403, 'DELIVERY_SCOPE_REQUIRED', 'Only company owners and assigned station managers can retry delivery jobs.');
      const eligibleCodes = ['EMAIL_PROVIDER_NOT_CONFIGURED', 'RESEND_HTTP_400', 'RESEND_HTTP_401', 'RESEND_HTTP_403', 'RESEND_HTTP_404', 'RESEND_HTTP_409', 'RESEND_HTTP_422', 'RESEND_HTTP_429'];
      let lookup = req.supabase.from('notification_delivery_log').select('id,company_id,station_id,status,error_code,metadata').eq('id', req.params.id).eq('company_id', scope.companyId).eq('channel', 'email');
      if (!scope.owner) {
        const ids = scope.stations.map(station => station.id);
        if (!ids.length) return fail(res, 403, 'DELIVERY_SCOPE_REQUIRED', 'No assigned branch is available for delivery retry.');
        lookup = lookup.in('station_id', ids);
      }
      const found = await lookup.maybeSingle();
      if (found.error) throw found.error;
      if (!found.data) return fail(res, 404, 'NOT_FOUND', 'Delivery job not found in your permitted scope.');
      if (found.data.status !== 'failed') return fail(res, 409, 'JOB_NOT_FAILED', 'Only failed jobs can be retried; queued or sent jobs cannot be resent here.');
      if (!eligibleCodes.includes(found.data.error_code)) return fail(res, 409, 'RETRY_UNSAFE', 'This failure may have an uncertain delivery outcome or needs manual correction. It cannot be retried automatically.');
      const metadata = { ...(found.data.metadata || {}), retry_count: Number(found.data.metadata?.retry_count || 0) + 1, retry_requested_at: new Date().toISOString(), retry_requested_by: req.user.id };
      const updated = await req.supabase.from('notification_delivery_log').update({ status: 'queued', error_code: null, attempted_at: null, metadata }).eq('id', found.data.id).eq('status', 'failed').select('id,status').maybeSingle();
      if (updated.error) throw updated.error;
      if (!updated.data) return fail(res, 409, 'JOB_STATE_CHANGED', 'The job changed while retry was requested. Refresh delivery status.');
      res.json({ data: { queued: true, id: updated.data.id, status: updated.data.status, note: 'Retry queued. Actual delivery depends on the worker and email provider; queued does not mean delivered.' } });
    } catch (e) { next(e); }
  });

  r.get('/inbox', async (req, res, next) => {
    try {
      const q = await req.supabase.from('notification_inbox').select('id,station_id,title,message,severity,notification_type,created_at,read_at,action_path,message_type,requires_acknowledgement,acknowledged_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
      if (q.error) throw q.error;
      const items = q.data || [];
      res.json({ data: { notifications: items, unreadCount: items.filter(n => !n.read_at).length } });
    } catch (e) { next(e); }
  });

  r.patch('/inbox/:id/read', async (req, res, next) => {
    try {
      const q = await req.supabase.from('notification_inbox').update({ read_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id).is('read_at', null).select('id').maybeSingle();
      if (q.error) throw q.error;
      if (!q.data) return fail(res, 404, 'NOT_FOUND', 'Notification not found or already read.');
      res.json({ data: { markedRead: true, id: q.data.id } });
    } catch (e) { next(e); }
  });

  r.post('/inbox/:id/acknowledge', async (req, res, next) => {
    try {
      const q = await req.supabase.from('notification_inbox')
        .update({ acknowledged_at: new Date().toISOString() })
        .eq('id', req.params.id).eq('user_id', req.user.id)
        .eq('message_type', 'direct').eq('requires_acknowledgement', true)
        .is('acknowledged_at', null).select('id,acknowledged_at').maybeSingle();
      if (q.error) throw q.error;
      if (!q.data) {
        const existing = await req.supabase.from('notification_inbox')
          .select('id,acknowledged_at,requires_acknowledgement').eq('id', req.params.id)
          .eq('user_id', req.user.id).maybeSingle();
        if (existing.error) throw existing.error;
        if (!existing.data) return fail(res, 404, 'NOT_FOUND', 'Message not found.');
        if (!existing.data.requires_acknowledgement) return fail(res, 409, 'ACK_NOT_REQUIRED', 'This message does not require acknowledgement.');
        return res.json({ data: { acknowledged: true, id: existing.data.id, acknowledgedAt: existing.data.acknowledged_at } });
      }
      res.json({ data: { acknowledged: true, id: q.data.id, acknowledgedAt: q.data.acknowledged_at } });
    } catch (e) { next(e); }
  });

  r.get('/direct-message-email-preference', async (req, res, next) => {
    try {
      const q = await req.supabase.from('notification_user_preferences').select('direct_message_email_enabled').eq('user_id', req.user.id).maybeSingle();
      if (q.error) throw q.error;
      res.json({ data: { enabled: Boolean(q.data?.direct_message_email_enabled) } });
    } catch (e) { next(e); }
  });

  r.put('/direct-message-email-preference', async (req, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') return fail(res, 400, 'VALIDATION_ERROR', 'Provide enabled as true or false.');
      const q = await req.supabase.from('notification_user_preferences').upsert({ user_id: req.user.id, direct_message_email_enabled: req.body.enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select('direct_message_email_enabled').single();
      if (q.error) throw q.error;
      res.json({ data: { enabled: Boolean(q.data.direct_message_email_enabled) } });
    } catch (e) { next(e); }
  });

  r.post('/sync-management-alerts', async (req, res, next) => {
    try {
      const scope = await visibleScope(req);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      if (!scope.owner && !scope.stations.length) return res.json({ data: { synced: 0, note: 'No management alert scope is assigned to this account. Personal and operational messages can still appear in your inbox.' } });
      const alerts = await buildAlerts(req, scope.stations);
      const inAppPrefs = await req.supabase.from('notification_delivery_preferences').select('station_id,enabled').eq('company_id', scope.companyId).eq('channel', 'in_app');
      if (inAppPrefs.error) throw inAppPrefs.error;
      const inAppByStation = new Map((inAppPrefs.data || []).map(p => [p.station_id || 'company', p.enabled]));
      const inboxRows = alerts.filter(a => inAppByStation.has(a.stationId) ? inAppByStation.get(a.stationId) : (inAppByStation.has('company') ? inAppByStation.get('company') : true)).map(a => ({
        user_id: req.user.id, company_id: scope.companyId, station_id: a.stationId,
        fingerprint: `${a.type}:${a.stationId}:${a.title}:${a.detail}`.slice(0, 500),
        title: a.title, message: `${a.branch}: ${a.detail}`, severity: a.severity,
        notification_type: a.type, action_path: ({ overdue_attendance: '/attendance', open_cash_shift: '/sales', cash_variance: '/sales', litre_stock_variance: '/controls', kg_stock_variance: '/sales', pending_litre_adjustment: '/controls', pending_kg_adjustment: '/controls', collection_gap: '/sales' })[a.type] || '/alerts',
      }));
      if (inboxRows.length) {
        const saved = await req.supabase.from('notification_inbox').upsert(inboxRows, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true }).select('id');
        if (saved.error) throw saved.error;
      }

      // Queue critical-alert emails only when explicitly enabled. The worker sends them via Resend.
      const critical = alerts.filter(a => a.severity === 'critical');
      const prefQ = await req.supabase.from('notification_delivery_preferences').select('station_id,recipient,enabled,critical_alerts').eq('company_id', scope.companyId).eq('channel', 'email').eq('enabled', true).eq('critical_alerts', true);
      if (prefQ.error) throw prefQ.error;
      const recentQ = await req.supabase.from('notification_delivery_log').select('metadata').eq('company_id', scope.companyId).eq('channel', 'email').gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).limit(1000);
      if (recentQ.error) throw recentQ.error;
      const knownFingerprints = new Set((recentQ.data || []).map(row => row.metadata?.fingerprint).filter(Boolean));
      const queued = [];
      for (const alert of critical) {
        const recipients = (prefQ.data || []).filter(p => p.station_id === alert.stationId || !p.station_id);
        for (const pref of recipients) {
          const fingerprint = `${alert.type}:${alert.stationId}:${alert.title}:${alert.detail}:${pref.recipient.toLowerCase()}`;
          if (!pref.recipient || knownFingerprints.has(fingerprint)) continue;
          knownFingerprints.add(fingerprint);
          queued.push({ company_id: scope.companyId, station_id: alert.stationId, channel: 'email', notification_type: alert.type, status: 'queued', recipient_masked: pref.recipient.replace(/^(.{1,2}).*(@.*)$/, '$1***$2'), metadata: { to: pref.recipient, subject: `[HySmart ${alert.severity.toUpperCase()}] ${alert.title}`, text: `${alert.branch}: ${alert.detail}`, fingerprint } });
        }
      }
      if (queued.length) {
        const q = await req.supabase.from('notification_delivery_log').insert(queued);
        if (q.error) throw q.error;
      }
      res.json({ data: { synced: inboxRows.length, criticalEmailJobsQueued: queued.length, note: 'Messages are saved to the in-app notification centre. Queued emails require the configured Resend worker and scheduler.' } });
    } catch (e) { next(e); }
  });

  return r;
}
