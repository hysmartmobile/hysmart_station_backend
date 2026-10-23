import 'dotenv/config';
import { getConfig } from '../config/env.js';
import { createSupabase } from '../services/supabase.js';

const config = getConfig();
const supabase = createSupabase(config);
if (!supabase) throw new Error('Supabase service configuration is required for anomaly escalation.');

async function run() {
  const now = new Date();
  const dueQ = await supabase.from('operational_anomaly_cases')
    .select('id,company_id,station_id,fingerprint,severity,title,description,status,escalation_level,next_escalation_at')
    .in('status', ['open', 'acknowledged']).not('next_escalation_at', 'is', null).lte('next_escalation_at', now.toISOString())
    .order('next_escalation_at', { ascending: true }).limit(200);
  if (dueQ.error) throw dueQ.error;
  let escalated = 0;
  for (const item of dueQ.data || []) {
    if (item.escalation_level >= 3) {
      const defer = await supabase.from('operational_anomaly_cases').update({ next_escalation_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), updated_at: now.toISOString() }).eq('id', item.id).eq('escalation_level', item.escalation_level);
      if (defer.error) throw defer.error;
      continue;
    }
    const nextLevel = item.escalation_level + 1;
    const delayMs = nextLevel === 1 ? 60 * 60 * 1000 : nextLevel === 2 ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const update = await supabase.from('operational_anomaly_cases').update({ escalation_level: nextLevel, next_escalation_at: new Date(now.getTime() + delayMs).toISOString(), updated_at: now.toISOString() }).eq('id', item.id).eq('escalation_level', item.escalation_level).in('status', ['open', 'acknowledged']).select('id').maybeSingle();
    if (update.error) throw update.error;
    if (!update.data) continue; // Another worker handled this case.
    const [ownersQ, managersQ, stationQ] = await Promise.all([
      supabase.from('company_members').select('user_id').eq('company_id', item.company_id).in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']).eq('status', 'active'),
      supabase.from('station_members').select('user_id').eq('station_id', item.station_id).eq('role', 'STATION_MANAGER').eq('status', 'active'),
      supabase.from('stations').select('name').eq('id', item.station_id).maybeSingle(),
    ]);
    for (const q of [ownersQ, managersQ, stationQ]) if (q.error) throw q.error;
    const recipients = [...new Set([...(ownersQ.data || []).map(row => row.user_id), ...(managersQ.data || []).map(row => row.user_id)])];
    const severity = item.severity === 'critical' ? 'critical' : 'warning';
    if (recipients.length) {
      const rows = recipients.map(user_id => ({ user_id, company_id: item.company_id, station_id: item.station_id, fingerprint: `anomaly-escalation:${item.id}:level-${nextLevel}:${user_id}`, title: `Escalated: ${item.title}`, message: `${stationQ.data?.name || 'Station'} · escalation level ${nextLevel}. ${item.description} This issue remains ${item.status}; review the evidence and record a decision.`, severity, notification_type: 'anomaly_escalation', action_path: '/advanced-operations' }));
      const inbox = await supabase.from('notification_inbox').upsert(rows, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true });
      if (inbox.error) throw inbox.error;
    }
    if (item.severity === 'critical') {
      const prefsQ = await supabase.from('notification_delivery_preferences').select('station_id,recipient').eq('company_id', item.company_id).eq('channel', 'email').eq('enabled', true).eq('critical_alerts', true);
      if (prefsQ.error) throw prefsQ.error;
      const jobs = [];
      for (const pref of prefsQ.data || []) {
        if (!pref.recipient || (pref.station_id && pref.station_id !== item.station_id)) continue;
        const fingerprint = `anomaly-escalation:${item.id}:level-${nextLevel}:${pref.recipient.toLowerCase()}`;
        jobs.push({ company_id: item.company_id, station_id: item.station_id, channel: 'email', notification_type: 'anomaly_escalation', status: 'queued', recipient_masked: String(pref.recipient).replace(/^(.{1,2}).*(@.*)$/, '$1***$2'), metadata: { to: pref.recipient, subject: `[HySmart CRITICAL] Escalated: ${item.title}`, text: `${stationQ.data?.name || 'Station'} · escalation level ${nextLevel}. ${item.description} Please review the evidence in HySmart Station.`, fingerprint } });
      }
      for (const job of jobs) {
        const existingJob = await supabase.from('notification_delivery_log').select('id').eq('channel', 'email').contains('metadata', { fingerprint: job.metadata.fingerprint }).limit(1).maybeSingle();
        if (existingJob.error) throw existingJob.error;
        if (existingJob.data) continue;
        const queued = await supabase.from('notification_delivery_log').insert(job);
        if (queued.error && queued.error.code !== '23505') throw queued.error;
      }

    }
    const audit = await supabase.from('audit_events').insert({ company_id: item.company_id, station_id: item.station_id, actor_user_id: null, action: 'ANOMALY_CASE_ESCALATED', entity_type: 'operational_anomaly_case', entity_id: item.id, metadata: { escalationLevel: nextLevel, severity: item.severity, recipientCount: recipients.length } });
    if (audit.error) throw audit.error;
    escalated++;
  }
  process.stdout.write(JSON.stringify({ scanned: dueQ.data?.length || 0, escalated, ranAt: now.toISOString() }) + '\n');
}

run().catch(error => { console.error('[anomaly-escalation] failed', error.message || error); process.exitCode = 1; });
