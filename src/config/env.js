import 'dotenv/config';

function parseOrigins(value) {
  return String(value || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function getConfig(env = process.env) {
  // Accept the historical environment variable names used by existing deployments.
  // FRONTEND_ORIGIN takes precedence; FRONTEND_URL and CORS_ORIGIN are fallbacks.
  const originsValue = env.FRONTEND_ORIGIN || env.FRONTEND_URL || env.CORS_ORIGIN || 'http://localhost:5173';
  const frontendOrigins = parseOrigins(originsValue);
  const config = {
    port: Number(env.PORT || 3001),
    nodeEnv: env.NODE_ENV || 'development',
    version: env.APP_VERSION || '2.25.9',
    frontendOrigins,
    frontendOrigin: frontendOrigins[0] || 'http://localhost:5173',
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    paystackSecretKey: env.PAYSTACK_SECRET_KEY || '',
    requestBodyLimit: env.REQUEST_BODY_LIMIT || '100kb',
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const looksLikePlaceholder = (value) => /YOUR_|REPLACE_WITH|CHANGE_ME|PLACEHOLDER/i.test(String(value || ''));
  if (config.supabaseUrl && looksLikePlaceholder(config.supabaseUrl)) {
    throw new Error('SUPABASE_URL is still a placeholder. Set the real Supabase project URL in the backend .env file.');
  }
  if (config.supabaseServiceRoleKey && looksLikePlaceholder(config.supabaseServiceRoleKey)) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is still a placeholder. Set a valid server-only service-role key in the backend .env file.');
  }
  if (config.nodeEnv === 'production') {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.');
    }
    if (!config.paystackSecretKey || !config.paystackSecretKey.startsWith('sk_live_')) {
      throw new Error('PAYSTACK_SECRET_KEY must be a live Paystack secret key in production.');
    }
    let parsed;
    try { parsed = new URL(config.supabaseUrl); } catch { throw new Error('SUPABASE_URL must be a valid URL.'); }
    if (parsed.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS in production.');
    if (!env.FRONTEND_ORIGIN || !config.frontendOrigins.length) {
      throw new Error('FRONTEND_ORIGIN must explicitly list the production frontend origin(s).');
    }
    if (config.frontendOrigins.some((origin) => origin === '*' || /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(origin))) {
      throw new Error('Wildcard and localhost frontend origins are not allowed in production.');
    }
    if (config.frontendOrigins.some((origin) => { try { return new URL(origin).protocol !== 'https:'; } catch { return true; } })) {
      throw new Error('Every production FRONTEND_ORIGIN must be a valid HTTPS URL.');
    }
  }
  return config;
}
