import type { SocialPlatform, SocialPlatformAppKey } from './types';

export type PlatformInboxMode = 'messages_comments' | 'messages' | 'comments' | 'none';
export type PlatformConnectMode = 'oauth' | 'bot' | 'managed' | 'unavailable';

export type PlatformCapability = {
  appKey?: SocialPlatformAppKey;
  connectMode: PlatformConnectMode;
  publish: boolean;
  schedule: boolean;
  inbox: PlatformInboxMode;
  aiReply: boolean;
  media: ('text' | 'image' | 'video')[];
  note: string;
};

export const PLATFORM_CAPABILITIES: Record<SocialPlatform, PlatformCapability> = {
  facebook: {
    appKey: 'meta',
    connectMode: 'oauth',
    publish: true,
    schedule: true,
    inbox: 'messages_comments',
    aiReply: true,
    media: ['text', 'image'],
    note: 'نشر وجدولة + رسائل وتعليقات عبر Meta.',
  },
  instagram: {
    appKey: 'meta',
    connectMode: 'oauth',
    publish: true,
    schedule: true,
    inbox: 'messages_comments',
    aiReply: true,
    media: ['image'],
    note: 'النشر الحالي يحتاج صورة JPG، والـInbox عبر Meta.',
  },
  linkedin: {
    appKey: 'linkedin',
    connectMode: 'oauth',
    publish: true,
    schedule: true,
    inbox: 'comments',
    aiReply: true,
    media: ['text'],
    note: 'نشر نصي وتعليقات الصفحات؛ الرسائل الخاصة غير متاحة عبر المسار العام الحالي.',
  },
  x: {
    appKey: 'x',
    connectMode: 'oauth',
    publish: true,
    schedule: true,
    inbox: 'none',
    aiReply: false,
    media: ['text'],
    note: 'نشر وجدولة نصية. Inbox غير مفعّل في النسخة الحالية.',
  },
  threads: {
    appKey: 'threads',
    connectMode: 'oauth',
    publish: true,
    schedule: true,
    inbox: 'none',
    aiReply: false,
    media: ['text', 'image'],
    note: 'ربط موحّد ونشر نص/صورة؛ استقبال الردود سيضاف عبر webhook منفصل.',
  },
  tiktok: {
    appKey: 'tiktok',
    connectMode: 'oauth',
    publish: false,
    schedule: false,
    inbox: 'none',
    aiReply: false,
    media: ['image', 'video'],
    note: 'الربط جاهز؛ النشر يحتاج Content Posting API وإعدادات خصوصية/ميديا واعتماد TikTok.',
  },
  telegram: {
    appKey: 'telegram',
    connectMode: 'bot',
    publish: true,
    schedule: true,
    inbox: 'messages',
    aiReply: true,
    media: ['text', 'image', 'video'],
    note: 'نشر وجدولة + Inbox عبر البوت والقناة/السوبرجروب المربوط.',
  },
  whatsapp: {
    appKey: 'meta',
    connectMode: 'managed',
    publish: false,
    schedule: false,
    inbox: 'messages',
    aiReply: true,
    media: ['text', 'image', 'video'],
    note: 'قناة رسائل عبر WhatsApp Business؛ لا يوجد Feed للنشر.',
  },
};

export function inboxCapabilityLabel(mode: PlatformInboxMode): string {
  if (mode === 'messages_comments') return 'رسائل + تعليقات';
  if (mode === 'messages') return 'رسائل';
  if (mode === 'comments') return 'تعليقات';
  return 'غير متاح';
}

export function platformOperationalScore(platform: SocialPlatform): number {
  const capability = PLATFORM_CAPABILITIES[platform];
  return [
    capability.publish,
    capability.schedule,
    capability.inbox !== 'none',
    capability.aiReply,
  ].filter(Boolean).length;
}
