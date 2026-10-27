import { Router } from 'express';
import { z } from 'zod';

const HOUR = 60 * 60 * 1000;
const dayAgo = () => new Date(Date.now() - 24 * HOUR).toISOString();
const preferenceSchema = z.object({ stationId: z.string().uuid().nullable().optional(), openShiftHours: z.number().int().min(1).max(72), litreStockVariance: z.number().positive().max(100000), kgStockVariance: z.number().positive().max(100000), cashVarianceNgn: z.number().positive().max(100000000), collectionGapNgn: z.number().positive().max(1000000000), dailySummaryEnabled: z.boolean().default(true) });
const DEFAULT_THRESHOLDS = { openShiftHours: 12, litreStockVariance: 10, kgStockVariance: 5, cashVarianceNgn: 1000, collectionGapNgn: 10000, dailySummaryEnabled: true };
const sum = (rows, key) => (rows || []).reduce((n, row) => n + Number(row[key] || 0), 0);
function fail(res, status, code, message) { return res.status(status).json({ error: { code, message } }); }
async function ownerMembership(req) {
  const q = await req.supabase.from('company_members').select('company_id,role').eq('user_id', req.user.id).eq('status', 'active').in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']).limit(1).maybeSingle();
  if (q.error) throw q.error;
  return q.data;
}
export async function buildAlerts(req, stations, thresholds = DEFAULT_THRESHOLDS) {
  const ids = stations.map(s => s.id);
  if (!ids.length) return [];
  const [attendance, cashShifts, litreChecks, kgChecks, litreAdjustments, kgAdjustments, cashCollections, kgCollections, litreReversals, kgReversals, litreSales, kgSales] = await Promise.all([
    req.supabase.from('attendance_records').select('id,station_id,user_id,clock_in_at').in('station_id', ids).is('clock_out_at', null).order('clock_in_at', { ascending: true }).limit(500),
    req.supabase.from('station_cash_shifts').select('id,station_id,cashier_user_id,opened_at,status,variance').in('station_id', ids).order('opened_at', { ascending: true }).limit(500),
    req.supabase.from('tank_stock_checks').select('id,station_id,tank_id,measured_at,variance_litres').in('station_id', ids).gte('measured_at', dayAgo()).order('measured_at', { ascending: false }).limit(500),
    req.supabase.from('kg_tank_stock_checks').select('id,station_id,tank_id,measured_at,variance_kg').in('station_id', ids).gte('measured_at', dayAgo()).order('measured_at', { ascending: false }).limit(500),
    req.supabase.from('stock_adjustment_requests').select('id,station_id,tank_id,requested_at,status').in('station_id', ids).eq('status', 'pending').order('requested_at', { ascending: true }).limit(500),
    req.supabase.from('kg_stock_adjustment_requests').select('id,station_id,tank_id,requested_at,status').in('station_id', ids).eq('status', 'pending').order('requested_at', { ascending: true }).limit(500),
    req.supabase.from('sales_collections').select('id,station_id,amount,collected_at').in('station_id', ids).gte('collected_at', dayAgo()).limit(10000),
    req.supabase.from('kg_sales_collections').select('id,station_id,amount,collected_at').in('station_id', ids).gte('collected_at', dayAgo()).limit(10000),
    req.supabase.from('sales_collection_reversals').select('id,station_id,amount,created_at').in('station_id', ids).gte('created_at', dayAgo()).limit(10000),
    req.supabase.from('kg_sales_collection_reversals').select('id,station_id,amount,created_at').in('station_id', ids).gte('created_at', dayAgo()).limit(10000),
    req.supabase.from('nozzle_meter_readings').select('id,station_id,expected_amount,recorded_at').in('station_id', ids).eq('status', 'approved').gte('recorded_at', dayAgo()).limit(10000),
    req.supabase.from('kg_nozzle_meter_readings').select('id,station_id,expected_amount,recorded_at').in('station_id', ids).eq('status', 'approved').gte('recorded_at', dayAgo()).limit(10000),
  ]);
  const all = [attendance, cashShifts, litreChecks, kgChecks, litreAdjustments, kgAdjustments, cashCollections, kgCollections, litreReversals, kgReversals, litreSales, kgSales];
  const bad = all.find(q => q.error);
  if (bad) throw bad.error;
  const stationById = new Map(stations.map(s => [s.id, s.name]));
  const alerts = [];
  const add = (severity, type, stationId, title, detail, count = 1, action = '') => alerts.push({ id: `${type}:${stationId}:${alerts.length}`, severity, type, stationId, branch: stationById.get(stationId) || 'Branch', title, detail, count, action });
  const now = Date.now();
  for (const row of attendance.data || []) {
    const hours = (now - new Date(row.clock_in_at).getTime()) / HOUR;
    if (hours >= thresholds.openShiftHours) add(hours >= thresholds.openShiftHours * 1.5 ? 'critical' : 'warning', 'overdue_attendance', row.station_id, 'Attendance shift is still open', `Staff shift began ${Math.floor(hours)} hours ago. Verify clock-out and attendance notes.`, 1, 'Review attendance');
  }
  for (const row of cashShifts.data || []) {
    if (row.status === 'open') {
      const hours = (now - new Date(row.opened_at).getTime()) / HOUR;
      if (hours >= thresholds.openShiftHours) add(hours >= thresholds.openShiftHours * 1.5 ? 'critical' : 'warning', 'open_cash_shift', row.station_id, 'Cashier shift has not been closed', `Cash shift opened ${Math.floor(hours)} hours ago. Review collections and close the shift when verified.`, 1, 'Review cash closing');
    } else if (row.status === 'closed' && Math.abs(Number(row.variance || 0)) >= thresholds.cashVarianceNgn) {
      add(Math.abs(Number(row.variance)) >= thresholds.cashVarianceNgn * 5 ? 'critical' : 'warning', 'cash_variance', row.station_id, 'Cash closing variance needs review', `Recorded cash variance is ₦${Number(row.variance).toLocaleString('en-NG', { maximumFractionDigits: 2 })}.`, 1, 'Investigate variance');
    }
  }
  for (const row of litreChecks.data || []) if (Math.abs(Number(row.variance_litres || 0)) >= thresholds.litreStockVariance) add(Math.abs(Number(row.variance_litres)) >= thresholds.litreStockVariance * 5 ? 'critical' : 'warning', 'litre_stock_variance', row.station_id, 'Fuel stock discrepancy', `A recent tank check recorded ${Number(row.variance_litres).toLocaleString()} L variance.`, 1, 'Review tank check');
  for (const row of kgChecks.data || []) if (Math.abs(Number(row.variance_kg || 0)) >= thresholds.kgStockVariance) add(Math.abs(Number(row.variance_kg)) >= thresholds.kgStockVariance * 5 ? 'critical' : 'warning', 'kg_stock_variance', row.station_id, 'LPG stock discrepancy', `A recent tank check recorded ${Number(row.variance_kg).toLocaleString()} kg variance.`, 1, 'Review LPG stock check');
  for (const row of litreAdjustments.data || []) add('info', 'pending_litre_adjustment', row.station_id, 'Stock adjustment awaiting approval', 'A litre-based stock adjustment request is pending review.', 1, 'Review adjustment');
  for (const row of kgAdjustments.data || []) add('info', 'pending_kg_adjustment', row.station_id, 'LPG adjustment awaiting approval', 'A kilogram-based stock adjustment request is pending review.', 1, 'Review adjustment');
  for (const st of stations) {
    const sales = sum((litreSales.data || []).filter(r => r.station_id === st.id), 'expected_amount') + sum((kgSales.data || []).filter(r => r.station_id === st.id), 'expected_amount');
    const collections = sum((cashCollections.data || []).filter(r => r.station_id === st.id), 'amount') + sum((kgCollections.data || []).filter(r => r.station_id === st.id), 'amount');
    const reversals = sum((litreReversals.data || []).filter(r => r.station_id === st.id), 'amount') + sum((kgReversals.data || []).filter(r => r.station_id === st.id), 'amount');
    const netCollections = collections - reversals;
    if (sales >= thresholds.collectionGapNgn && sales - netCollections >= thresholds.collectionGapNgn) add(sales - netCollections >= thresholds.collectionGapNgn * 5 ? 'critical' : 'warning', 'collection_gap', st.id, 'Sales exceed recorded collections', `Last 24 hours: meter-derived sales ₦${sales.toLocaleString('en-NG', { maximumFractionDigits: 2 })}; net recorded collections ₦${netCollections.toLocaleString('en-NG', { maximumFractionDigits: 2 })}. Review payment timing and reversals.`, 1, 'Review sales and collections');
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.branch.localeCompare(b.branch));
}
export default function alertRoutes() {
  const r = Router();
  async function resolveScope(req, stationId) {
    if (stationId) {
      const sq = await req.supabase.from('stations').select('id,name,company_id').eq('id', stationId).maybeSingle();
      if (sq.error) throw sq.error;
      if (!sq.data) return { error: { status: 404, code: 'NOT_FOUND', message: 'Branch not found.' } };
      const [{ data: cm, error: ce }, { data: sm, error: se }] = await Promise.all([
        req.supabase.from('company_members').select('role,status').eq('company_id', sq.data.company_id).eq('user_id', req.user.id).maybeSingle(),
        req.supabase.from('station_members').select('role,status').eq('station_id', stationId).eq('user_id', req.user.id).maybeSingle(),
      ]);
      if (ce) throw ce; if (se) throw se;
      const owner = ['COMPANY_OWNER', 'COMPANY_ADMIN'].includes(cm?.role) && cm?.status === 'active';
      const manager = sm?.role === 'STATION_MANAGER' && sm?.status === 'active';
      if (!owner && !manager) return { error: { status: 403, code: 'FORBIDDEN', message: 'Only a company owner, director, or assigned branch manager can manage alert preferences.' } };
      return { companyId: sq.data.company_id, station: sq.data, owner, manager, stationId };
    }
    const owner = await ownerMembership(req);
    if (!owner) return { error: { status: 403, code: 'FORBIDDEN', message: 'Company owner or director access is required for company-wide alert preferences.' } };
    return { companyId: owner.company_id, owner: true, manager: false, stationId: null };
  }
  r.get('/preferences', async (req, res, next) => {
    try {
      const scope = await resolveScope(req, req.query.stationId ? String(req.query.stationId) : null);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      let q = req.supabase.from('management_alert_preferences').select('*').eq('company_id', scope.companyId);
      q = scope.stationId ? q.eq('station_id', scope.stationId) : q.is('station_id', null);
      const result = await q.maybeSingle(); if (result.error) throw result.error;
      const row = result.data || {};
      res.json({ data: { scope: scope.stationId ? 'branch' : 'company', preferences: { openShiftHours: Number(row.open_shift_hours ?? DEFAULT_THRESHOLDS.openShiftHours), litreStockVariance: Number(row.litre_stock_variance ?? DEFAULT_THRESHOLDS.litreStockVariance), kgStockVariance: Number(row.kg_stock_variance ?? DEFAULT_THRESHOLDS.kgStockVariance), cashVarianceNgn: Number(row.cash_variance_ngn ?? DEFAULT_THRESHOLDS.cashVarianceNgn), collectionGapNgn: Number(row.collection_gap_ngn ?? DEFAULT_THRESHOLDS.collectionGapNgn), dailySummaryEnabled: row.daily_summary_enabled ?? true } } });
    } catch (e) { next(e); }
  });
  r.put('/preferences', async (req, res, next) => {
    const parsed = preferenceSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter valid alert thresholds.');
    try {
      const stationId = parsed.data.stationId || null;
      const scope = await resolveScope(req, stationId);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      if (!stationId && !scope.owner) return fail(res, 403, 'FORBIDDEN', 'Only a company owner or director can change company-wide alert preferences.');
      const row = { company_id: scope.companyId, station_id: stationId, open_shift_hours: parsed.data.openShiftHours, litre_stock_variance: parsed.data.litreStockVariance, kg_stock_variance: parsed.data.kgStockVariance, cash_variance_ngn: parsed.data.cashVarianceNgn, collection_gap_ngn: parsed.data.collectionGapNgn, daily_summary_enabled: parsed.data.dailySummaryEnabled, updated_by: req.user.id, updated_at: new Date().toISOString() };
      const saved = await req.supabase.from('management_alert_preferences').upsert(row, { onConflict: 'company_id,station_id' }).select('*').single();
      if (saved.error) throw saved.error;
      res.json({ data: { scope: stationId ? 'branch' : 'company', preferences: { openShiftHours: saved.data.open_shift_hours, litreStockVariance: saved.data.litre_stock_variance, kgStockVariance: saved.data.kg_stock_variance, cashVarianceNgn: saved.data.cash_variance_ngn, collectionGapNgn: saved.data.collection_gap_ngn, dailySummaryEnabled: saved.data.daily_summary_enabled } } });
    } catch (e) { next(e); }
  });
  const deliveryPreferenceSchema = z.object({
    stationId: z.string().uuid().nullable().optional(),
    preferences: z.array(z.object({
      channel: z.enum(['email', 'sms', 'in_app']),
      enabled: z.boolean(),
      recipient: z.string().trim().max(320).nullable().optional(),
      dailySummary: z.boolean(),
      criticalAlerts: z.boolean(),
    })).length(3),
  }).superRefine((value, ctx) => {
    const channels = value.preferences.map((p) => p.channel);
    if (new Set(channels).size !== 3) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide one setting for each supported channel.' });
    for (const [index, pref] of value.preferences.entries()) {
      if (pref.enabled && pref.channel !== 'in_app' && !pref.recipient?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['preferences', index, 'recipient'], message: 'A recipient is required for enabled email or SMS delivery.' });
      }
      if (pref.enabled && pref.channel === 'email' && pref.recipient && !z.string().email().safeParse(pref.recipient.trim()).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['preferences', index, 'recipient'], message: 'Enter a valid email address.' });
      }
      if (pref.enabled && pref.channel === 'sms' && pref.recipient && !/^\+?[0-9 ()-]{7,24}$/.test(pref.recipient.trim())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['preferences', index, 'recipient'], message: 'Enter a valid phone number, including country code where possible.' });
      }
    }
  });
  const deliveryChannels = [
    { channel: 'email', enabled: false, recipient: '', dailySummary: true, criticalAlerts: true },
    { channel: 'sms', enabled: false, recipient: '', dailySummary: false, criticalAlerts: true },
    { channel: 'in_app', enabled: true, recipient: null, dailySummary: true, criticalAlerts: true },
  ];
  r.get('/notification-preferences', async (req, res, next) => {
    try {
      const scope = await resolveScope(req, req.query.stationId ? String(req.query.stationId) : null);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      const result = await req.supabase.from('notification_delivery_preferences').select('station_id,channel,enabled,recipient,daily_summary,critical_alerts').eq('company_id', scope.companyId);
      if (result.error) throw result.error;
      const scopedRows = (result.data || []).filter((row) => scope.stationId ? row.station_id === scope.stationId : row.station_id == null);
      const preferences = deliveryChannels.map((defaults) => {
        const row = scopedRows.find((item) => item.channel === defaults.channel);
        return row ? { channel: row.channel, enabled: row.enabled, recipient: row.recipient || '', dailySummary: row.daily_summary, criticalAlerts: row.critical_alerts } : defaults;
      });
      res.json({ data: { scope: scope.stationId ? 'branch' : 'company', preferences, availableChannels: ['in_app', 'email', 'sms'], deliveryConfigured: false, emailProviderConfigured: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL), note: 'Email delivery requires RESEND_API_KEY, NOTIFICATION_FROM_EMAIL, and the scheduled notification worker. SMS remains settings-only in this release.' } });
    } catch (e) { next(e); }
  });
  r.put('/notification-preferences', async (req, res, next) => {
    const parsed = deliveryPreferenceSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message || 'Enter valid notification settings.');
    try {
      const stationId = parsed.data.stationId || null;
      const scope = await resolveScope(req, stationId);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      if (!stationId && !scope.owner) return fail(res, 403, 'FORBIDDEN', 'Only a company owner can change company-wide notification settings.');
      const rows = parsed.data.preferences.map((pref) => ({
        company_id: scope.companyId, station_id: stationId, channel: pref.channel,
        enabled: pref.enabled, recipient: pref.channel === 'in_app' ? null : (pref.recipient?.trim() || null),
        daily_summary: pref.dailySummary, critical_alerts: pref.criticalAlerts,
        created_by: req.user.id, updated_at: new Date().toISOString(),
      }));
      const saved = await req.supabase.from('notification_delivery_preferences').upsert(rows, { onConflict: 'company_id,station_id,channel' }).select('channel,enabled,recipient,daily_summary,critical_alerts');
      if (saved.error) throw saved.error;
      const preferences = (saved.data || []).map((row) => ({ channel: row.channel, enabled: row.enabled, recipient: row.recipient || '', dailySummary: row.daily_summary, criticalAlerts: row.critical_alerts }));
      res.json({ data: { scope: stationId ? 'branch' : 'company', preferences, deliveryConfigured: false, emailProviderConfigured: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL), note: 'Settings saved. Email requires RESEND_API_KEY, NOTIFICATION_FROM_EMAIL, and the scheduled worker; SMS is not yet connected to a provider.' } });
    } catch (e) { next(e); }
  });
  r.get('/delivery-history', async (req, res, next) => {
    try {
      const scope = await resolveScope(req, req.query.stationId ? String(req.query.stationId) : null);
      if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
      let q = req.supabase.from('notification_delivery_log').select('id,station_id,channel,notification_type,status,recipient_masked,error_code,created_at,attempted_at,sent_at').eq('company_id', scope.companyId).order('created_at', { ascending: false }).limit(50);
      if (scope.stationId) q = q.eq('station_id', scope.stationId);
      const result = await q;
      if (result.error) throw result.error;
      res.json({ data: { history: result.data || [], note: 'This is a record of logged delivery attempts; an empty list does not mean a scheduled delivery job is running.' } });
    } catch (e) { next(e); }
  });
  r.get('/daily-summary', async (req, res, next) => {
    try {
      const stationId = req.query.stationId ? String(req.query.stationId) : null;
      let stations = [];
      if (stationId) {
        const scope = await resolveScope(req, stationId);
        if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
        stations = [scope.station];
      } else {
        const owner = await ownerMembership(req);
        if (!owner) return fail(res, 403, 'FORBIDDEN', 'Company owner access is required for company-wide daily summaries.');
        const q = await req.supabase.from('stations').select('id,name,company_id').eq('company_id', owner.company_id).order('name');
        if (q.error) throw q.error; stations = q.data || [];
      }
      const alerts = await buildAlerts(req, stations);
      const byType = Object.fromEntries([...new Set(alerts.map(a => a.type))].map(type => [type, alerts.filter(a => a.type === type).length]));
      res.json({ data: { generatedAt: new Date().toISOString(), period: 'last_24_hours_and_current_open_items', branchCount: stations.length, totalAlerts: alerts.length, critical: alerts.filter(a => a.severity === 'critical').length, warnings: alerts.filter(a => a.severity === 'warning').length, pendingApprovals: alerts.filter(a => a.severity === 'info').length, byType, topItems: alerts.slice(0, 10), delivery: 'in_app_only', note: 'This endpoint generates a summary on request. Scheduled email summaries require the configured Resend worker and scheduler; SMS and push delivery are not enabled in this release.' } });
    } catch (e) { next(e); }
  });
  r.get('/', async (req, res, next) => {
    try {
      const stationId = req.query.stationId ? String(req.query.stationId) : null;
      let stations = [];
      if (stationId) {
        const sq = await req.supabase.from('stations').select('id,name,company_id').eq('id', stationId).maybeSingle();
        if (sq.error) throw sq.error;
        if (!sq.data) return fail(res, 404, 'NOT_FOUND', 'Branch not found.');
        const [{ data: cm, error: ce }, { data: sm, error: se }] = await Promise.all([
          req.supabase.from('company_members').select('role,status').eq('company_id', sq.data.company_id).eq('user_id', req.user.id).maybeSingle(),
          req.supabase.from('station_members').select('role,status').eq('station_id', stationId).eq('user_id', req.user.id).maybeSingle(),
        ]);
        if (ce) throw ce; if (se) throw se;
        const owner = ['COMPANY_OWNER', 'COMPANY_ADMIN'].includes(cm?.role) && cm?.status === 'active';
        const manager = sm?.role === 'STATION_MANAGER' && sm?.status === 'active';
        if (!owner && !manager) return fail(res, 403, 'FORBIDDEN', 'Only a company owner, director, or assigned branch manager can view management alerts.');
        stations = [sq.data];
      } else {
        const owner = await ownerMembership(req);
        if (!owner) return fail(res, 403, 'FORBIDDEN', 'Company owner or director access is required for company-wide management alerts.');
        const sq = await req.supabase.from('stations').select('id,name,company_id').eq('company_id', owner.company_id).order('name');
        if (sq.error) throw sq.error;
        stations = sq.data || [];
      }
      const preferenceScope = stationId ? await resolveScope(req, stationId) : await resolveScope(req, null);
      if (preferenceScope.error) return fail(res, preferenceScope.error.status, preferenceScope.error.code, preferenceScope.error.message);
      let prefQuery = req.supabase.from('management_alert_preferences').select('*').eq('company_id', preferenceScope.companyId);
      prefQuery = stationId ? prefQuery.eq('station_id', stationId) : prefQuery.is('station_id', null);
      const prefResult = await prefQuery.maybeSingle(); if (prefResult.error) throw prefResult.error;
      const p = prefResult.data || {}; const thresholds = { openShiftHours: Number(p.open_shift_hours ?? DEFAULT_THRESHOLDS.openShiftHours), litreStockVariance: Number(p.litre_stock_variance ?? DEFAULT_THRESHOLDS.litreStockVariance), kgStockVariance: Number(p.kg_stock_variance ?? DEFAULT_THRESHOLDS.kgStockVariance), cashVarianceNgn: Number(p.cash_variance_ngn ?? DEFAULT_THRESHOLDS.cashVarianceNgn), collectionGapNgn: Number(p.collection_gap_ngn ?? DEFAULT_THRESHOLDS.collectionGapNgn), dailySummaryEnabled: p.daily_summary_enabled ?? true };
      const alerts = await buildAlerts(req, stations, thresholds);
      res.json({ data: { generatedAt: new Date().toISOString(), scope: stationId ? 'branch' : 'company', branchCount: stations.length, summary: { critical: alerts.filter(a => a.severity === 'critical').length, warning: alerts.filter(a => a.severity === 'warning').length, info: alerts.filter(a => a.severity === 'info').length, total: alerts.length }, alerts, thresholds, note: 'Alerts are operational signals based on recorded data, not proof of fraud or a final accounting determination. Sales-to-collection comparisons do not account for payment timing or every reversal scenario.' } });
    } catch (e) { next(e); }
  });
  return r;
}
