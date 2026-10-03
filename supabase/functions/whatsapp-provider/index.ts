import { handleWhatsAppProvider } from '../_shared/whatsapp-provider-handler.ts';

Deno.serve((req: Request) => handleWhatsAppProvider(req));
