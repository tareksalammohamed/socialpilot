-- 0033_media_system.sql
-- Universal AI Agent spec, section 10 (Media System) & 11 (Post Preview).
-- Adds a real media library: a `media` table + a `media` storage bucket,
-- both scoped to the workspace, plus a nullable FK from content_variants so
-- a variant can have at most one attached media item (matches the existing
-- upload_media/attach_media/replace_media/remove_media tool contract).

-- ---------- media ----------
CREATE TABLE IF NOT EXISTS public.media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  content_id uuid REFERENCES public.content(id) ON DELETE SET NULL,
  storage_path text NOT NULL,       -- path inside the `media` bucket: {workspace_id}/{uuid}-{filename}
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'video')),
  alt_text text,
  caption text,
  source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'library', 'ai_generated')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.media ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_media_workspace ON public.media(workspace_id);
CREATE INDEX IF NOT EXISTS idx_media_content ON public.media(content_id);

DROP POLICY IF EXISTS "media_select_member" ON public.media;
CREATE POLICY "media_select_member" ON public.media FOR SELECT
  TO authenticated USING (public.user_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS "media_insert_member" ON public.media;
CREATE POLICY "media_insert_member" ON public.media FOR INSERT
  TO authenticated WITH CHECK (public.user_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS "media_update_member" ON public.media;
CREATE POLICY "media_update_member" ON public.media FOR UPDATE
  TO authenticated USING (public.user_workspace_role(workspace_id) IS NOT NULL)
  WITH CHECK (public.user_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS "media_delete_member" ON public.media;
CREATE POLICY "media_delete_member" ON public.media FOR DELETE
  TO authenticated USING (public.user_workspace_role(workspace_id) IS NOT NULL);

-- ---------- content_variants.media_id ----------
ALTER TABLE public.content_variants
  ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES public.media(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cv_media ON public.content_variants(media_id);

-- ---------- storage bucket ----------
-- Public read (so preview/publish can hot-link the image), member-gated
-- write. Objects are stored as `{workspace_id}/{uuid}-{filename}`, so
-- (storage.foldername(name))[1] is always the workspace_id.
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "media_bucket_select_public" ON storage.objects;
CREATE POLICY "media_bucket_select_public" ON storage.objects FOR SELECT
  USING (bucket_id = 'media');

DROP POLICY IF EXISTS "media_bucket_insert_member" ON storage.objects;
CREATE POLICY "media_bucket_insert_member" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'media'
    AND public.user_workspace_role(((storage.foldername(name))[1])::uuid) IS NOT NULL
  );

DROP POLICY IF EXISTS "media_bucket_update_member" ON storage.objects;
CREATE POLICY "media_bucket_update_member" ON storage.objects FOR UPDATE
  TO authenticated USING (
    bucket_id = 'media'
    AND public.user_workspace_role(((storage.foldername(name))[1])::uuid) IS NOT NULL
  );

DROP POLICY IF EXISTS "media_bucket_delete_member" ON storage.objects;
CREATE POLICY "media_bucket_delete_member" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'media'
    AND public.user_workspace_role(((storage.foldername(name))[1])::uuid) IS NOT NULL
  );
