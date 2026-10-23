import { Router } from 'express';

export default function healthRoutes(config, supabase) {
  const r = Router();
  r.get('/', (_req, res) => res.json({
    data: {
      status: 'ok',
      service: 'hysmart-station-api',
      version: config.version || '2.25.8',
      environment: config.nodeEnv,
      checks: { api: 'ok', supabaseConfigured: Boolean(supabase) },
    },
  }));
  r.get('/ready', async (_req, res) => {
    if (!supabase) return res.status(503).json({ data: { status: 'not_ready', checks: { supabase: 'not_configured' } } });
    try {
      // Cheap connectivity/readiness probe; never expose project keys or database details.
      const { error } = await supabase.from('companies').select('id').limit(1);
      if (error) throw error;
      return res.json({ data: { status: 'ready', checks: { supabase: 'ok' } } });
    } catch {
      return res.status(503).json({ data: { status: 'not_ready', checks: { supabase: 'unavailable' } } });
    }
  });
  return r;
}
