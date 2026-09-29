import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { getCredential } from './credentials.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** Redirect back into the app's Connected Accounts page with an outcome.
 * Resolves the base URL from Settings > Integrations first, falling back
 * to the APP_URL env var if nothing's been saved there yet. */
export async function redirectToApp(supabase: SupabaseClient, params: Record<string, string>): Promise<Response> {
  const appUrl = (await getCredential(supabase, 'app_url')) ?? '';
  const url = new URL(`${appUrl.replace(/\/$/, '')}/app/accounts`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

export function serviceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Verifies the caller's bearer token and returns their user id, or null. */
export async function getCallerId(supabase: SupabaseClient, req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !data.user) return null;
  return data.user.id;
}

export function randomState(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}
