import { useState, useEffect, useCallback } from 'react';
import { Settings, Brain, Link2, LogOut, Shield, TrendingUp, ChevronLeft, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { checkIsSuperAdmin } from '@/lib/superAdmin';
import { startSocialOAuth, getTelegramBotInfo, connectTelegramChannel, syncAccounts } from '@/lib/api';
import { Card, Button, Badge, ErrorBanner, Input } from '@/components/ui';
import { PLATFORMS, PLATFORM_META } from '@/lib/constants';
import { SuperAdminScreen } from '@/screens/SuperAdminScreen';
import { AiUsageScreen } from '@/screens/AiUsageScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import type { SocialAccount, SocialPlatform, BrandDna } from '@/lib/types';

// Only these platforms have a real OAuth flow wired up so far. facebook +
// instagram share the Meta app; linkedin and x each have their own app.
// The rest still show in the list but are marked "قريبًا" until their own
// OAuth integration is built.
const OAUTH_READY_PLATFORMS = new Set<SocialPlatform>(['facebook', 'instagram', 'linkedin', 'x']);

// Telegram doesn't use redirect OAuth — it connects via a shared bot that
// the workspace adds as admin to their channel (see social-telegram-connect).
const BOT_READY_PLATFORMS = new Set<SocialPlatform>(['telegram']);

// Maps a connectable platform to the social_platform_apps row that drives
// its OAuth flow (facebook/instagram share the single "meta" app).
const PLATFORM_APP_KEY: Partial<Record<SocialPlatform, 'meta' | 'linkedin' | 'x'>> = {
  facebook: 'meta',
  instagram: 'meta',
  linkedin: 'linkedin',
  x: 'x',
};

export function MoreScreen() {
  const { workspace, signOut } = useAuth();
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [brandDna, setBrandDna] = useState<BrandDna | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
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
  const [accountSyncBusy, setAccountSyncBusy] = useState(false);

  const loadAccounts = useCallback(async () => {
    if (!workspace) return;
    const { data } = await supabase.from('social_accounts').select('*').eq('workspace_id', workspace.id);
    setAccounts((data as SocialAccount[]) ?? []);
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    (async () => {
      await loadAccounts();
      const dna = await supabase.from('brand_dna').select('*').eq('workspace_id', workspace.id).maybeSingle();
      setBrandDna(dna.data as BrandDna | null);
    })();
  }, [workspace, loadAccounts]);

  useEffect(() => {
    checkIsSuperAdmin().then(setIsSuperAdmin);
  }, []);

  useEffect(() => {
    getTelegramBotInfo()
      .then((info) => setTelegramBotUsername(info.configured && info.enabled ? info.botUsername ?? null : null))
      .catch(() => setTelegramBotUsername(null));
  }, []);

  // Handle the redirect back from social-oauth-callback (?social=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const social = params.get('social');
    if (!social) return;

    if (social === 'connected') {
      const fb = Number(params.get('facebook') ?? 0);
      const ig = Number(params.get('instagram') ?? 0);
      const li = Number(params.get('linkedin') ?? 0);
      const x = Number(params.get('x') ?? 0);
      setConnectNotice(
        fb || ig || li || x
          ? `تم الربط بنجاح${fb ? ' — فيسبوك' : ''}${ig ? ' — إنستجرام' : ''}${li ? ' — لينكدإن' : ''}${x ? ' — إكس' : ''}`
          : 'تم الربط بنجاح'
      );
      setShowAccounts(true);
      loadAccounts();
    } else if (social === 'error') {
      setConnectError(params.get('message') ?? 'فشل ربط الحساب');
      setShowAccounts(true);
    }

    params.delete('social');
    params.delete('platform');
    params.delete('facebook');
    params.delete('instagram');
    params.delete('linkedin');
    params.delete('x');
    params.delete('message');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
    window.history.replaceState({}, '', cleanUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (showSuperAdmin) {
    return <SuperAdminScreen onBack={() => setShowSuperAdmin(false)} />;
  }

  if (showAiUsage) {
    return <AiUsageScreen onBack={() => setShowAiUsage(false)} />;
  }

  if (showSettings) {
    return <SettingsScreen onBack={() => setShowSettings(false)} />;
  }

  async function togglePlatform(platform: SocialPlatform) {
    if (!workspace) return;
    const existing = accounts.find((a) => a.platform === platform);
    const isConnected = existing?.status === 'connected';

    if (existing && isConnected) {
      await supabase.from('social_accounts').delete().eq('id', existing.id);
      setAccounts(accounts.filter((a) => a.id !== existing.id));
      return;
    }

    if (BOT_READY_PLATFORMS.has(platform)) {
      setConnectError(null);
      setConnectNotice(null);
      setTelegramOpen((open) => !open);
      return;
    }

    if (!OAUTH_READY_PLATFORMS.has(platform)) return; // "قريبًا" — لسه مفيش OAuth لها
    const appKey = PLATFORM_APP_KEY[platform] ?? 'meta';

    setConnectError(null);
    setConnectNotice(null);
    setConnectingPlatform(platform);
    try {
      const url = await startSocialOAuth(workspace.id, appKey);
      window.location.href = url;
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'تعذّر بدء عملية الربط');
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
          ? `اكتملت المزامنة جزئيًا: ${result.synced - failed.length} ناجح، ${failed.length} يحتاج مراجعة.`
          : `تم فحص ${result.synced} حساب${result.synced === 1 ? '' : 'ات'} بنجاح.`
      );
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'فشلت مزامنة الحسابات');
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
      setConnectNotice('تم الربط بنجاح — تيليجرام');
      await loadAccounts();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'تعذّر ربط قناة تيليجرام');
    } finally {
      setTelegramBusy(false);
    }
  }

  return (
    <div className="px-5 py-6 safe-top">
      <h1 className="text-lg font-bold text-ink-50 mb-6">المزيد</h1>

      {/* Brand Brain status */}
      <div className="mb-4">
        <p className="text-ink-500 text-xs mb-2">عقل البراند</p>
        <Card>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/15 flex items-center justify-center">
                <Brain size={20} className="text-brand-400" />
              </div>
              <div>
                <p className="text-ink-100 text-sm font-medium">Brand DNA</p>
                <p className="text-ink-500 text-xs mt-0.5">
                  {brandDna?.status === 'confirmed' ? 'مؤكدة وجاهزة' : 'تحتاج إكمال'}
                </p>
              </div>
            </div>
            <Badge color={brandDna?.status === 'confirmed' ? 'brand' : 'warning'}>
              {brandDna?.status === 'confirmed' ? 'نشط' : 'مسودة'}
            </Badge>
          </div>
        </Card>
      </div>

      {/* Social Accounts */}
      <div className="mb-4">
        <button
          onClick={() => setShowAccounts(!showAccounts)}
          className="w-full"
        >
          <Card onClick={() => setShowAccounts(!showAccounts)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent-500/15 flex items-center justify-center">
                  <Link2 size={20} className="text-accent-400" />
                </div>
                <div>
                  <p className="text-ink-100 text-sm font-medium">الحسابات</p>
                  <p className="text-ink-500 text-xs mt-0.5">
                    {accounts.filter((a) => a.status === 'connected').length} مربوط
                  </p>
                </div>
              </div>
              <ChevronLeft
                size={18}
                className={`text-ink-500 transition-transform ${showAccounts ? '-rotate-90' : ''}`}
              />
            </div>
          </Card>
        </button>

        {showAccounts && (
          <div className="mt-2 flex flex-col gap-2 animate-slide-up">
            {connectError && <ErrorBanner message={connectError} />}
            {connectNotice && (
              <div className="bg-brand-500/10 border border-brand-500/30 text-brand-300 text-sm rounded-xl px-4 py-3">
                {connectNotice}
              </div>
            )}
            <Button variant="secondary" size="sm" onClick={handleSyncAccounts} disabled={accountSyncBusy}>
              <RefreshCw size={14} className={accountSyncBusy ? 'animate-spin' : ''} />
              {accountSyncBusy ? '...جارٍ الفحص' : 'فحص الحسابات الآن'}
            </Button>
            {PLATFORMS.map((platform) => {
              const meta = PLATFORM_META[platform];
              const Icon = meta.icon;
              const acc = accounts.find((a) => a.platform === platform);
              const isBotPlatform = BOT_READY_PLATFORMS.has(platform);
              const botConfigured = isBotPlatform && !!telegramBotUsername;
              const ready = OAUTH_READY_PLATFORMS.has(platform) || botConfigured;
              const isConnected = acc?.status === 'connected';
              const busy = connectingPlatform === platform;
              return (
                <Card key={platform}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Icon size={20} style={{ color: meta.color }} />
                      <span className="text-ink-200 text-sm">{meta.label}</span>
                      {acc && (
                        <Badge color={acc.status === 'connected' ? 'brand' : 'neutral'}>
                          {acc.status === 'connected' ? 'مربوط' : 'غير مربوط'}
                        </Badge>
                      )}
                      {!acc && !ready && <Badge color="neutral">قريبًا</Badge>}
                    </div>
                    <Button
                      variant={isConnected ? 'danger' : 'secondary'}
                      size="sm"
                      onClick={() => togglePlatform(platform)}
                      disabled={busy || (!isConnected && !ready)}
                    >
                      {isConnected ? 'إزالة' : busy ? '...جارٍ التحويل' : 'ربط'}
                    </Button>
                  </div>

                  {isBotPlatform && !acc && botConfigured && telegramOpen && (
                    <div className="mt-3 pt-3 border-t border-ink-800 flex flex-col gap-2 animate-slide-up">
                      <p className="text-ink-500 text-xs leading-relaxed">
                        ضيف البوت{' '}
                        <span className="text-ink-200" dir="ltr">@{telegramBotUsername}</span>{' '}
                        كـ Admin (بصلاحية النشر) في قناتك، وبعدين اكتب يوزر القناة هنا.
                      </p>
                      <Input
                        value={telegramInput}
                        onChange={setTelegramInput}
                        placeholder="channel_username@"
                      />
                      <Button size="sm" onClick={handleConnectTelegram} disabled={telegramBusy || !telegramInput.trim()}>
                        {telegramBusy ? '...جارٍ التحقق' : 'تأكيد الربط'}
                      </Button>
                    </div>
                  )}

                  {isBotPlatform && !acc && !botConfigured && (
                    <p className="text-ink-600 text-[11px] mt-2">لسه مفيش بوت تيليجرام مُفعّل من إدارة النظام.</p>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* System info */}
      <div className="mb-4">
        <p className="text-ink-500 text-xs mb-2">النظام</p>
        <div className="flex flex-col gap-2">
          <Card onClick={() => setShowAiUsage(true)}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-ink-800 flex items-center justify-center">
                <TrendingUp size={20} className="text-ink-400" />
              </div>
              <div>
                <p className="text-ink-100 text-sm font-medium">AI Usage</p>
                <p className="text-ink-500 text-xs mt-0.5">استهلاك وتكلفة الذكاء الاصطناعي</p>
              </div>
            </div>
          </Card>

          {isSuperAdmin && (
            <Card onClick={() => setShowSuperAdmin(true)}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-ink-800 flex items-center justify-center">
                  <Shield size={20} className="text-ink-400" />
                </div>
                <div>
                  <p className="text-ink-100 text-sm font-medium">AI Control Center</p>
                  <p className="text-ink-500 text-xs mt-0.5">Super Admin — Providers والموديلات والتوجيه</p>
                </div>
              </div>
            </Card>
          )}

          <Card onClick={() => setShowSettings(true)}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-ink-800 flex items-center justify-center">
                <Settings size={20} className="text-ink-400" />
              </div>
              <div>
                <p className="text-ink-100 text-sm font-medium">الإعدادات</p>
                <p className="text-ink-500 text-xs mt-0.5">إعدادات المساحة</p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Button variant="ghost" size="lg" onClick={signOut} className="w-full text-danger-400">
        <span className="flex items-center justify-center gap-2">
          <LogOut size={18} /> تسجيل الخروج
        </span>
      </Button>
    </div>
  );
}
