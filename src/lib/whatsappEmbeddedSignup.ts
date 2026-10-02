import type { WhatsAppEmbeddedConfig } from './api';

type FacebookLoginResponse = {
  authResponse?: { code?: string };
  status?: string;
};

type FacebookSdk = {
  init: (options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (
    callback: (response: FacebookLoginResponse) => void,
    options: Record<string, unknown>,
  ) => void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

export type WhatsAppEmbeddedSession = {
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
};

let sdkReady: Promise<void> | null = null;
let initializedAppId: string | null = null;

export function prepareWhatsAppEmbeddedSignup(config: WhatsAppEmbeddedConfig): Promise<void> {
  if (window.FB && initializedAppId === config.appId) return Promise.resolve();
  if (sdkReady) return sdkReady;

  sdkReady = new Promise<void>((resolve, reject) => {
    const initialize = () => {
      if (!window.FB) {
        reject(new Error('تعذّر تحميل Meta SDK'));
        return;
      }
      window.FB.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: config.graphVersion,
      });
      initializedAppId = config.appId;
      resolve();
    };

    if (window.FB) {
      initialize();
      return;
    }

    window.fbAsyncInit = initialize;
    const existing = document.getElementById('facebook-jssdk');
    if (existing) return;

    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.onerror = () => {
      sdkReady = null;
      reject(new Error('تعذّر تحميل نافذة Meta. تحقق من الاتصال أو مانع النوافذ.'));
    };
    document.body.appendChild(script);
  });

  return sdkReady;
}

export function launchWhatsAppEmbeddedSignup(config: WhatsAppEmbeddedConfig): Promise<WhatsAppEmbeddedSession> {
  if (!window.FB || initializedAppId !== config.appId) {
    throw new Error('Meta SDK لسه بيجهز. حاول مرة ثانية.');
  }

  return new Promise<WhatsAppEmbeddedSession>((resolve, reject) => {
    let finished = false;
    let code: string | null = null;
    let wabaId: string | undefined;
    let phoneNumberId: string | undefined;
    let fallbackTimer: number | null = null;

    const cleanup = () => {
      window.removeEventListener('message', listener);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
    };

    const done = () => {
      if (finished || !code) return;
      finished = true;
      cleanup();
      resolve({ code, wabaId, phoneNumberId });
    };

    const listener = (event: MessageEvent) => {
      let host = '';
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return;

      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;

        if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
          wabaId = typeof data.data?.waba_id === 'string' ? data.data.waba_id : undefined;
          phoneNumberId = typeof data.data?.phone_number_id === 'string' ? data.data.phone_number_id : undefined;
          done();
          return;
        }
        if (data.event === 'ERROR') {
          finished = true;
          cleanup();
          reject(new Error(data.data?.error_message || 'Meta لم تكمل ربط WhatsApp'));
          return;
        }
        if (data.event === 'CANCEL') {
          finished = true;
          cleanup();
          reject(new Error('تم إلغاء ربط WhatsApp من نافذة Meta'));
        }
      } catch {
        // Ignore unrelated postMessage traffic.
      }
    };

    window.addEventListener('message', listener);

    window.FB!.login(
      (response) => {
        const authCode = response.authResponse?.code;
        if (!authCode) {
          if (!finished) {
            finished = true;
            cleanup();
            reject(new Error('لم يكتمل تفويض WhatsApp من Meta'));
          }
          return;
        }
        code = authCode;

        // Meta returns the auth code and session info through separate channels.
        // Give the session event a short grace period, then let the backend
        // discover the WABA/phone from token scopes when possible.
        if (wabaId) {
          done();
        } else {
          fallbackTimer = window.setTimeout(done, 1500);
        }
      },
      {
        config_id: config.configurationId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          sessionInfoVersion: '3',
        },
      },
    );
  });
}
