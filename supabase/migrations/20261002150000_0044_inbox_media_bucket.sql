-- Private storage for inbound WhatsApp media fetched from provider gateways.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('inbox-media', 'inbox-media', false, 26214400)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit;
