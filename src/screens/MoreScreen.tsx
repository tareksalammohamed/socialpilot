import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Settings,
  Brain,
  LogOut,
  Shield,
  TrendingUp,
  ChevronLeft,
  RefreshCw,
  CheckCircle2,
  Radio,
  CalendarDays,
  MessageSquareText,
  Send,
  Bot,
  Gauge,
  Phone,
  QrCode,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { checkIsSuperAdmin } from '@/lib/superAdmin';
import {
  startSocialOAuth,
  getTelegramBotInfo,
  connectTelegramChannel,
  syncAccounts,
  getSocialIntegrationStatus,
  listWhatsAppProviders,
  startWhatsAppProvider,
  getWhatsAppProviderStatus,
  disconnectWhatsAppProvider,
  type SocialIntegrationStatus,
  type WhatsAppProviderInfo,
  type WhatsAppProviderKey,
  type WhatsAppPairingMode,
} from '@/lib/api';
import { Card, Button, Badge, ErrorBanner, Input, Spinner } from '@/components/ui';
import { PLATFORMS, PLATFORM_META } from '@/lib/constants';
import {
  PLATFORM_CAPABILITIES,
  inboxCapabilityLabel,
  platformOperationalScore,
} from '@/lib/platformCapabilities';
import { SuperAdminScreen } from '@/screens/SuperAdminScreen';
import { AiUsageScreen } from '@/screens/AiUsageScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import type { SocialAccount, SocialPlatform, BrandDna, SocialPlatformAppKey } from '@/lib/types';

function formatSyncDate(value: string | null | undefined): string {
  if (!value) return 'لم تتم مزامنة بعد';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'غير معروف';
  return date.toLocaleString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function capabilityBadge(enabled: boolean, label: string) {
  return <Badge color={enabled ? 'brand' : 'neutral'}>{label}</Badge>;
}

function whatsappProviderLabel(provider: unknown): string {
  if (provider === 'waha') return 'WAHA';
  if (provider === 'wppconnect') return 'WPPConnect';
  if (provider === 'evolution') return 'Evolution';
  return 'WhatsApp Web';
}

export function MoreScreen() {
  const { workspace, signOut } = useAuth();
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [integrationApps, setIntegrationApps] = useState<SocialIntegrationStatus[]>([]);
  const [brandDna, setBrandDna] = useState<BrandDna | null>(null);
  const [showAccounts, setShowAccounts] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [showSuperAdmin, setShowSuperAdmin] = useState(false);
  const [showAiUsage, setShowAiUsage] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [connectingPlatform, setConnectingPlatform] = useState<SocialPlatform | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [telegramBotUsername, setTelegramBotUsername] = useState<string | null>(null);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegramInput, setTelegramInput] = useState('');
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [whatsappQrOpen, setWhatsappQrOpen] = useState(false);
  const [whatsappQrBase64, setWhatsappQrBase64] = useState<string | null>(null);
  const [whatsappPairingCode, setWhatsappPairingCode] = useState<string | null>(null);
  const [whatsappProviderState, setWhatsappProviderState] = useState<string>('not_created');
  const [whatsappProviders, setWhatsappProviders] = useState<WhatsAppProviderInfo[]>([]);
  const [whatsappSelectedProvider, setWhatsappSelectedProvider] = useState<WhatsAppProviderKey>('evolution');
  const [whatsappPairingMode, setWhatsappPairingMode] = useState<WhatsAppPairingMode>('qr');
  const [whatsappPhoneNumber, setWhatsappPhoneNumber] = useState('');
  const [accountSyncBusy, setAccountSyncBusy] = useState(false);

  const appStatusByKey = useMemo(() => {
    const map = new Map<string, SocialIntegrationStatus>();
    for (const app of integrationApps) map.set(app.platform_key, app);
    return map;
  }, [integrationApps]);

  const loadAccounts = useCallback(async () => {
    if (!workspace) return;
    const { data, error } = await supabase
      .from('social_accounts')
      .select('*')
      .eq('workspace_id', workspace.id)
      .order('platform');
    if (error) throw error;
    setAccounts((data as SocialAccount[]) ?? []);
  }, [workspace]);

  const loadIntegrationState = useCallback(async () => {
    if (!workspace) return;
    const result = await getSocialIntegrationStatus(workspace.id);
    setIntegrationApps(result.apps);
  }, [workspace]);

  const loadWhatsAppProviderState = useCallback(async () => {
    if (!workspace) return;
    const result = await listWhatsAppProviders(workspace.id);
    setWhatsappProviders(result.providers);
    if (result.activeProvider) {
      setWhatsappSelectedProvider(result.activeProvider);
    } else {
      const firstConfigured = [...result.providers]
        .sort((a, b) => a.fallbackOrder - b.fallbackOrder)
        .find((provider) => provider.configured);
      if (firstConfigured) setWhatsappSelectedProvider(firstConfigured.provider);
    }
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    void Promise.all([
      loadAccounts(),
      loadIntegrationState(),
      loadWhatsAppProviderState(),
      supabase.from('brand_dna').select('*').eq('workspace_id', workspace.id).maybeSingle(),
    ])
      .then(([, , , dna]) => setBrandDna(dna.data as BrandDna | null))
      .catch((error) => setConnectError(error instanceof Error ? error.message : 'تعذّر تحميل إعدادات التكاملات'));
  }, [workspace, loadAccounts, loadIntegrationState, loadWhatsAppProviderState]);

  useEffect(() => {
    void checkIsSuperAdmin().then(setIsSuperAdmin);
  }, []);

  useEffect(() => {
    void getTelegramBotInfo()
      .then((info) => setTelegramBotUsername(info.configured && info.enabled ? info.botUsername ?? null : null))
      .catch(() => setTelegramBotUsername(null));
  }, []);

  useEffect(() => {
    if (!workspace?.id || !whatsappQrOpen) return;
    let cancelled = false;
    let checking = false;

    const check = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const status = await getWhatsAppProviderStatus(workspace.id);
        if (cancelled) return;
        setWhatsappProviderState(status.state);
        if (status.connected) {
          setWhatsappQrOpen(false);
          setWhatsappQrBase64(null);
          setWhatsappPairingCode(null);
          setConnectNotice('تم ربط WhatsApp بالـQR وأصبح جاهزًا في Unified Inbox.');
          await Promise.all([loadAccounts(), loadIntegrationState(), loadWhatsAppProviderState()]);
        }
      } catch (error) {
        if (!cancelled) setConnectError(error instanceof Error ? error.message : 'تعذّر فحص حالة WhatsApp');
      } finally {
        checking = false;
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspace?.id, whatsappQrOpen, loadAccounts, loadIntegrationState, loadWhatsAppProviderState]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const social = params.get('social');
    if (!social) return;

    if (social === 'connected') {
      const platform = params.get('platform');
      const labels: Record<string, string> = {
        meta: 'Meta',
        facebook: 'فيسبوك',
        instagram: 'إنستجرام',
        linkedin: 'لينكدإن',
        x: 'إكس',
        threads: 'ثريدز',
        tiktok: 'تيك توك',
      };
      setConnectNotice(`تم الربط بنجاح${platform ? ` — ${labels[platform] ?? platform}` : ''}`);
      setShowAccounts(true);
      void Promise.all([loadAccounts(), loadIntegrationState(), loadWhatsAppProviderState()]);
    } else if (social === 'error') {
      setConnectError(params.get('message') ?? 'فشل ربط الحساب');
      setShowAccounts(true);
    }

    for (const key of ['social', 'platform', 'facebook', 'instagram', 'linkedin', 'x', 'threads', 'tiktok', 'message']) {
      params.delete(key);
    }
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
    window.history.replaceState({}, '', cleanUrl);
  }, [loadAccounts, loadIntegrationState, loadWhatsAppProviderState]);

  if (showSuperAdmin) return <SuperAdminScreen onBack={() => setShowSuperAdmin(false)} />;
  if (showAiUsage) return <AiUsageScreen onBack={() => setShowAiUsage(false)} />;
  if (showSettings) return <SettingsScreen onBack={() => setShowSettings(false)} />;

  const connectedAccounts = accounts.filter((account) => account.status === 'connected');
  const needsAttention = accounts.filter((account) => account.needs_reconnect || account.status === 'error' || account.status === 'expired');
  const operationalChannels = connectedAccounts.filter((account) => platformOperationalScore(account.platform) >= 3).length;

  function integrationReady(platform: SocialPlatform): boolean {
    const capability = PLATFORM_CAPABILITIES[platform];
    if (capability.connectMode === 'bot') return Boolean(telegramBotUsername);
    if (capability.connectMode === 'qr') {
      return platform === 'whatsapp' && whatsappProviders.some((provider) => provider.configured);
    }
    if (capability.connectMode !== 'oauth' || !capability.appKey) return false;
    const app = appStatusByKey.get(capability.appKey);
    return Boolean(app?.enabled && app?.configured);
  }

  async function togglePlatform(platform: SocialPlatform) {
    if (!workspace) return;
    const existing = accounts.find((account) => account.platform === platform);
    const capability = PLATFORM_CAPABILITIES[platform];

    if (existing?.status === 'connected') {
      setConnectingPlatform(platform);
      setConnectError(null);
      try {
        if (platform === 'whatsapp') {
          await disconnectWhatsAppProvider(workspace.id);
          setWhatsappQrOpen(false);
          setWhatsappQrBase64(null);
          setWhatsappPairingCode(null);
          setWhatsappProviderState('disconnected');
        } else {
          const { error } = await supabase.from('social_accounts').delete().eq('id', existing.id).eq('workspace_id', workspace.id);
          if (error) throw error;
        }
        setConnectNotice(`تم فصل ${PLATFORM_META[platform].label} من مساحة العمل`);
        await Promise.all([loadAccounts(), loadIntegrationState(), loadWhatsAppProviderState()]);
      } catch (error) {
        setConnectError(error instanceof Error ? error.message : 'تعذّر فصل الحساب');
      } finally {
        setConnectingPlatform(null);
      }
      return;
    }

    if (capability.connectMode === 'bot') {
      setConnectError(null);
      setConnectNotice(null);
      setTelegramOpen((open) => !open);
      return;
    }

    if (capability.connectMode === 'qr' && platform === 'whatsapp') {
      if (!integrationReady(platform)) {
        setConnectError('لا يوجد مزود WhatsApp جاهز. Super Admin لازم يجهّز Evolution أو WAHA أو WPPConnect أولًا.');
        return;
      }
      setConnectError(null);
      setConnectNotice(null);
      setConnectingPlatform('whatsapp');
      try {
        const selected = whatsappProviders.find((provider) => provider.provider === whatsappSelectedProvider);
        if (!selected?.configured) {
          throw new Error('المزود المختار غير مُعد في Super Admin. اختر مزودًا جاهزًا آخر.');
        }
        if (whatsappPairingMode === 'code' && whatsappSelectedProvider !== 'waha') {
          throw new Error('Pairing Code متاح مع WAHA فقط. اختر QR أو بدّل إلى WAHA.');
        }
        if (whatsappPairingMode === 'code' && !whatsappPhoneNumber.replace(/\D/g, '')) {
          throw new Error('اكتب رقم WhatsApp بكود الدولة لاستخدام Pairing Code.');
        }

        const result = await startWhatsAppProvider(workspace.id, whatsappSelectedProvider, {
          pairingMode: whatsappPairingMode,
          phoneNumber: whatsappPhoneNumber,
        });
        setWhatsappProviderState(result.state);
        if (result.provider) setWhatsappSelectedProvider(result.provider);
        if (result.connected) {
          setWhatsappQrOpen(false);
          setWhatsappQrBase64(null);
          setWhatsappPairingCode(null);
          setConnectNotice('WhatsApp متصل بالفعل وجاهز.');
          await Promise.all([loadAccounts(), loadWhatsAppProviderState()]);
        } else {
          setWhatsappQrBase64(result.qrBase64 ?? null);
          setWhatsappPairingCode(result.pairingCode ?? null);
          setWhatsappQrOpen(true);
          await Promise.all([loadAccounts(), loadWhatsAppProviderState()]);
        }
      } catch (error) {
        setConnectError(error instanceof Error ? error.message : 'تعذّر إنشاء QR لواتساب');
      } finally {
        setConnectingPlatform(null);
      }
      return;
    }

    if (capability.connectMode === 'managed') {
      setConnectError('هذه القناة تتم إدارتها من إعدادات النظام.');
      return;
    }

    if (capability.connectMode !== 'oauth' || !capability.appKey) {
      setConnectError('الربط المباشر غير متاح لهذه المنصة.');
      return;
    }

    if (!integrationReady(platform)) {
      const app = appStatusByKey.get(capability.appKey);
      setConnectError(
        app?.status === 'error' && app.last_error
          ? app.last_error
          : `تكامل ${PLATFORM_META[platform].label} يحتاج إعداد App ID/Secret وتفعيل من مركز الإدارة أولًا.`,
      );
      return;
    }

    setConnectError(null);
    setConnectNotice(null);
    setConnectingPlatform(platform);
    try {
      const url = await startSocialOAuth(
        workspace.id,
        capability.appKey as Exclude<SocialPlatformAppKey, 'telegram' | 'whatsapp' | 'whatsapp_waha' | 'whatsapp_wppconnect'>,
      );
      window.location.href = url;
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'تعذّر بدء عملية الربط');
      setConnectingPlatform(null);
    }
  }

  async function handleSyncAccounts() {
    if (!workspace) return;
    setAccountSyncBusy(true);
    setConnectError(null);
    setConnectNotice(null);
    try {
      const result = await syncAccounts(workspace.id);
      await loadAccounts();
      const failed = result.results.filter((item) => !item.ok);
      setConnectNotice(
        failed.length > 0
          ? `اكتملت المزامنة: ${result.synced - failed.length} سليم، ${failed.length} يحتاج مراجعة.`
          : `تم فحص ${result.synced} حساب بنجاح.`,
      );
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'فشلت مزامنة الحسابات');
    } finally {
      setAccountSyncBusy(false);
    }
  }

  async function handleConnectTelegram() {
    if (!workspace || !telegramInput.trim()) return;
    setTelegramBusy(true);
    setConnectError(null);
    try {
      await connectTelegramChannel(workspace.id, telegramInput.trim());
      setTelegramInput('');
      setTelegramOpen(false);
      setConnectNotice('تم ربط تيليجرام وتفعيل مسار الـInbox.');
      await Promise.all([loadAccounts(), loadIntegrationState(), loadWhatsAppProviderState()]);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'تعذّر ربط تيليجرام');
    } finally {
      setTelegramBusy(false);
    }
  }

  return (
    <div className="page-shell safe-top pb-28">
      <section className="surface-hero mb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow">CONTROL CENTER</p>
            <h1 className="text-2xl font-bold text-ink-50 mt-1">التكاملات والنظام</h1>
            <p className="text-ink-400 text-sm mt-2 max-w-xl">
              حالة الحسابات وقدرات النشر والجدولة والـInbox في مكان واحد.
            </p>
          </div>
          <div className="status-orb">
            <Radio size={20} className={needsAttention.length ? 'text-warning-400' : 'text-brand-300'} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-5">
          <div className="metric-tile">
            <p className="metric-value">{connectedAccounts.length}</p>
            <p className="metric-label">حساب متصل</p>
          </div>
          <div className="metric-tile">
            <p className="metric-value">{operationalChannels}</p>
            <p className="metric-label">قناة تشغيل كاملة</p>
          </div>
          <div className="metric-tile">
            <p className={`metric-value ${needsAttention.length ? 'text-warning-300' : ''}`}>{needsAttention.length}</p>
            <p className="metric-label">تحتاج انتباه</p>
          </div>
        </div>
      </section>

      {connectError && <div className="mb-3"><ErrorBanner message={connectError} /></div>}
      {connectNotice && (
        <div className="notice-success mb-3">
          <CheckCircle2 size={16} />
          <span>{connectNotice}</span>
        </div>
      )}

      <section className="mb-5">
        <div className="section-heading">
          <div>
            <p className="eyebrow">BRAND & AUTOMATION</p>
            <h2 className="section-title">جاهزية مساحة العمل</h2>
          </div>
          <Badge color={brandDna?.status === 'confirmed' ? 'brand' : 'warning'}>
            {brandDna?.status === 'confirmed' ? 'Brand DNA جاهز' : 'Brand DNA يحتاج إكمال'}
          </Badge>
        </div>
        <Card className="surface-card">
          <div className="flex items-center gap-3">
            <div className="icon-well"><Brain size={20} className="text-brand-300" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-ink-100 font-semibold">Brand Intelligence</p>
              <p className="text-ink-500 text-xs mt-1">
                {brandDna?.status === 'confirmed'
                  ? 'النبرة والهوية جاهزتان لاستخدامهما في التأليف والردود.'
                  : 'كمّل Brand DNA عشان الـAI يكتب ويرد بنفس شخصية البراند.'}
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section className="mb-5">
        <div className="section-heading">
          <button onClick={() => setShowAccounts((value) => !value)} className="text-right flex-1">
            <p className="eyebrow">CHANNEL OPERATIONS</p>
            <h2 className="section-title">القنوات والحسابات</h2>
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSyncAccounts()}
              disabled={accountSyncBusy}
              className="!px-2.5"
            >
              <RefreshCw size={14} className={accountSyncBusy ? 'animate-spin' : ''} />
            </Button>
            <button
              onClick={() => setShowAccounts((value) => !value)}
              className="p-2 rounded-lg hover:bg-ink-800 transition-colors"
              aria-label={showAccounts ? 'إخفاء القنوات' : 'إظهار القنوات'}
            >
              <ChevronLeft size={18} className={`text-ink-500 transition-transform ${showAccounts ? '-rotate-90' : ''}`} />
            </button>
          </div>
        </div>

        {showAccounts && (
          <div className="grid gap-3 lg:grid-cols-2">
            {PLATFORMS.map((platform) => {
              const meta = PLATFORM_META[platform];
              const Icon = meta.icon;
              const capability = PLATFORM_CAPABILITIES[platform];
              const account = accounts.find((item) => item.platform === platform);
              const connected = account?.status === 'connected';
              const ready = integrationReady(platform);
              const busy = connectingPlatform === platform;
              const inboxEnabled = capability.inbox !== 'none';
              const app = capability.appKey ? appStatusByKey.get(capability.appKey) : undefined;

              let stateLabel = 'غير متصل';
              let stateColor: 'neutral' | 'brand' | 'warning' | 'danger' | 'accent' = 'neutral';
              if (connected) {
                stateLabel = 'متصل';
                stateColor = 'brand';
              } else if (platform === 'whatsapp' && account?.metadata?.onboarding_state === 'scan_qr') {
                stateLabel = 'بانتظار QR';
                stateColor = 'warning';
              } else if (account?.status === 'expired') {
                stateLabel = 'انتهت الصلاحية';
                stateColor = 'warning';
              } else if (account?.status === 'error') {
                stateLabel = 'خطأ';
                stateColor = 'danger';
              } else if ((capability.connectMode === 'oauth' || capability.connectMode === 'bot' || capability.connectMode === 'qr') && !ready) {
                stateLabel = 'يحتاج إعداد';
                stateColor = 'warning';
              } else if (capability.connectMode === 'managed') {
                stateLabel = 'قناة رسائل';
                stateColor = 'accent';
              }

              return (
                <Card key={platform} className="surface-card !p-0 overflow-hidden">
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="platform-icon" style={{ borderColor: `${meta.color}55` }}>
                          <Icon size={20} style={{ color: meta.color }} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-ink-100 text-sm font-semibold">{meta.label}</p>
                            <Badge color={stateColor}>{stateLabel}</Badge>
                            {platform === 'whatsapp' && account?.metadata?.provider && (
                              <Badge color="neutral">{whatsappProviderLabel(account.metadata.provider)}</Badge>
                            )}
                          </div>
                          <p className="text-ink-500 text-xs mt-1 truncate">
                            {account?.display_name || account?.handle || capability.note}
                          </p>
                        </div>
                      </div>

                      {capability.connectMode !== 'managed' && (
                        <Button
                          variant={connected ? 'danger' : 'secondary'}
                          size="sm"
                          onClick={() => void togglePlatform(platform)}
                          disabled={busy || (!connected && (capability.connectMode === 'oauth' || capability.connectMode === 'qr') && !ready)}
                        >
                          {connected
                            ? 'فصل'
                            : platform === 'whatsapp' && account?.status === 'error'
                              ? 'إعادة الربط'
                              : busy
                                ? 'جارٍ الربط...'
                                : 'ربط'}
                        </Button>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5 mt-4">
                      {capabilityBadge(capability.publish, 'نشر')}
                      {capabilityBadge(capability.schedule, 'جدولة')}
                      {capabilityBadge(inboxEnabled, inboxCapabilityLabel(capability.inbox))}
                      {capabilityBadge(capability.aiReply, 'AI Reply')}
                    </div>

                    <div className="mt-3 pt-3 border-t border-ink-800/80 flex items-center justify-between gap-3">
                      <p className="text-ink-600 text-[11px] leading-relaxed">{capability.note}</p>
                      {account?.last_sync_at && (
                        <span className="text-ink-600 text-[10px] whitespace-nowrap">{formatSyncDate(account.last_sync_at)}</span>
                      )}
                    </div>

                    {!connected && capability.connectMode === 'oauth' && app && !ready && (
                      <div className="mt-3 rounded-xl bg-warning-500/10 border border-warning-500/20 px-3 py-2 text-warning-300 text-[11px]">
                        التكامل موجود لكن يحتاج App ID/Secret وتفعيل من Super Admin.
                      </div>
                    )}

                    {platform === 'tiktok' && connected && (
                      <div className="mt-3 rounded-xl bg-accent-500/10 border border-accent-500/20 px-3 py-2 text-accent-300 text-[11px]">
                        الحساب مربوط. النشر المباشر يظل مقيدًا بمتطلبات TikTok للـContent Posting API وخصوصية المستخدم والميديا.
                      </div>
                    )}

                    {platform === 'whatsapp' && !connected && ready && (
                      <div className="mt-3 rounded-2xl border border-ink-800 bg-ink-950/45 p-3 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold text-ink-100">طرق ربط WhatsApp</p>
                            <p className="text-[10px] text-ink-500 mt-1">
                              Evolution أساسي، WAHA بديل مع QR/Pairing Code، وWPPConnect مسار Recovery إضافي.
                            </p>
                          </div>
                          <Badge color="neutral">{whatsappProviders.filter((item) => item.configured).length} جاهز</Badge>
                        </div>

                        <div className="grid gap-2 sm:grid-cols-3">
                          {[...whatsappProviders]
                            .sort((a, b) => a.fallbackOrder - b.fallbackOrder)
                            .map((provider) => {
                              const selected = whatsappSelectedProvider === provider.provider;
                              return (
                                <button
                                  key={provider.provider}
                                  type="button"
                                  disabled={!provider.configured || busy}
                                  onClick={() => {
                                    setWhatsappSelectedProvider(provider.provider);
                                    setWhatsappPairingMode('qr');
                                    setWhatsappQrOpen(false);
                                    setWhatsappQrBase64(null);
                                    setWhatsappPairingCode(null);
                                    setConnectError(null);
                                  }}
                                  className={`rounded-xl border px-3 py-2.5 text-right transition-colors ${
                                    selected
                                      ? 'border-brand-500/50 bg-brand-500/10'
                                      : 'border-ink-800 bg-ink-900/70 hover:border-ink-700'
                                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-semibold text-ink-100">{provider.displayName}</span>
                                    <span className={`w-2 h-2 rounded-full ${provider.configured ? 'bg-accent-400' : 'bg-ink-700'}`} />
                                  </div>
                                  <p className="text-[10px] text-ink-500 mt-1">
                                    {provider.recommended ? 'أساسي' : provider.provider === 'waha' ? 'Fallback 1' : 'Fallback 2'}
                                    {' · '}
                                    {provider.configured ? 'جاهز' : 'غير مُعد'}
                                  </p>
                                </button>
                              );
                            })}
                        </div>

                        {whatsappProviders.find((item) => item.provider === whatsappSelectedProvider)?.methods.includes('code') && (
                          <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
                            <select
                              value={whatsappPairingMode}
                              onChange={(event) => setWhatsappPairingMode(event.target.value as WhatsAppPairingMode)}
                              className="rounded-xl border border-ink-800 bg-ink-900 px-3 py-2.5 text-xs text-ink-100"
                            >
                              <option value="qr">QR Code</option>
                              <option value="code">Pairing Code</option>
                            </select>
                            {whatsappPairingMode === 'code' && (
                              <Input
                                value={whatsappPhoneNumber}
                                onChange={setWhatsappPhoneNumber}
                                placeholder="رقم الهاتف بكود الدولة — مثال 2010xxxxxxx"
                              />
                            )}
                          </div>
                        )}

                        {!whatsappQrOpen && (
                          <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 px-3 py-2 text-[11px] text-brand-200 flex items-start gap-2">
                            <QrCode size={14} className="mt-0.5 shrink-0" />
                            <span>
                              اختر المزود ثم اضغط «{account?.status === 'error' ? 'إعادة الربط' : 'ربط'}».
                              التبديل لمزود آخر يحتاج Pair جديد لكنه يحافظ على تاريخ Unified Inbox.
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {platform === 'whatsapp' && !connected && !ready && (
                      <div className="mt-3 rounded-xl bg-warning-500/10 border border-warning-500/20 px-3 py-2 text-warning-300 text-[11px]">
                        لا يوجد مزود WhatsApp جاهز. جهّز Evolution أو WAHA أو WPPConnect من Super Admin، وبعدها الربط للمستخدم يتم من هنا فقط.
                      </div>
                    )}

                    {platform === 'whatsapp' && !connected && whatsappQrOpen && (
                      <div className="mt-3 rounded-2xl border border-brand-500/20 bg-ink-950/55 p-4 animate-slide-up">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2">
                            <QrCode size={17} className="text-brand-300" />
                            <div>
                              <p className="text-ink-100 text-xs font-semibold">
                                {whatsappPairingCode ? 'أدخل Pairing Code في WhatsApp' : 'امسح QR من WhatsApp'}
                                {' · '}{whatsappProviderLabel(whatsappSelectedProvider)}
                              </p>
                              <p className="text-ink-500 text-[10px] mt-0.5">الحالة: {whatsappProviderState}</p>
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => void togglePlatform('whatsapp')} disabled={busy}>
                            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
                            تحديث QR
                          </Button>
                        </div>

                        {whatsappQrBase64 ? (
                          <div className="mx-auto w-fit rounded-2xl bg-white p-3">
                            <img
                              src={whatsappQrBase64.startsWith('data:') ? whatsappQrBase64 : `data:image/png;base64,${whatsappQrBase64}`}
                              alt="WhatsApp QR"
                              className="w-56 h-56 sm:w-64 sm:h-64"
                            />
                          </div>
                        ) : whatsappPairingCode ? (
                          <div className="rounded-xl bg-ink-900 border border-ink-800 p-4 text-center">
                            <p className="text-ink-500 text-xs">Pairing code</p>
                            <p className="text-2xl tracking-[0.25em] font-bold text-brand-300 mt-2" dir="ltr">{whatsappPairingCode}</p>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-2 py-8 text-ink-500 text-xs">
                            <Spinner size={16} /> جارٍ تجهيز QR...
                          </div>
                        )}

                        <div className="mt-3 flex items-start gap-2 text-[11px] text-ink-500 leading-relaxed">
                          <Phone size={14} className="mt-0.5 shrink-0" />
                          <span>من الهاتف: WhatsApp → الإعدادات → الأجهزة المرتبطة → ربط جهاز. الاتصال يُحدّث تلقائيًا بدون Refresh للصفحة.</span>
                        </div>
                      </div>
                    )}

                    {platform === 'whatsapp' && connected && (
                      <div className="mt-3 rounded-xl bg-brand-500/5 border border-brand-500/20 px-3 py-2 text-brand-200 text-[11px] flex items-center gap-2">
                        <Wifi size={14} />
                        WhatsApp Web متصل عبر {whatsappProviderLabel(account?.metadata?.provider)}. الرسائل والميديا والـAI Reply تعمل من Unified Inbox.
                      </div>
                    )}

                    {platform === 'whatsapp' && !connected && account?.status === 'error' && (
                      <div className="mt-3 rounded-xl bg-warning-500/10 border border-warning-500/20 px-3 py-2 text-warning-300 text-[11px] flex items-start gap-2">
                        <WifiOff size={14} className="mt-0.5 shrink-0" />
                        <span>
                          جلسة {whatsappProviderLabel(account?.metadata?.provider)} غير متصلة. اختر نفس المزود لإعادة الربط أو اختر مزودًا بديلًا جاهزًا؛ تاريخ المحادثات لن يُحذف.
                        </span>
                      </div>
                    )}

                    {platform === 'telegram' && !connected && ready && telegramOpen && (
                      <div className="mt-3 pt-3 border-t border-ink-800 flex flex-col gap-2 animate-slide-up">
                        <div className="flex items-center gap-2 text-ink-400 text-xs">
                          <Bot size={14} />
                          <span>
                            أضف <span dir="ltr" className="text-ink-200">@{telegramBotUsername}</span> كـAdmin ثم اكتب يوزر القناة/السوبرجروب.
                          </span>
                        </div>
                        <Input value={telegramInput} onChange={setTelegramInput} placeholder="@channel_username" />
                        <Button size="sm" onClick={() => void handleConnectTelegram()} disabled={telegramBusy || !telegramInput.trim()}>
                          {telegramBusy ? 'جارٍ التحقق...' : 'تأكيد الربط وتفعيل Inbox'}
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mb-5">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SYSTEM</p>
            <h2 className="section-title">الإدارة والمتابعة</h2>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <Card onClick={() => setShowAiUsage(true)} className="surface-card">
            <div className="flex items-center gap-3">
              <div className="icon-well"><TrendingUp size={19} className="text-accent-400" /></div>
              <div>
                <p className="text-ink-100 text-sm font-semibold">AI Usage</p>
                <p className="text-ink-500 text-xs mt-1">الاستهلاك والتكلفة ومراقبة التشغيل</p>
              </div>
            </div>
          </Card>

          <Card onClick={() => setShowSettings(true)} className="surface-card">
            <div className="flex items-center gap-3">
              <div className="icon-well"><Settings size={19} className="text-ink-300" /></div>
              <div>
                <p className="text-ink-100 text-sm font-semibold">إعدادات مساحة العمل</p>
                <p className="text-ink-500 text-xs mt-1">البراند والـAI وخيارات التشغيل</p>
              </div>
            </div>
          </Card>

          {isSuperAdmin && (
            <Card onClick={() => setShowSuperAdmin(true)} className="surface-card md:col-span-2">
              <div className="flex items-center gap-3">
                <div className="icon-well"><Shield size={19} className="text-brand-300" /></div>
                <div className="flex-1">
                  <p className="text-ink-100 text-sm font-semibold">Platform & AI Control Center</p>
                  <p className="text-ink-500 text-xs mt-1">Providers، مفاتيح المنصات، OAuth وسياسات التشغيل.</p>
                </div>
                <Gauge size={18} className="text-ink-600" />
              </div>
            </Card>
          )}
        </div>
      </section>

      <div className="grid grid-cols-3 gap-2 mb-5">
        <div className="capability-summary">
          <Send size={15} />
          <span>نشر موحّد</span>
        </div>
        <div className="capability-summary">
          <CalendarDays size={15} />
          <span>Scheduler</span>
        </div>
        <div className="capability-summary">
          <MessageSquareText size={15} />
          <span>Unified Inbox</span>
        </div>
      </div>

      <Button variant="ghost" size="lg" onClick={signOut} className="w-full text-danger-400">
        <span className="flex items-center justify-center gap-2"><LogOut size={18} /> تسجيل الخروج</span>
      </Button>
    </div>
  );
}
