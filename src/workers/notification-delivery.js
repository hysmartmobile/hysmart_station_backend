import 'dotenv/config';
import { getConfig } from '../config/env.js';
import { createSupabase } from '../services/supabase.js';
import { buildAlerts } from '../routes/alerts.js';

const config = getConfig();
const supabase = createSupabase(config);
const apiKey = process.env.RESEND_API_KEY || '';
const from = process.env.NOTIFICATION_FROM_EMAIL || '';
const today = new Date().toISOString().slice(0, 10);
const mask = (value) => String(value || '').replace(/^(.{1,2}).*(@.*)$/, '$1***$2');


async function syncInAppAndCriticalEmails() {
  const owners = await supabase.from('company_members').select('user_id,company_id').in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']).eq('status', 'active');
  if (owners.error) throw owners.error;
  const managers = await supabase.from('station_members').select('user_id,station_id').eq('role', 'STATION_MANAGER').eq('status', 'active');
  if (managers.error) throw managers.error;
  const attendants = await supabase.from('station_members').select('user_id,station_id').eq('role', 'ATTENDANT').eq('status', 'active');
  if (attendants.error) throw attendants.error;
  const work = [];
  for (const owner of owners.data || []) {
    const stations = await supabase.from('stations').select('id,name,company_id').eq('company_id', owner.company_id).order('name');
    if (stations.error) throw stations.error;
    work.push({ userId: owner.user_id, companyId: owner.company_id, stations: stations.data || [] });
  }
  const managerGroups = new Map();
  for (const member of managers.data || []) {
    const key = member.user_id;
    if (!managerGroups.has(key)) managerGroups.set(key, new Set());
    managerGroups.get(key).add(member.station_id);
  }
  for (const [userId, ids] of managerGroups) {
    const stations = await supabase.from('stations').select('id,name,company_id').in('id', [...ids]).order('name');
    if (stations.error) throw stations.error;
    const companies = new Set((stations.data || []).map(s => s.company_id));
    if (companies.size === 1) work.push({ userId, companyId: [...companies][0], stations: stations.data || [], role: 'manager' });
  }
  const attendantGroups = new Map();
  for (const member of attendants.data || []) {
    if (!attendantGroups.has(member.user_id)) attendantGroups.set(member.user_id, new Set());
    attendantGroups.get(member.user_id).add(member.station_id);
  }
  for (const [userId, ids] of attendantGroups) {
    const stations = await supabase.from('stations').select('id,name,company_id').in('id', [...ids]).order('name');
    if (stations.error) throw stations.error;
    const companies = new Set((stations.data || []).map(s => s.company_id));
    if (companies.size === 1) work.push({ userId, companyId: [...companies][0], stations: stations.data || [], role: 'attendant' });
  }
  for (const item of work) {
    if (!item.companyId || !item.stations.length) continue;
    const alerts = await buildAlerts({ supabase }, item.stations);
    // Attendants only receive branch-local shift/attendance messages, not management financial exceptions.
    const visibleAlerts = item.role === 'attendant' ? alerts.filter(a => ['overdue_attendance', 'open_cash_shift'].includes(a.type)) : alerts;
    const prefs = await supabase.from('notification_delivery_preferences').select('station_id,enabled').eq('company_id', item.companyId).eq('channel', 'in_app');
    if (prefs.error) throw prefs.error;
    const inAppByStation = new Map((prefs.data || []).map(p => [p.station_id || 'company', p.enabled]));
    const rows = visibleAlerts.filter(a => inAppByStation.has(a.stationId) ? inAppByStation.get(a.stationId) : (inAppByStation.has('company') ? inAppByStation.get('company') : true)).map(a => ({
      user_id: item.userId, company_id: item.companyId, station_id: a.stationId,
      fingerprint: `${a.type}:${a.stationId}:${a.title}:${a.detail}`.slice(0, 500),
      title: a.title, message: `${a.branch}: ${a.detail}`, severity: a.severity,
      notification_type: a.type,
      action_path: ({ overdue_attendance: '/attendance', open_cash_shift: '/sales', cash_variance: '/sales', litre_stock_variance: '/controls', kg_stock_variance: '/sales', pending_litre_adjustment: '/controls', pending_kg_adjustment: '/controls', collection_gap: '/sales' })[a.type] || '/alerts',
    }));
    if (rows.length) {
      const saved = await supabase.from('notification_inbox').upsert(rows, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true });
      if (saved.error) throw saved.error;
    }
    const critical = item.role === 'attendant' ? [] : alerts.filter(a => a.severity === 'critical');
    if (critical.length) {
      const emailPrefs = await supabase.from('notification_delivery_preferences').select('station_id,recipient').eq('company_id', item.companyId).eq('channel', 'email').eq('enabled', true).eq('critical_alerts', true);
      if (emailPrefs.error) throw emailPrefs.error;
      const existing = await supabase.from('notification_delivery_log').select('metadata').eq('company_id', item.companyId).eq('channel', 'email').gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).limit(1000);
      if (existing.error) throw existing.error;
      const fingerprints = new Set((existing.data || []).map(row => row.metadata?.fingerprint).filter(Boolean));
      const jobs = [];
      for (const alert of critical) {
        const recipients = (emailPrefs.data || []).filter(p => p.station_id === alert.stationId || !p.station_id);
        for (const pref of recipients) {
          const fingerprint = `${alert.type}:${alert.stationId}:${alert.title}:${alert.detail}:${pref.recipient.toLowerCase()}`;
          if (!pref.recipient || fingerprints.has(fingerprint)) continue;
          fingerprints.add(fingerprint);
          jobs.push({ company_id: item.companyId, station_id: alert.stationId, channel: 'email', notification_type: alert.type, status: 'queued', recipient_masked: mask(pref.recipient), metadata: { to: pref.recipient, subject: `[HySmart ${alert.severity.toUpperCase()}] ${alert.title}`, text: `${alert.branch}: ${alert.detail}`, fingerprint } });
        }
      }
      if (jobs.length) {
        const q = await supabase.from('notification_delivery_log').insert(jobs);
        if (q.error && q.error.code !== '23505') throw q.error;
      }
    }
  }
}

async function queueDailySummaries() {
  const prefs = await supabase.from('notification_delivery_preferences').select('company_id,station_id,recipient').eq('channel', 'email').eq('enabled', true).eq('daily_summary', true);
  if (prefs.error) throw prefs.error;
  for (const pref of prefs.data || []) {
    if (!pref.recipient) continue;
    const fingerprint = `daily-summary:${today}:${pref.company_id}:${pref.station_id || 'company'}:${pref.recipient.toLowerCase()}`;
    const existing = await supabase.from('notification_delivery_log').select('id').eq('channel', 'email').contains('metadata', { fingerprint }).limit(1).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) continue;
    const stationQuery = supabase.from('stations').select('id,name,company_id').eq('company_id', pref.company_id).order('name');
    if (pref.station_id) stationQuery.eq('id', pref.station_id);
    const stations = await stationQuery;
    if (stations.error) throw stations.error;
    const alerts = await buildAlerts({ supabase }, stations.data || []);
    const critical = alerts.filter(a => a.severity === 'critical').length;
    const warnings = alerts.filter(a => a.severity === 'warning').length;
    const lines = alerts.slice(0, 15).map(a => `• [${a.severity.toUpperCase()}] ${a.branch}: ${a.title} — ${a.detail}`);
    const scope = pref.station_id ? (stations.data?.[0]?.name || 'Branch') : 'All company branches';
    const text = [`HySmart Station daily summary — ${today}`, `Scope: ${scope}`, `Branches covered: ${(stations.data || []).length}`, `Open alerts: ${alerts.length} (${critical} critical, ${warnings} warnings)`, '', ...(lines.length ? lines : ['No current operational alerts were detected.']), '', 'This summary is an operational review aid; verify records before taking action.'].join('\n');
    const queued = await supabase.from('notification_delivery_log').insert({ company_id: pref.company_id, station_id: pref.station_id, channel: 'email', notification_type: 'daily_summary', status: 'queued', recipient_masked: mask(pref.recipient), metadata: { to: pref.recipient, subject: `HySmart Station daily summary — ${today}`, text, fingerprint } });
    if (queued.error && queued.error.code !== '23505') throw queued.error;
  }
}



function businessDateInTimezone(date = new Date(), timeZone = process.env.BUSINESS_TIMEZONE || 'Africa/Lagos') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function previousBusinessDate(date = new Date()) {
  const current = businessDateInTimezone(date);
  const day = new Date(`${current}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

async function queueDailyCloseReminders() {
  const businessDate = previousBusinessDate();
  const [stationsQ, ownersQ, managersQ, prefsQ] = await Promise.all([
    supabase.from('stations').select('id,name,company_id').order('name'),
    supabase.from('company_members').select('user_id,company_id').in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']).eq('status', 'active'),
    supabase.from('station_members').select('user_id,station_id').eq('role', 'STATION_MANAGER').eq('status', 'active'),
    supabase.from('notification_delivery_preferences').select('company_id,station_id,recipient,enabled,daily_summary').eq('channel', 'email').eq('enabled', true).eq('daily_summary', true),
  ]);
  for (const q of [stationsQ, ownersQ, managersQ, prefsQ]) if (q.error) throw q.error;
  const stations = stationsQ.data || [];
  const ownersByCompany = new Map();
  for (const owner of ownersQ.data || []) {
    if (!ownersByCompany.has(owner.company_id)) ownersByCompany.set(owner.company_id, []);
    ownersByCompany.get(owner.company_id).push(owner.user_id);
  }
  const managersByStation = new Map();
  for (const manager of managersQ.data || []) {
    if (!managersByStation.has(manager.station_id)) managersByStation.set(manager.station_id, []);
    managersByStation.get(manager.station_id).push(manager.user_id);
  }
  const inbox = [];
  const emailJobs = [];
  const emailFingerprintsQueued = new Set();
  for (const station of stations) {
    if (!station.company_id) continue;
    const closeQ = await supabase.from('station_daily_closing_reviews').select('id,status,review_note,submitted_at').eq('station_id', station.id).eq('business_date', businessDate).maybeSingle();
    if (closeQ.error) throw closeQ.error;
    const close = closeQ.data;
    let targetUsers = [];
    let type = '';
    let severity = 'warning';
    let title = '';
    let message = '';
    let actionPath = '';
    if (!close || close.status === 'rejected') {
      targetUsers = managersByStation.get(station.id) || [];
      type = close?.status === 'rejected' ? 'daily_close_rejected' : 'daily_close_overdue';
      title = close?.status === 'rejected' ? 'Daily close needs correction' : 'Daily close is overdue';
      message = close?.status === 'rejected'
        ? `${station.name}: the daily close for ${businessDate} was rejected. Review the owner feedback${close.review_note ? `: ${close.review_note}` : ''} and resubmit.`
        : `${station.name}: no daily close has been submitted for ${businessDate}. Submit it after all shifts are closed and reconciled.`;
      actionPath = '/controls';
    } else if (close.status === 'submitted') {
      targetUsers = ownersByCompany.get(station.company_id) || [];
      type = 'daily_close_owner_review_pending';
      title = 'Branch daily close awaits review';
      message = `${station.name}: the daily close for ${businessDate} is submitted and awaits your review.`;
      actionPath = '/company/daily-closing';
    } else {
      continue;
    }
    const fingerprintBase = `${type}:${station.id}:${businessDate}`;
    for (const userId of [...new Set(targetUsers)]) {
      inbox.push({ user_id: userId, company_id: station.company_id, station_id: station.id, fingerprint: `${fingerprintBase}:${userId}`.slice(0, 500), title, message, severity, notification_type: type, action_path: actionPath });
    }
    // Email is sent only to recipients who explicitly enabled daily-summary email delivery.
    const eligiblePrefs = (prefsQ.data || []).filter(pref => pref.company_id === station.company_id && pref.recipient && (pref.station_id === station.id || !pref.station_id));
    for (const pref of eligiblePrefs) {
      const fingerprint = `daily-close-reminder:${fingerprintBase}:${pref.recipient.toLowerCase()}`;
      if (emailFingerprintsQueued.has(fingerprint)) continue;
      emailFingerprintsQueued.add(fingerprint);
      const existing = await supabase.from('notification_delivery_log').select('id,status').eq('channel', 'email').contains('metadata', { fingerprint }).in('status', ['queued', 'sent']).limit(1).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) continue;
      emailJobs.push({ company_id: station.company_id, station_id: station.id, channel: 'email', notification_type: type, status: 'queued', recipient_masked: mask(pref.recipient), metadata: { to: pref.recipient, subject: `[HySmart] ${title} — ${station.name}`, text: message, fingerprint } });
    }
  }
  // Continue escalating submissions that remain unreviewed for more than 24 hours.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pendingQ = await supabase.from('station_daily_closing_reviews').select('id,company_id,station_id,business_date,submitted_at').eq('status', 'submitted').lt('submitted_at', cutoff).limit(1000);
  if (pendingQ.error) throw pendingQ.error;
  const escalationDate = businessDateInTimezone();
  for (const pending of pendingQ.data || []) {
    const owners = ownersByCompany.get(pending.company_id) || [];
    const station = stations.find(item => item.id === pending.station_id);
    if (!station) continue;
    for (const userId of [...new Set(owners)]) {
      inbox.push({ user_id: userId, company_id: pending.company_id, station_id: pending.station_id, fingerprint: `daily_close_owner_escalation:${pending.id}:${escalationDate}:${userId}`.slice(0, 500), title: 'Daily close review is overdue', message: `${station.name}: the submitted daily close for ${pending.business_date} has awaited owner review for more than 24 hours.`, severity: 'warning', notification_type: 'daily_close_owner_review_overdue', action_path: '/company/daily-closing' });
    }
    const eligiblePrefs = (prefsQ.data || []).filter(pref => pref.company_id === pending.company_id && pref.recipient && (pref.station_id === pending.station_id || !pref.station_id));
    for (const pref of eligiblePrefs) {
      const fingerprint = `daily-close-owner-escalation:${pending.id}:${escalationDate}:${pref.recipient.toLowerCase()}`;
      if (emailFingerprintsQueued.has(fingerprint)) continue;
      emailFingerprintsQueued.add(fingerprint);
      const existing = await supabase.from('notification_delivery_log').select('id,status').eq('channel', 'email').contains('metadata', { fingerprint }).in('status', ['queued', 'sent']).limit(1).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) continue;
      emailJobs.push({ company_id: pending.company_id, station_id: pending.station_id, channel: 'email', notification_type: 'daily_close_owner_review_overdue', status: 'queued', recipient_masked: mask(pref.recipient), metadata: { to: pref.recipient, subject: `[HySmart] Daily close review overdue — ${station.name}`, text: `${station.name}: the submitted daily close for ${pending.business_date} has awaited owner review for more than 24 hours.`, fingerprint } });
    }
  }
  if (inbox.length) {
    const q = await supabase.from('notification_inbox').upsert(inbox, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true });
    if (q.error) throw q.error;
  }
  if (emailJobs.length) {
    const q = await supabase.from('notification_delivery_log').insert(emailJobs);
    if (q.error && q.error.code !== '23505') throw q.error;
  }
  return { businessDate, reminders: inbox.length, emailJobsQueued: emailJobs.length };
}

async function sendQueuedEmails() {
  const queued = await supabase.from('notification_delivery_log').select('id,company_id,station_id,notification_type,metadata,recipient_masked').eq('channel', 'email').eq('status', 'queued').order('created_at', { ascending: true }).limit(50);
  if (queued.error) throw queued.error;
  for (const item of queued.data || []) {
    const now = new Date().toISOString();
    await supabase.from('notification_delivery_log').update({ attempted_at: now }).eq('id', item.id).eq('status', 'queued');
    if (!apiKey || !from) {
      await supabase.from('notification_delivery_log').update({ status: 'failed', error_code: 'EMAIL_PROVIDER_NOT_CONFIGURED', metadata: { ...(item.metadata || {}), last_error: 'Set RESEND_API_KEY and NOTIFICATION_FROM_EMAIL.' } }).eq('id', item.id);
      continue;
    }
    const to = item.metadata?.to;
    if (!to || !item.metadata?.subject || !item.metadata?.text) {
      await supabase.from('notification_delivery_log').update({ status: 'failed', error_code: 'INVALID_EMAIL_JOB' }).eq('id', item.id);
      continue;
    }
    try {
      const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject: item.metadata.subject, text: item.metadata.text }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        await supabase.from('notification_delivery_log').update({ status: 'failed', error_code: `RESEND_HTTP_${response.status}`, metadata: { ...(item.metadata || {}), last_error: String(payload.message || 'Email provider rejected the request').slice(0, 300) } }).eq('id', item.id);
        continue;
      }
      await supabase.from('notification_delivery_log').update({ status: 'sent', sent_at: new Date().toISOString(), provider_message_id: payload.id || null, error_code: null }).eq('id', item.id);
    } catch (error) {
      await supabase.from('notification_delivery_log').update({ status: 'failed', error_code: 'EMAIL_NETWORK_ERROR', metadata: { ...(item.metadata || {}), last_error: String(error?.message || 'Network error').slice(0, 300) } }).eq('id', item.id);
    }
  }
  return queued.data?.length || 0;
}

const workerRunStartedAt = new Date().toISOString();
async function writeWorkerHeartbeat(status, details = {}) {
  if (!supabase) return;
  const row = { worker_name: 'notification-delivery', status, started_at: workerRunStartedAt, completed_at: status === 'succeeded' || status === 'failed' ? new Date().toISOString() : null, updated_at: new Date().toISOString(), summary: details.summary || null, error_message: details.error ? String(details.error).slice(0, 500) : null };
  const result = await supabase.from('notification_worker_heartbeat').upsert(row, { onConflict: 'worker_name' });
  if (result.error) throw result.error;
}

try {
  if (!supabase) throw new Error('Supabase service configuration is required.');
  await writeWorkerHeartbeat('running');
  await syncInAppAndCriticalEmails();
  const dailyCloseReminders = await queueDailyCloseReminders();
  // Default daily-summary send window is 22:00 UTC (23:00 in Nigeria); override with SUMMARY_HOUR_UTC.
  const summaryHour = Number(process.env.SUMMARY_HOUR_UTC ?? 22);
  if (new Date().getUTCHours() === summaryHour) await queueDailySummaries();
  const processed = await sendQueuedEmails();
  const summary = { date: today, processed, dailyCloseReminders, providerConfigured: Boolean(apiKey && from) };
  await writeWorkerHeartbeat('succeeded', { summary });
  console.log(JSON.stringify({ worker: 'notification-delivery', ...summary }));
} catch (error) {
  try { await writeWorkerHeartbeat('failed', { error: error?.message || error }); } catch (heartbeatError) { console.error(`[notification-delivery] heartbeat update failed: ${heartbeatError?.message || heartbeatError}`); }
  console.error(`[notification-delivery] ${error?.message || error}`);
  process.exitCode = 1;
}
