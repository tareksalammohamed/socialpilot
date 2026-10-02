// Compatibility for callbacks registered before dedicated provider endpoints.
// Forward the exact bytes so WAHA's HMAC remains verifiable by the destination.
const destinations: Record<string, string> = {
  evolution: 'whatsapp-evolution-webhook',
  waha: 'whatsapp-waha-webhook',
  wppconnect: 'whatsapp-wppconnect-webhook',
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const source = new URL(req.url);
  const provider = source.searchParams.get('provider') ?? '';
  if (!Object.hasOwn(destinations, provider)) return new Response('Unknown provider', { status: 400 });
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!base) return new Response('Service unavailable', { status: 503 });
  const target = new URL(`${base}/functions/v1/${destinations[provider]}`);
  if (provider === 'wppconnect') {
    for (const key of ['session', 'secret']) {
      const value = source.searchParams.get(key);
      if (value) target.searchParams.set(key, value);
    }
  }
  const headers = new Headers();
  for (const key of ['content-type', 'x-socialpilot-secret', 'x-webhook-hmac', 'x-webhook-hmac-algorithm']) {
    const value = req.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const response = await fetch(target, {
      method: 'POST', headers, body: await req.arrayBuffer(), signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response('{"error":"Webhook destination unavailable"}', { status: 502 });
  }
});
