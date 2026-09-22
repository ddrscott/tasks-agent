// The app is served under askscottpierce.com/tasks. Keep in sync with BASE in src/server.ts, vite.config.ts, and wrangler.jsonc.
export const BASE = "/tasks";
export const api = (path: string) => `${BASE}${path}`;
