// Captain-bumped per voyage. Keep the format `YYYY-MM-DD.N` so it sorts and is
// trivially human-readable.
export const APP_VERSION = '2026-07-08.15';
// The commit hash is injected at build/dev time by vite's `define` block — see
// `vite.config.ts`. Falls back to 'dev' if undefined.
declare const __COMMIT_HASH__: string | undefined;
export const COMMIT_HASH: string =
  typeof __COMMIT_HASH__ !== 'undefined' && __COMMIT_HASH__
    ? __COMMIT_HASH__
    : 'dev';
export const VERSION_STRING = `ERDA-market-land v${APP_VERSION} (${COMMIT_HASH})`;