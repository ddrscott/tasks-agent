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
}
