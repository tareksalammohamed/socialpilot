import { useEffect, useState } from 'react';
import {
  ChevronRight, Plus, RefreshCw, Trash2, CheckCircle2, XCircle,
  CircleDashed, ChevronDown, Sparkles,
} from 'lucide-react';
import { Card, Button, Badge, Input, Select, ScreenLoader, ErrorBanner } from '@/components/ui';
import { aiAdmin, socialAdmin } from '@/lib/superAdmin';
import type { AiProvider, AiProviderKey, AiModel, AiRoutingPolicyValue, AiUsageSummary, SocialPlatformApp, SocialPlatformAppKey } from '@/lib/types';

const PROVIDER_KEYS: AiProviderKey[] = [
  'openrouter', 'huggingface', 'groq', 'gemini', 'cerebras', 'deepseek',
  'together', 'fireworks', 'mistral', 'anthropic', 'xai', 'cohere', 'openai',
];

const POLICY_OPTIONS: { value: AiRoutingPolicyValue; label: string }[] = [
  { value: 'smart_balanced', label: 'متوازن (افتراضي)' },
  { value: 'free_first', label: 'المجاني أولًا' },
  { value: 'lowest_cost', label: 'أقل تكلفة' },
  { value: 'best_quality', label: 'أفضل جودة' },
  { value: 'fastest', label: 'الأسرع' },
];

function statusBadge(status: AiProvider['status']) {
  if (status === 'connected') return <Badge color="brand">متصل</Badge>;
  if (status === 'error') return <Badge color="danger">خطأ</Badge>;
  return <Badge color="neutral">غير مُعد</Badge>;
}

export function SuperAdminScreen({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [policy, setPolicy] = useState<{ policy: AiRoutingPolicyValue; allow_paid_fallback: boolean } | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [expanded, setExpanded] = useState<AiProviderKey | null>(null);
  const [models, setModels] = useState<Record<string, AiModel[]>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<AiProviderKey | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');

  const [socialApps, setSocialApps] = useState<SocialPlatformApp[]>([]);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [socialBusyKey, setSocialBusyKey] = useState<SocialPlatformAppKey | null>(null);
  const [socialEditingKey, setSocialEditingKey] = useState<SocialPlatformAppKey | null>(null);
  const [socialAppIdInput, setSocialAppIdInput] = useState('');
  const [socialAppSecretInput, setSocialAppSecretInput] = useState('');

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [prov, pol, use] = await Promise.all([
        aiAdmin.listProviders(),
        aiAdmin.getRoutingPolicy(),
        aiAdmin.getUsageSummary(),
      ]);
      setProviders(prov.providers);
      setPolicy(pol.policy ?? { policy: 'smart_balanced', allow_paid_fallback: true });
      setUsage(use);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تحميل بيانات AI Control Center');
    } finally {
      setLoading(false);
    }
  }

  async function loadSocialApps() {
    setSocialError(null);
    try {
      const res = await socialAdmin.listApps();
      setSocialApps(res.apps);
    } catch (e) {
      setSocialError(e instanceof Error ? e.message : 'تعذّر تحميل تكاملات التواصل الاجتماعي');
    }
  }

  useEffect(() => {
    loadAll();
    loadSocialApps();
  }, []);

  function openSocialEdit(app: SocialPlatformApp) {
    setSocialEditingKey(app.platform_key);
    setSocialAppIdInput(app.app_id ?? '');
    setSocialAppSecretInput('');
  }

  async function handleSaveSocialApp(platformKey: SocialPlatformAppKey) {
    if (!socialAppIdInput.trim()) return;
    setSocialBusyKey(platformKey);
    setSocialError(null);
    try {
      await socialAdmin.saveApp(platformKey, socialAppIdInput.trim(), socialAppSecretInput.trim() || undefined);
      setSocialEditingKey(null);
      setSocialAppIdInput('');
      setSocialAppSecretInput('');
      await loadSocialApps();
    } catch (e) {
      setSocialError(e instanceof Error ? e.message : 'فشل حفظ إعدادات الربط');
    } finally {
      setSocialBusyKey(null);
    }
  }

  async function handleToggleSocialEnabled(app: SocialPlatformApp) {
    setSocialBusyKey(app.platform_key);
    try {
      await socialAdmin.setEnabled(app.platform_key, !app.enabled);
      await loadSocialApps();
    } finally {
      setSocialBusyKey(null);
    }
  }

  async function handleRemoveSocialApp(platformKey: SocialPlatformAppKey) {
    setSocialBusyKey(platformKey);
    try {
      await socialAdmin.removeApp(platformKey);
      await loadSocialApps();
    } finally {
      setSocialBusyKey(null);
    }
  }

  async function toggleExpand(key: AiProviderKey) {
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (!models[key]) {
      const res = await aiAdmin.listModels(key);
      setModels((m) => ({ ...m, [key]: res.models }));
    }
  }

  async function handleAddProvider(key: AiProviderKey) {
    if (!apiKeyInput.trim()) return;
    setBusyKey(key);
    setError(null);
    try {
      await aiAdmin.addProvider(key, apiKeyInput.trim());
      const testRes = await aiAdmin.testConnection(key);
      if (testRes.ok) {
        await aiAdmin.discoverModels(key);
      }
      setAddingKey(null);
      setApiKeyInput('');
      await loadAll();
      if (testRes.ok) {
        const res = await aiAdmin.listModels(key);
        setModels((m) => ({ ...m, [key]: res.models }));
        setExpanded(key);
      } else {
        setError(testRes.error ?? 'فشل الاتصال بالـ Provider — تحقق من الـ API Key');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشلت إضافة الـ Provider');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRefreshModels(key: AiProviderKey) {
    setBusyKey(key);
    setError(null);
    try {
      await aiAdmin.discoverModels(key);
      const res = await aiAdmin.listModels(key);
      setModels((m) => ({ ...m, [key]: res.models }));
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل اكتشاف الموديلات');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleToggleEnabled(p: AiProvider) {
    setBusyKey(p.provider_key);
    try {
      await aiAdmin.setEnabled(p.provider_key, !p.enabled);
      await loadAll();
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRemove(key: AiProviderKey) {
    setBusyKey(key);
    try {
      await aiAdmin.removeProvider(key);
      setModels((m) => ({ ...m, [key]: [] }));
      await loadAll();
    } finally {
      setBusyKey(null);
    }
  }

  async function handlePolicyChange(value: AiRoutingPolicyValue) {
    if (!policy) return;
    setPolicy({ ...policy, policy: value });
    await aiAdmin.setRoutingPolicy(value, policy.allow_paid_fallback);
  }

  async function handleAllowPaidToggle() {
    if (!policy) return;
    const next = !policy.allow_paid_fallback;
    setPolicy({ ...policy, allow_paid_fallback: next });
    await aiAdmin.setRoutingPolicy(policy.policy, next);
  }

  if (loading) return <ScreenLoader fullScreen label="جارٍ تحميل AI Control Center..." />;

  return (
    <div className="px-5 py-6 safe-top pb-24">
      <div className="flex items-center gap-2 mb-6">
        <button onClick={onBack} className="text-ink-400">
          <ChevronRight size={22} />
        </button>
        <h1 className="text-lg font-bold text-ink-50">AI Control Center</h1>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {/* Usage summary */}
      {usage && (
        <Card className="mb-5">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <p className="text-ink-50 font-bold text-lg">{usage.totals.requests}</p>
              <p className="text-ink-500 text-[10px] mt-0.5">طلبات</p>
            </div>
            <div>
              <p className="text-ink-50 font-bold text-lg">{usage.totals.tokens.toLocaleString('en-US')}</p>
              <p className="text-ink-500 text-[10px] mt-0.5">Tokens</p>
            </div>
            <div>
              <p className="text-ink-50 font-bold text-lg">${usage.totals.cost.toFixed(3)}</p>
              <p className="text-ink-500 text-[10px] mt-0.5">التكلفة</p>
            </div>
            <div>
              <p className="text-ink-50 font-bold text-lg">{usage.totals.fallbacks}</p>
              <p className="text-ink-500 text-[10px] mt-0.5">Fallbacks</p>
            </div>
          </div>
        </Card>
      )}

      {/* Routing policy */}
      {policy && (
        <div className="mb-5">
          <p className="text-ink-500 text-xs mb-2">سياسة التوجيه (Smart Routing)</p>
          <Card>
            <Select
              value={policy.policy}
              onChange={(v) => handlePolicyChange(v as AiRoutingPolicyValue)}
              options={POLICY_OPTIONS}
            />
            <button
              onClick={handleAllowPaidToggle}
              className="w-full flex items-center justify-between mt-3 pt-3 border-t border-ink-800"
            >
              <span className="text-ink-300 text-sm">السماح بالتحويل لموديل مدفوع عند فشل المجاني</span>
              <Badge color={policy.allow_paid_fallback ? 'brand' : 'neutral'}>
                {policy.allow_paid_fallback ? 'مفعّل' : 'معطّل'}
              </Badge>
            </button>
          </Card>
        </div>
      )}

      {/* Social Integrations */}
      <div className="mb-5">
        <p className="text-ink-500 text-xs mb-2">تكاملات التواصل الاجتماعي</p>
        {socialError && (
          <div className="mb-2">
            <ErrorBanner message={socialError} />
          </div>
        )}
        <div className="flex flex-col gap-2">
          {socialApps.map((app) => {
            const isEditing = socialEditingKey === app.platform_key;
            const busy = socialBusyKey === app.platform_key;
            return (
              <Card key={app.platform_key} className="!p-0 overflow-hidden">
                <button
                  onClick={() => (app.app_id ? openSocialEdit(app) : (isEditing ? setSocialEditingKey(null) : openSocialEdit(app)))}
                  className="w-full flex items-center justify-between p-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-ink-100 text-sm font-medium">{app.display_name}</span>
                    {app.status === 'connected' && <Badge color="brand">مُعد</Badge>}
                    {app.status === 'error' && <Badge color="danger">خطأ</Badge>}
                    {app.status === 'not_configured' && <Badge color="neutral">غير مُعد</Badge>}
                    {app.app_id && (
                      <Badge color={app.enabled ? 'brand' : 'neutral'}>{app.enabled ? 'مفعّل' : 'معطّل'}</Badge>
                    )}
                  </div>
                  <ChevronDown size={16} className={`text-ink-500 transition-transform ${isEditing ? 'rotate-180' : ''}`} />
                </button>

                {isEditing && (
                  <div className="px-4 pb-4 flex flex-col gap-2 animate-slide-up border-t border-ink-800 pt-3">
                    <Input
                      value={socialAppIdInput}
                      onChange={setSocialAppIdInput}
                      placeholder={app.platform_key === 'telegram' ? 'يوزر البوت (من غير @)' : 'App ID'}
                    />
                    <Input
                      value={socialAppSecretInput}
                      onChange={setSocialAppSecretInput}
                      placeholder={
                        app.platform_key === 'telegram'
                          ? app.has_secret
                            ? 'Bot Token (اتركه فاضي لو مش هتغيّره)'
                            : 'Bot Token'
                          : app.has_secret
                            ? 'App Secret (اتركه فاضي لو مش هتغيّره)'
                            : 'App Secret'
                      }
                      type="password"
                    />
                    {app.redirect_uri && (
                      <div className="bg-ink-900 rounded-lg p-2.5">
                        <p className="text-ink-500 text-[10px] mb-1">
                          Redirect URI — ضيفه في إعدادات تطبيق{' '}
                          {app.platform_key === 'linkedin'
                            ? 'LinkedIn Developer'
                            : app.platform_key === 'x'
                              ? 'X Developer Portal'
                              : 'Meta Developer'}
                        </p>
                        <p className="text-ink-300 text-xs break-all" dir="ltr">{app.redirect_uri}</p>
                      </div>
                    )}
                    {app.last_error && <ErrorBanner message={app.last_error} />}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleSaveSocialApp(app.platform_key)}
                        disabled={busy || !socialAppIdInput.trim()}
                      >
                        {busy ? '...جارٍ الحفظ' : 'حفظ'}
                      </Button>
                      {app.app_id && (
                        <Button size="sm" variant="secondary" onClick={() => handleToggleSocialEnabled(app)} disabled={busy}>
                          {app.enabled ? 'تعطيل' : 'تفعيل'}
                        </Button>
                      )}
                      {app.app_id && (
                        <Button size="sm" variant="danger" onClick={() => handleRemoveSocialApp(app.platform_key)} disabled={busy}>
                          إزالة
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => { setSocialEditingKey(null); setSocialAppIdInput(''); setSocialAppSecretInput(''); }}>
                        إلغاء
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
        <p className="text-ink-600 text-[11px] mt-2">
          تطبيق Meta الواحد بيغطي فيسبوك وإنستجرام معًا (Meta for Developers). تطبيق لينكدإن منفصل وبيغطي النشر على الحساب الشخصي فقط حاليًا (LinkedIn Developer Portal). ملحوظة: توكن لينكدإن بينتهي كل ٦٠ يوم ولازم إعادة ربط. تيليجرام مختلف: اعمل بوت من BotFather@ في تيليجرام، وحط يوزره في الحقل الأول وتوكنه في التاني — نفس البوت ده هيبقى محتاج كل مساحات العمل تضيفه Admin في قنواتها.
        </p>
      </div>

      {/* Providers */}
      <div className="mb-4">
        <p className="text-ink-500 text-xs mb-2">Providers</p>
        <div className="flex flex-col gap-2">
          {PROVIDER_KEYS.map((key) => {
            const p = providers.find((x) => x.provider_key === key);
            if (!p) return null;
            const isOpen = expanded === key;
            const isAdding = addingKey === key;
            const busy = busyKey === key;

            return (
              <Card key={key} className="!p-0 overflow-hidden">
                <button
                  onClick={() => (p.has_api_key ? toggleExpand(key) : setAddingKey(isAdding ? null : key))}
                  className="w-full flex items-center justify-between p-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-ink-100 text-sm font-medium">{p.display_name}</span>
                    {statusBadge(p.status)}
                    {p.has_api_key && (
                      <span className="text-ink-500 text-xs">
                        {p.healthy_models_count}/{p.models_count} موديل سليم
                      </span>
                    )}
                  </div>
                  <ChevronDown size={16} className={`text-ink-500 transition-transform ${isOpen || isAdding ? 'rotate-180' : ''}`} />
                </button>

                {isAdding && !p.has_api_key && (
                  <div className="px-4 pb-4 flex flex-col gap-2 animate-slide-up">
                    <Input value={apiKeyInput} onChange={setApiKeyInput} placeholder="API Key" type="password" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleAddProvider(key)} disabled={busy || !apiKeyInput.trim()}>
                        {busy ? '...جارٍ الاتصال' : 'حفظ واختبار واكتشاف الموديلات'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setAddingKey(null); setApiKeyInput(''); }}>
                        إلغاء
                      </Button>
                    </div>
                  </div>
                )}

                {isOpen && p.has_api_key && (
                  <div className="px-4 pb-4 flex flex-col gap-3 animate-slide-up border-t border-ink-800 pt-3">
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => handleToggleEnabled(p)} disabled={busy}>
                        {p.enabled ? 'تعطيل' : 'تفعيل'}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => handleRefreshModels(key)} disabled={busy}>
                        <span className="flex items-center gap-1">
                          <RefreshCw size={14} /> تحديث الموديلات
                        </span>
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => handleRemove(key)} disabled={busy}>
                        <span className="flex items-center gap-1">
                          <Trash2 size={14} /> إزالة
                        </span>
                      </Button>
                    </div>

                    {p.last_error && <ErrorBanner message={p.last_error} />}

                    <div className="flex flex-col gap-1.5">
                      {(models[key] ?? []).length === 0 && (
                        <p className="text-ink-500 text-xs">لا توجد موديلات مكتشفة بعد.</p>
                      )}
                      {(models[key] ?? []).map((m) => (
                        <div key={m.id} className="flex items-center justify-between py-1.5 border-b border-ink-800/60 last:border-0">
                          <div className="flex items-center gap-2 min-w-0">
                            {m.circuit_state === 'open' ? (
                              <XCircle size={14} className="text-danger-400 shrink-0" />
                            ) : m.status === 'healthy' ? (
                              <CheckCircle2 size={14} className="text-brand-400 shrink-0" />
                            ) : (
                              <CircleDashed size={14} className="text-warning-400 shrink-0" />
                            )}
                            <span className="text-ink-200 text-xs truncate" dir="ltr">{m.model_id}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {m.is_free && <Badge color="brand">مجاني</Badge>}
                            {m.vision && <Badge color="accent">Vision</Badge>}
                            {m.reasoning && <Badge color="neutral">Reasoning</Badge>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      <p className="text-ink-600 text-[11px] flex items-center gap-1.5 mt-2">
        <Sparkles size={12} /> النظام يختار ويبدّل الموديلات تلقائيًا — لا حاجة لاختيار Model يدويًا لأي عملية.
      </p>
      <div className="flex justify-center mt-2">
        <Button variant="ghost" size="sm" onClick={loadAll}>
          <span className="flex items-center gap-1"><Plus size={14} className="rotate-45" /> تحديث</span>
        </Button>
      </div>
    </div>
  );
}
