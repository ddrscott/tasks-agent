// Bindings that `wrangler types` can't see: secrets, set with `wrangler secret put`
// (or .dev.vars locally), and the helpers the OAuth provider adds at runtime.
// `npm run types` reads .dev.vars.example, not your .dev.vars, so the generated
// types don't change with whatever secrets you happen to have locally.
// Each sign-in provider is optional and turns on when both of its secrets exist.

interface Env {
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  // The vector index behind meaning-based search across boards (src/search-all.ts). Optional:
  // it's commented out in wrangler.jsonc until the index exists on the account (// SEARCH in
  // the README), and without it searches are keyword-only and say so.
  VECTORS?: VectorizeIndex;
  // Browser Rendering, for PDF exports of pages (src/export.ts). Optional the same way:
  // commented out in wrangler.jsonc until it's wanted; without it, PDF asks you to print the HTML.
  BROWSER?: Fetcher;
}
