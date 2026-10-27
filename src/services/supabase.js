import { createClient } from "@supabase/supabase-js";

export function createSupabase(config = {}) {
  const supabaseUrl = config.supabaseUrl?.trim();
  const serviceRoleKey = config.supabaseServiceRoleKey?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    const missing = [];
    if (!supabaseUrl) missing.push("SUPABASE_URL");
    if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    console.error(`[Supabase] Missing server configuration: ${missing.join(", ")}`);
    return null;
  }

  let parsedUrl;
  try { parsedUrl = new URL(supabaseUrl); }
  catch { throw new Error("SUPABASE_URL must be a valid URL."); }

  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocal = localHosts.has(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !(config.nodeEnv !== "production" && isLocal)) {
    throw new Error("SUPABASE_URL must use HTTPS outside local development.");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("SUPABASE_URL must not contain credentials, query parameters, or a fragment.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "hysmart-station-server" } },
  });
}
