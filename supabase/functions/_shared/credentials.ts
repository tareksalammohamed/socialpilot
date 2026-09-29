import { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

const ENV_FALLBACK: Record<string, string> = {
  meta_app_id: 'META_APP_ID',
  meta_app_secret: 'META_APP_SECRET',
  meta_config_id: 'META_CONFIG_ID',
  linkedin_client_id: 'LINKEDIN_CLIENT_ID',
  linkedin_client_secret: 'LINKEDIN_CLIENT_SECRET',
  x_client_id: 'X_CLIENT_ID',
  x_client_secret: 'X_CLIENT_SECRET',
  threads_app_id: 'THREADS_APP_ID',
  threads_app_secret: 'THREADS_APP_SECRET',
  tiktok_client_key: 'TIKTOK_CLIENT_KEY',
  tiktok_client_secret: 'TIKTOK_CLIENT_SECRET',
  app_url: 'APP_URL',
};

export async function getCredential(supabase: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await supabase.from('platform_credentials').select('value').eq('key', key).maybeSingle();
  if (data?.value) return data.value;
  const envKey = ENV_FALLBACK[key];
  return envKey ? Deno.env.get(envKey) ?? null : null;
}

export async function getCredentials(supabase: SupabaseClient, keys: string[]): Promise<Record<string, string | null>> {
  const { data } = await supabase.from('platform_credentials').select('key, value').in('key', keys);
  const fromDb = new Map((data ?? []).map((row) => [row.key as string, row.value as string]));
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    result[key] = fromDb.get(key) || (ENV_FALLBACK[key] ? Deno.env.get(ENV_FALLBACK[key]) ?? null : null);
  }
  return result;
}
