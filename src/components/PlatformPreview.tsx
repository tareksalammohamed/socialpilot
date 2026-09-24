import { PLATFORM_META } from '@/lib/constants';
import type { SocialAccount, SocialPlatform } from '@/lib/types';

type Props = {
  platform: SocialPlatform;
  account?: SocialAccount;
  text: string;
  hashtags: string[];
  cta: string | null;
  mediaUrl?: string | null;
  scheduledAt?: string | null;
};

function formatWhen(scheduledAt?: string | null): string {
  if (!scheduledAt) return 'الآن (مسودة)';
  try {
    return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(scheduledAt));
  } catch {
    return scheduledAt;
  }
}

// Deliberately a single adaptable mockup (accent color/icon per platform)
// rather than five pixel-perfect platform clones — that level of fidelity
// is its own multi-day effort; this covers section 11's actual requirement
// (see the final content, in context, before approving) at a scope that
// fits this phase.
export function PlatformPreview({ platform, account, text, hashtags, cta, mediaUrl, scheduledAt }: Props) {
  const meta = PLATFORM_META[platform];
  const Icon = meta?.icon;
  const name = account?.display_name || account?.handle || 'حسابك';
  const handle = account?.handle ? `@${account.handle.replace(/^@/, '')}` : '';

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-950 overflow-hidden max-w-sm" dir="auto">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ink-800" style={{ borderInlineStartColor: meta?.color, borderInlineStartWidth: 3 }}>
        <div className="w-8 h-8 rounded-full bg-ink-800 flex items-center justify-center shrink-0 text-ink-400 text-xs font-semibold">
          {name.trim().charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-ink-100 text-xs font-medium truncate">{name}</p>
          {handle && <p className="text-ink-500 text-[10px] truncate">{handle}</p>}
        </div>
        {Icon && <Icon size={15} style={{ color: meta.color }} className="shrink-0" />}
      </div>

      <div className="px-3 py-2.5">
        <p className="text-ink-100 text-[13px] whitespace-pre-wrap leading-relaxed">{text}</p>
        {hashtags.length > 0 && (
          <p className="text-brand-400 text-[12px] mt-1.5">{hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}</p>
        )}
      </div>

      {mediaUrl && (
        <img src={mediaUrl} alt="" className="w-full max-h-64 object-cover border-t border-ink-800" />
      )}

      {cta && (
        <div className="px-3 py-2 border-t border-ink-800">
          <span className="inline-block text-[11px] font-medium px-2.5 py-1 rounded-full" style={{ backgroundColor: `${meta?.color}22`, color: meta?.color }}>
            {cta}
          </span>
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-ink-800 text-[10px] text-ink-600">
        {formatWhen(scheduledAt)}
      </div>
    </div>
  );
}
