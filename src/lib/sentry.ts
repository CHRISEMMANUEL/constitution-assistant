import * as Sentry from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const ENV =
  (import.meta.env.VITE_SENTRY_ENV as string | undefined) ||
  (import.meta.env.MODE as string);

export const initSentry = (): void => {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
      /speechSynthesis/i,
    ],
  });
};

export const reportError = (
  err: unknown,
  context?: Record<string, unknown>,
): void => {
  if (!DSN) return;
  Sentry.captureException(err, { extra: context });
};
