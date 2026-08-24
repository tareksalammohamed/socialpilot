-- Remove the retired Customer Center / Lead Hunter feature from existing databases.
-- Historical Lead Hunter migrations are intentionally preserved for migration-history integrity.

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_evidence', 'lead_audit_logs', 'lead_ai_evaluations', 'lead_exports',
    'lead_suppression_list', 'lead_campaign_members', 'lead_campaigns',
    'lead_tag_links', 'lead_tags', 'lead_scores', 'lead_search_results',
    'lead_source_records', 'lead_contacts', 'leads', 'lead_search_jobs',
    'lead_search_filters', 'lead_search_requests', 'lead_source_secrets',
    'lead_sources', 'lead_hunter_admin_logs', 'lead_hunter_usage_events',
    'lead_hunter_errors', 'lead_hunter_source_runs', 'lead_hunter_permissions',
    'lead_hunter_workspace_limits', 'lead_hunter_prompts',
    'lead_hunter_scoring_settings', 'lead_hunter_settings'
  ] LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', table_name);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.lead_workspace_member(uuid) CASCADE;
