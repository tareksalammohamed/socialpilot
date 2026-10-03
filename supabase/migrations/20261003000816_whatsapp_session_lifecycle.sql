-- A bounded lease serializes provider HTTP operations across Edge isolates.
create table public.whatsapp_operation_leases (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  operation_id uuid not null,
  expires_at timestamptz not null
);
alter table public.whatsapp_operation_leases enable row level security;
revoke all on public.whatsapp_operation_leases from public, anon, authenticated;
grant all on public.whatsapp_operation_leases to service_role;

create function public.whatsapp_claim_operation(p_workspace_id uuid, p_operation_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare claimed uuid;
begin
  insert into public.whatsapp_operation_leases values (p_workspace_id, p_operation_id, now() + interval '15 minutes')
  on conflict (workspace_id) do update set operation_id = excluded.operation_id, expires_at = excluded.expires_at
  where public.whatsapp_operation_leases.expires_at < now()
  returning operation_id into claimed;
  return claimed is not null;
end;
$$;

create function public.whatsapp_release_operation(p_workspace_id uuid, p_operation_id uuid)
returns void language sql security invoker set search_path = '' as $$
  delete from public.whatsapp_operation_leases where workspace_id = p_workspace_id and operation_id = p_operation_id;
$$;

-- Account and credentials commit together, before any provider can send callbacks.
create function public.whatsapp_save_session(p_workspace_id uuid, p_operation_id uuid, p_account jsonb, p_tokens jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare saved public.social_accounts;
begin
  perform 1 from public.whatsapp_operation_leases where workspace_id = p_workspace_id
    and operation_id = p_operation_id and expires_at > now() for update;
  if not found then raise exception 'WhatsApp operation lease expired'; end if;
  if coalesce(p_account->'metadata'->>'provider', '') not in ('evolution','waha','wppconnect')
    or length(coalesce(p_tokens->>'refresh_token', '')) < 32
    or coalesce(p_tokens->>'access_token', '') = '' then
    raise exception 'Invalid WhatsApp session credentials';
  end if;
  insert into public.social_accounts (workspace_id, platform, external_id, handle, display_name, status,
    needs_reconnect, metadata, last_sync_at, updated_at)
  values (p_workspace_id, 'whatsapp', p_account->>'external_id', p_account->>'handle', p_account->>'display_name',
    p_account->>'status', (p_account->>'needs_reconnect')::boolean, p_account->'metadata', now(), now())
  on conflict (workspace_id, platform) do update set
    external_id = excluded.external_id, handle = excluded.handle, display_name = excluded.display_name,
    status = excluded.status, needs_reconnect = excluded.needs_reconnect, metadata = excluded.metadata,
    last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at
  returning * into saved;
  insert into public.social_account_tokens (account_id, access_token, refresh_token, token_type, expires_at, updated_at)
  values (saved.id, p_tokens->>'access_token', p_tokens->>'refresh_token', p_tokens->>'token_type', null, now())
  on conflict (account_id) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
    token_type = excluded.token_type, expires_at = null, updated_at = now();
  return to_jsonb(saved);
end;
$$;

-- Row locking + secret fencing prevents stale callbacks and stale polls from
-- overwriting the metadata of a replacement session. Unknown timestamps are
-- accepted in arrival order; callbacks with source timestamps are monotonic.
create function public.whatsapp_apply_state(p_account_id uuid, p_secret text, p_patch jsonb,
  p_observed_at timestamptz, p_operation_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare saved public.social_accounts; token text; last_event timestamptz;
begin
  select * into saved from public.social_accounts where id = p_account_id and platform = 'whatsapp' for update;
  if not found then return null; end if;
  select refresh_token into token from public.social_account_tokens where account_id = p_account_id;
  if token is distinct from p_secret or coalesce(saved.metadata->>'session_active', 'true') = 'false' then return null; end if;
  if p_operation_id is not null then
    perform 1 from public.whatsapp_operation_leases where workspace_id = saved.workspace_id
      and operation_id = p_operation_id and expires_at > now();
    if not found then raise exception 'WhatsApp operation lease expired'; end if;
  end if;
  last_event := nullif(saved.metadata->>'state_observed_at', '')::timestamptz;
  if last_event is not null and p_observed_at <= last_event then return to_jsonb(saved); end if;
  update public.social_accounts set
    status = coalesce(p_patch->>'status', status),
    needs_reconnect = coalesce((p_patch->>'needs_reconnect')::boolean, needs_reconnect),
    external_id = coalesce(p_patch->>'external_id', external_id),
    handle = coalesce(p_patch->>'handle', handle), display_name = coalesce(p_patch->>'display_name', display_name),
    metadata = metadata || coalesce(p_patch->'metadata', '{}'::jsonb) || jsonb_build_object('state_observed_at', p_observed_at),
    last_sync_at = now(), updated_at = now()
  where id = p_account_id returning * into saved;
  return to_jsonb(saved);
end;
$$;

create function public.whatsapp_invalidate_session(p_account_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare saved public.social_accounts;
begin
  select * into saved from public.social_accounts where id = p_account_id and platform = 'whatsapp' for update;
  if not found then return null; end if;
  perform 1 from public.whatsapp_operation_leases where workspace_id = saved.workspace_id
    and operation_id = p_operation_id and expires_at > now();
  if not found then raise exception 'WhatsApp operation lease expired'; end if;
  update public.social_accounts set status = 'error', needs_reconnect = true,
    metadata = metadata || jsonb_build_object('session_active', false, 'provider_state', 'disconnected',
      'onboarding_state', 'disconnected', 'disconnected_at', now()), last_sync_at = now(), updated_at = now()
    where id = p_account_id returning * into saved;
  -- Invalidate callbacks without deleting the account or conversation history.
  update public.social_account_tokens set refresh_token = null, updated_at = now() where account_id = p_account_id;
  return to_jsonb(saved);
end;
$$;

revoke all on function public.whatsapp_claim_operation(uuid,uuid), public.whatsapp_release_operation(uuid,uuid),
  public.whatsapp_save_session(uuid,uuid,jsonb,jsonb), public.whatsapp_apply_state(uuid,text,jsonb,timestamptz,uuid),
  public.whatsapp_invalidate_session(uuid,uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_claim_operation(uuid,uuid), public.whatsapp_release_operation(uuid,uuid),
  public.whatsapp_save_session(uuid,uuid,jsonb,jsonb), public.whatsapp_apply_state(uuid,text,jsonb,timestamptz,uuid),
  public.whatsapp_invalidate_session(uuid,uuid) to service_role;
