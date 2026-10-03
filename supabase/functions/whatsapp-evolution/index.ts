// Legacy callers share the same lifecycle lock, persistence and switch guards.
import { handleWhatsAppProvider } from '../_shared/whatsapp-provider-handler.ts';

Deno.serve((req: Request) => handleWhatsAppProvider(req, 'evolution'));
