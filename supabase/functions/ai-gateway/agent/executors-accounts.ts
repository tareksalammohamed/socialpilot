import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const ACCOUNTS_TOOLS = new Set<ToolName>(['list_connected_accounts', 'check_account_status']);

export async function executeAccountsTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  if (call.name === 'list_connected_accounts') {
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id, platform, handle, display_name, status, needs_reconnect, last_sync_at')
      .eq('workspace_id', context.workspaceId);
    if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };
    return { callId: call.id, name: call.name, ok: true, output: { accounts: data ?? [] } };
  }

  // check_account_status
  const accountId = String(call.input.accountId ?? '');
  const platform = String(call.input.platform ?? '');
  if (!accountId && !platform) {
    return { callId: call.id, name: call.name, ok: false, error: 'محتاج accountId أو platform عشان أتحقق من حالة الحساب.' };
  }
  let query = supabase
    .from('social_accounts')
    .select('id, platform, handle, status, needs_reconnect, last_sync_at')
    .eq('workspace_id', context.workspaceId);
  query = accountId ? query.eq('id', accountId) : query.eq('platform', platform);
  const { data, error } = await query.maybeSingle();
  if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };
  if (!data) return { callId: call.id, name: call.name, ok: false, error: 'مفيش حساب متصل بالمواصفات دي.' };
  return { callId: call.id, name: call.name, ok: true, output: data };
}
