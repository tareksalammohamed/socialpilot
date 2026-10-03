\set ON_ERROR_STOP on
begin;
insert into public.workspaces values ('10000000-0000-0000-0000-000000000001');
set local role service_role;
do $$
declare
  ws uuid := '10000000-0000-0000-0000-000000000001';
  op uuid := '20000000-0000-0000-0000-000000000001';
  other_op uuid := '20000000-0000-0000-0000-000000000002';
  secret text := repeat('a',64);
  saved jsonb; original_id uuid; count_before integer;
  patch jsonb := '{"status":"error","needs_reconnect":true,"metadata":{"provider":"wppconnect","instance_name":"fixture","session_active":true,"preserved_setting":"keep"}}';
  credentials jsonb := jsonb_build_object('access_token','fixture-bearer','refresh_token',secret,'token_type','whatsapp_wppconnect');
begin
  assert public.whatsapp_claim_operation(ws,op), 'First operation must acquire lease';
  assert not public.whatsapp_claim_operation(ws,other_op), 'Concurrent owner must be rejected';
  perform public.whatsapp_release_operation(ws,other_op);
  assert not public.whatsapp_claim_operation(ws,other_op), 'A different owner cannot release a live lease';
  saved := public.whatsapp_save_session(ws,op,patch,credentials);
  original_id := (saved->>'id')::uuid;
  insert into public.inbox_conversations(account_id) values (original_id);
  -- Fail the token insert AFTER the account update. The entire save must roll back.
  begin
    perform public.whatsapp_save_session(ws,op,patch || '{"handle":"must-roll-back"}', credentials - 'token_type');
    raise exception 'Expected token constraint failure';
  exception when not_null_violation then null;
  end;
  assert (select handle is null from public.social_accounts where id=original_id), 'Account update must roll back with token failure';
  assert (select access_token='fixture-bearer' from public.social_account_tokens where account_id=original_id);
  saved := public.whatsapp_apply_state(original_id,secret,
    '{"status":"connected","needs_reconnect":false,"metadata":{"provider_state":"connected"}}',now(),op);
  assert saved->>'status'='connected';
  saved := public.whatsapp_apply_state(original_id,secret,
    '{"status":"error","metadata":{"provider_state":"old-disconnected"}}',now()-interval '10 seconds');
  assert saved->>'status'='connected', 'Old callback must not regress state';
  assert saved->'metadata'->>'preserved_setting'='keep', 'State patches must merge metadata';
  assert public.whatsapp_apply_state(original_id,repeat('b',64),'{"status":"error"}',now()) is null, 'Old/forged secret must be fenced';
  saved := public.whatsapp_invalidate_session(original_id,op);
  assert saved->'metadata'->>'session_active'='false';
  assert (select refresh_token is null from public.social_account_tokens where account_id=original_id);
  assert public.whatsapp_apply_state(original_id,secret,'{"status":"connected"}',now()) is null, 'Disconnected session must stay inactive';
  saved := public.whatsapp_save_session(ws,op,patch,credentials || jsonb_build_object('refresh_token',repeat('c',64)));
  assert (saved->>'id')::uuid=original_id, 'Reconnect must keep the account identity';
  select count(*) into count_before from public.inbox_conversations where account_id=original_id;
  assert count_before=1, 'Conversation history must survive reconnect';
  perform public.whatsapp_release_operation(ws,op);
  assert public.whatsapp_claim_operation(ws,other_op), 'Completed operation must release its lease';
  begin
    perform public.whatsapp_save_session(ws,op,patch,credentials);
    raise exception 'Expected expired-owner rejection';
  exception when raise_exception then
    if sqlerrm <> 'WhatsApp operation lease expired' then raise; end if;
  end;
end;
$$;
reset role;
do $$
begin
  assert not has_function_privilege('anon','public.whatsapp_save_session(uuid,uuid,jsonb,jsonb)','execute');
  assert not has_function_privilege('authenticated','public.whatsapp_claim_operation(uuid,uuid)','execute');
  assert not has_table_privilege('authenticated','public.whatsapp_operation_leases','select');
  assert (select relrowsecurity from pg_class where oid='public.whatsapp_operation_leases'::regclass);
end;
$$;
rollback;
