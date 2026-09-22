# Tasks

Live at **https://askscottpierce.com/tasks**. Tasks is a kanban-style task board with an assistant in the sidebar. Tell it "finished the dentist
thing, add taxes for Friday" and the cards move while you watch. It runs entirely on
Cloudflare, and you sign in with an emailed code.

## // STACK

| Piece | Cloudflare product |
|---|---|
| App + API | Workers, with static assets built by Vite + React |
| Board, chat history, undo stack | Agents SDK: one Durable Object (`TodoAgent`) per user, SQLite-backed |
| Assistant | Workers AI `@cf/zai-org/glm-4.7-flash`, about $0.06 in / $0.40 out per M tokens |
| Login codes + sessions | D1 (`todo-agent-auth`), plus optional Google and Microsoft sign-in (OpenID Connect) |
| Login email | Email Sending (`send_email` binding) from `hey@askscottpierce.com` |
| Bot protection | Turnstile on the email sign-in form, checked with Siteverify before any email goes out |
| Paid plan | Stripe Checkout and Customer Portal, webhook into D1 (`subscriptions`) |
| Outside agents | MCP server (`agents/mcp/server`, stateless Streamable HTTP) behind `@cloudflare/workers-oauth-provider` (grants in KV `OAUTH_KV`), plus personal access tokens in D1 |

```
askscottpierce.com/tasks/assets/*  ──▶ static assets (no Worker hop)
askscottpierce.com/tasks/api/*     ──▶ Worker ──▶ D1 (codes, sessions), EMAIL.send
askscottpierce.com/tasks/agent     ──▶ Worker ──session──▶ your TodoAgent (Durable Object)
                                          board state ⇄ UI · chat ─▶ Workers AI + board tools
askscottpierce.com/tasks/mcp       ──▶ OAuth provider ──token──▶ your TodoAgent, over RPC ─▶ board tools
askscottpierce.com/tasks/oauth/*   ──▶ OAuth provider (register, token) · consent screen (authorize)
askscottpierce.com/.well-known/oauth-{authorization-server, protected-resource/tasks/*} ──▶ OAuth discovery
```

The rest of askscottpierce.com is untouched. Two Worker routes (`/tasks`, `/tasks/*`)
run ahead of whatever serves the zone.

## // HOW_IT_WORKS

- **One board per user.** The client connects to `/tasks/agent`, and the Worker
  picks the Durable Object from the session cookie. No URL names a board, so there's
  no id to guess. The cookie is scoped to `Path=/tasks`.
- **One code path for every change.** Drag and drop, buttons, the assistant's
  tools, and MCP calls all end in the pure functions in `src/shared.ts`. The board
  tools are defined once in `src/tools.ts` for both the assistant and MCP. The agent
  rejects state pushed directly from clients.
- **Live sync.** Board state is Agents SDK synced state, so every open tab
  updates at once. Changes animate with the View Transitions API. Cards the
  assistant touches flash briefly.
- **Undo.** Every change is undoable (⌘Z or the Undo button), including a whole
  assistant turn as one step. The last 30 steps are kept.
- **Themes.** Auto, which follows the OS, plus 11 fixed themes. Hover to preview,
  click to keep. Your choice syncs to your account and is cached locally so the
  page never flashes the wrong theme.
- **Cost guard.** The assistant is capped per user per day: `FREE_DAILY_CHATS` (30)
  on the free plan and `PRO_DAILY_CHATS` (150) with a Stripe subscription. The chat
  shows a meter and an upgrade button at the cap. The board and MCP are never capped.
  Sign-in is limited by `ALLOWED_EMAILS` and protected by Turnstile.

## // CONNECT_AN_AGENT

Claude, ChatGPT, Glean, Claude Code, Cursor, VS Code, Codex, and any other MCP client
can work the board. The in-app page at **/tasks/connect** (user menu → Connect an
agent) shows the server URL, setup steps for each client, connected apps, and tokens.

- **Endpoint.** `/tasks/mcp`, Streamable HTTP, stateless. Tools: `get_board` plus
  the seven board tools from `src/tools.ts`. MCP changes sync live and are undoable,
  one undo step per call.
- **OAuth (most clients).** The client only needs the URL. It discovers the OAuth
  server, registers itself (Dynamic Client Registration, or a Client ID Metadata
  Document), and sends the person to `/tasks/oauth/authorize`. They sign in if
  needed, then see a consent screen with the app's name and where it returns to,
  and choose Allow. Access tokens last an hour and refresh tokens 90 days. Connected
  apps are listed on the Connect page, and disconnecting one kills its tokens.
- **Access tokens (fallback).** For clients that take a pasted token (Codex, Glean's
  API Key method): `Authorization: Bearer tasks_…`. Per user, at most 10, stored as
  SHA-256 hashes in D1 (`api_tokens`). Only a browser session can create or revoke
  them.
- **Glean.** An admin adds it under Admin console → Platform → Tools → Import tools
  from MCP server, with the **Dynamic Client Registration** auth method. Each Glean
  user then connects their own board on first use. The API Key method with an access
  token also works, but everyone the tool is published to shares that one board.
- **Discovery is at the domain root.** OAuth metadata lives at
  `askscottpierce.com/.well-known/oauth-authorization-server` (RFC 8414 derives it
  from the issuer, which is the origin), so this app is the OAuth server for the
  whole domain. `wrangler.jsonc` routes only that path and
  `/.well-known/oauth-protected-resource/tasks/*` here. Nothing else on the domain
  can use them.
- MCP calls don't hit Workers AI, so the daily chat cap doesn't apply to them.

## // TURNSTILE

The email sign-in form carries an invisible Turnstile widget ("interaction-only":
it shows a checkbox only when Cloudflare wants one). `POST /api/auth/start` checks
the token with Siteverify before sending a code, and requires `success`, action
`signin`, and a hostname in `TURNSTILE_HOSTNAMES`. Tokens are single-use, so the
widget resets after every send. Google and Microsoft sign-in are redirects and
don't need it.

- Production: set `TURNSTILE_SITEKEY` in `wrangler.jsonc`, and the secret with
  `npx wrangler secret put TURNSTILE_SECRET`. An empty sitekey turns the check off.
- Dev: `.dev.vars.example` has Cloudflare's always-pass test keys. The server
  accepts test-key results only when `DEV_LOGIN_CODES=1`.

## // BILLING

Free accounts get `FREE_DAILY_CHATS` assistant messages a day; Pro raises it to
`PRO_DAILY_CHATS`. Upgrade from the chat (at the cap) or the user menu, which opens
Stripe Checkout. Pro users get "Manage subscription" (the Stripe Customer Portal)
for card changes and cancellation.

- **Truth lives in Stripe.** `POST /tasks/api/stripe/webhook` checks the signature,
  then fetches the subscription fresh from Stripe and stores its current state in
  D1, so late or out-of-order events can't leave a wrong plan. `active`, `trialing`,
  and `past_due` count as Pro. A period that ended over three days ago without a
  renewal event counts as lapsed, in case a webhook is missed.
- **The cap is checked in the agent** (`usage()` in `src/agent.ts`), which reads the
  plan from D1 on each message.
- Billing stays off until `STRIPE_PRICE_ID` (var) and the `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` secrets are all set.

Setup:
1. In Stripe, create a product ("Tasks Pro") with a recurring price, and put its `price_…` id in
   `STRIPE_PRICE_ID`.
2. Settings → Billing → Customer portal: save a configuration (Stripe requires one
   before portal sessions work). Allow cancel and payment-method updates.
3. Developers → Webhooks → add endpoint `https://askscottpierce.com/tasks/api/stripe/webhook`
   with events `checkout.session.completed` and `customer.subscription.created`,
   `.updated`, `.deleted`, `.paused`, `.resumed`. Copy its signing secret.
4. `npx wrangler secret put STRIPE_SECRET_KEY` (a restricted key needs write access to
   Checkout Sessions and Customer Portal, and read access to Subscriptions), then
   `STRIPE_WEBHOOK_SECRET`.

Locally: `stripe listen --forward-to localhost:5173/tasks/api/stripe/webhook` prints a
`whsec_…` for `.dev.vars`. Pay with card `4242 4242 4242 4242`.

## // PRIVACY_AND_TERMS

`/tasks/privacy` and `/tasks/terms` (`src/client/Legal.tsx`) are public pages, linked
from the sign-in screen and from Google's consent screen. Keep the privacy policy in
step with what the app stores: update it when you add a table, a processor, or a cookie.

## // SIGN_IN_WITH_GOOGLE_AND_MICROSOFT

The sign-in screen (and the OAuth consent flow) offers "Continue with Google" and
"Continue with Microsoft" next to the emailed code. Each button appears once both of
its secrets are set. Whichever way someone signs in, the verified email picks the
board, so one person gets the same board every time. `ALLOWED_EMAILS` still applies.

**Google** is set up in Cloud project `ask-scott-pierce` (Google Auth Platform: app
"Tasks", External, In production; client "Tasks web"). `GOOGLE_CLIENT_ID` is a var in
`wrangler.jsonc`; only `GOOGLE_CLIENT_SECRET` is a secret. To redo it elsewhere
(Google Cloud console → Google Auth Platform):
1. OAuth consent screen: External, scopes `openid`, `email`, `profile`. Publish it,
   or add test users while it's in testing.
2. Credentials → Create credentials → OAuth client ID → Web application.
3. Authorized redirect URIs: `https://askscottpierce.com/tasks/api/auth/sso/google/callback`
   (and `http://localhost:5173/tasks/api/auth/sso/google/callback` for dev).
4. `npx wrangler secret put GOOGLE_CLIENT_ID`, then `GOOGLE_CLIENT_SECRET`.

**Microsoft** (Outlook.com, Hotmail, Microsoft 365; Entra admin center → App registrations):
1. New registration. Supported account types: **Accounts in any organizational
   directory and personal Microsoft accounts**.
2. Redirect URI, platform Web: `https://askscottpierce.com/tasks/api/auth/sso/microsoft/callback`
   (add the localhost one for dev under Authentication).
3. Manifest → add `"optionalClaims": { "idToken": [ { "name": "email", "essential": false }, { "name": "xms_edov", "essential": false } ] }`
   and save. (`xms_edov` often isn't listed under Token configuration, so the manifest is the reliable way.)
   Work and school tenants can put any address in `email`, so the app only trusts it
   when `xms_edov` (the domain is verified) is true. Personal accounts are always trusted.
4. Certificates & secrets → New client secret.
5. `npx wrangler secret put MICROSOFT_CLIENT_ID` (the Application (client) ID), then
   `MICROSOFT_CLIENT_SECRET` (the secret's **Value**, not its ID).

Locally, put the same four values in `.dev.vars` (see `.dev.vars.example`).

Keys: `n` new card · `/` assistant · `t` theme · `⌘Z` undo · `Space` pick up a
card, arrows to move it · `Enter` edit a card. Pasting a list into "Add a card"
creates one card per line.

## // DEVELOP

```sh
npm install
npm run db:migrate:local
npm run dev          # http://localhost:5173/tasks/ — Workers AI is always remote, so `npx wrangler login` first
npm run dev:local    # no Cloudflare login needed; everything works except the assistant
```

The `/tasks` base lives in seven places: `src/client/base.ts`, `src/server.ts`,
`src/mcp.ts` (`MCP_PATH`), `src/oauth.ts` (`AUTHORIZE_PATH`), `src/sso.ts` and
`src/auth.ts` (redirect and cookie paths), `vite.config.ts` (`build.assetsDir`), and
`wrangler.jsonc` (`routes`, `run_worker_first`).

`.dev.vars` sets `DEV_LOGIN_CODES=1`, which skips sending email: the code shows
on the sign-in screen and in the terminal. Copy `.dev.vars.example` to create it.

## // DEPLOY

```sh
npm run deploy               # vite build && wrangler deploy
npm run db:migrate:remote    # only when migrations/ changes
```

Secrets (`npx wrangler secret put <NAME>`): `TURNSTILE_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, and optionally the four Google/Microsoft ones.

`OAUTH_KV` is the `todo-agent-oauth-kv` namespace, created by the first OAuth deploy
and pinned by id in `wrangler.jsonc`.

The D1 database (`616a0109-…`) exists, and askscottpierce.com is already set up
for Email Sending.

## // CONFIG (`wrangler.jsonc` vars)

| var | default | |
|---|---|---|
| `CHAT_MODEL` | `@cf/zai-org/glm-4.7-flash` | any Workers AI model with function calling |
| `EMAIL_FROM` | `hey@askscottpierce.com` | must be on a domain onboarded to Email Sending |
| `ALLOWED_EMAILS` | empty (anyone) | comma-separated emails or `@domain.com` rules to make it invite-only |
| `DEV_LOGIN_CODES` | unset | `1` in `.dev.vars` only. Never set it in production. |
| `TURNSTILE_SITEKEY` | empty (off) | public sitekey for the sign-in widget |
| `TURNSTILE_HOSTNAMES` | `askscottpierce.com` | hostnames Siteverify may report; never `localhost` in production |
| `FREE_DAILY_CHATS` | `30` | assistant messages per day on the free plan |
| `PRO_DAILY_CHATS` | `150` | assistant messages per day on Pro |
| `STRIPE_PRICE_ID` | empty (billing off) | the Pro subscription's recurring price |
