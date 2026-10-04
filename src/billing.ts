// Paid plan through Stripe. Free accounts get FREE_DAILY_CHATS assistant messages a
// day; a Stripe subscription raises that to PRO_DAILY_CHATS. The board and MCP are
// unlimited on both, since they don't call the model.
//
// Stripe owns the truth. Checkout creates the subscription; webhooks tell us when it
// changes, and each one makes us fetch the subscription fresh and store its current
// state, so events arriving late or out of order can't leave a stale plan behind.
// Everything is off until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and
// STRIPE_PRICE_ID are set.

import { currentUser, type User } from "./auth";
import { planChanged } from "./members";

export type Plan = "free" | "pro";
export type Usage = { plan: Plan; used: number; limit: number; billing: boolean };

// past_due keeps Pro while Stripe retries the card; Stripe moves it to canceled or
// unpaid if the retries fail, and the webhook downgrades then.
const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

export const billingEnabled = (env: Env) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_ID);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function dailyLimit(env: Env, plan: Plan): number {
  return plan === "pro" ? num(env.PRO_DAILY_CHATS, 150) : num(env.FREE_DAILY_CHATS, 30);
}

/** The user's plan, from the subscription row the webhook keeps current. */
export async function planFor(env: Env, userId: string): Promise<Plan> {
  const row = await env.DB.prepare("SELECT status, current_period_end FROM subscriptions WHERE user_id = ?")
    .bind(userId).first<{ status: string; current_period_end: number | null }>();
  if (!row || !PRO_STATUSES.has(row.status)) return "free";
  // A missed "deleted" webhook shouldn't mean Pro forever: a period that ended over
  // three days ago without a renewal event counts as lapsed.
  if (row.current_period_end && row.current_period_end * 1000 < Date.now() - 3 * 86400_000) return "free";
  return "pro";
}

// ---------- Stripe REST ----------

/** Stripe wants form encoding with bracketed keys: metadata[user_id]=… */
function form(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe<T>(env: Env, method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const url = new URL(`https://api.stripe.com/v1${path}`);
  if (method === "GET" && params) url.search = form(params).toString();
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch(url, { method, headers, body: method === "POST" && params ? form(params) : undefined });
  const body = (await r.json()) as T & { error?: { message?: string; type?: string } };
  if (!r.ok) throw new Error(`Stripe ${method} ${path}: ${r.status} ${body.error?.type ?? ""} ${body.error?.message ?? ""}`);
  return body;
}

type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  // Newer API versions moved the period onto items; read either.
  current_period_end?: number;
  items?: { data: { current_period_end?: number }[] };
};

async function storeSubscription(env: Env, sub: StripeSubscription): Promise<void> {
  const userId = sub.metadata?.user_id;
  if (!userId) {
    console.warn("stripe subscription without user_id metadata", sub.id);
    return;
  }
  const periodEnd = sub.current_period_end ?? sub.items?.data[0]?.current_period_end ?? null;
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, email, customer_id, subscription_id, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, customer_id = excluded.customer_id,
       subscription_id = excluded.subscription_id, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = excluded.updated_at`,
  ).bind(userId, sub.metadata.email ?? "", sub.customer, sub.id, sub.status, periodEnd, sub.cancel_at_period_end ? 1 : 0, Date.now()).run();
  // A shared board follows its owner's plan: members drop to view only when Pro lapses and get
  // their roles back when it returns, on the sockets they already have open (members.ts).
  await planChanged(env, userId).catch((e: Error) => console.warn("telling the board about a plan change failed", e.message));
}

// ---------- public plans ----------

/** What the signed-out pricing section shows. `price` is in the currency's smallest unit, straight from Stripe. */
export type PlanPrice = { amount: number; currency: string; interval: string; intervalCount: number };
export type Plans = {
  free: { dailyChats: number };
  /** Null while billing is off: Pro isn't on sale, so there's nothing to quote. */
  pro: { dailyChats: number; price: PlanPrice | null } | null;
};

type StripePrice = { unit_amount: number | null; currency: string; active: boolean; recurring: { interval: string; interval_count: number } | null };

// The price changes about never, so one Stripe read serves an isolate for an hour. A failed
// read isn't kept: the next request asks again.
const PRICE_TTL_MS = 60 * 60 * 1000;
let priceMemo: { id: string; at: number; price: PlanPrice } | null = null;

async function proPrice(env: Env): Promise<PlanPrice | null> {
  const id = env.STRIPE_PRICE_ID!;
  if (priceMemo && priceMemo.id === id && Date.now() - priceMemo.at < PRICE_TTL_MS) return priceMemo.price;
  try {
    const p = await stripe<StripePrice>(env, "GET", `/prices/${encodeURIComponent(id)}`);
    // Tiered or one-time prices have no single monthly number to show; Checkout still explains them.
    if (p.unit_amount === null || !p.recurring) return null;
    const price = { amount: p.unit_amount, currency: p.currency, interval: p.recurring.interval, intervalCount: p.recurring.interval_count };
    priceMemo = { id, at: Date.now(), price };
    return price;
  } catch (e) {
    console.error("plans", (e as Error).message);
    return null;
  }
}

/**
 * GET /api/plans: the daily assistant caps and the Pro price, for anyone, signed in or not.
 * The page never carries a dollar amount of its own; it shows what Stripe says the price is.
 */
export async function handlePlans(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/plans" || req.method !== "GET") return null;
  const plans: Plans = {
    free: { dailyChats: dailyLimit(env, "free") },
    pro: billingEnabled(env) ? { dailyChats: dailyLimit(env, "pro"), price: await proPrice(env) } : null,
  };
  // Short at the edge and in the browser when the price is missing, so a Stripe hiccup clears quickly.
  const maxAge = plans.pro && !plans.pro.price ? 60 : 600;
  return Response.json(plans, { headers: { "Cache-Control": `public, max-age=${maxAge}` } });
}

// ---------- webhook ----------

const enc = new TextEncoder();

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]. Rejects anything older than five minutes. */
async function verifySignature(env: Env, header: string | null, body: string): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET!, `${t}.${body}`);
  return sigs.some((s) => safeEqual(s, expected));
}

async function webhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifySignature(env, req.headers.get("Stripe-Signature"), body))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(body) as { type: string; data: { object: { id: string; subscription?: string | null; mode?: string } } };
  let subscriptionId: string | null | undefined;
  switch (event.type) {
    case "checkout.session.completed":
      if (event.data.object.mode === "subscription") subscriptionId = event.data.object.subscription;
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      subscriptionId = event.data.object.id;
      break;
    default:
      return Response.json({ ignored: event.type });
  }
  if (!subscriptionId) return Response.json({ ignored: "no subscription" });
  // Fetch rather than trust the event body, so an old event can't overwrite newer state.
  await storeSubscription(env, await stripe<StripeSubscription>(env, "GET", `/subscriptions/${subscriptionId}`));
  return Response.json({ ok: true });
}

// ---------- Checkout and the customer portal ----------

async function customerFor(env: Env, user: User): Promise<string | null> {
  const row = await env.DB.prepare("SELECT customer_id FROM subscriptions WHERE user_id = ?").bind(user.id).first<{ customer_id: string }>();
  return row?.customer_id ?? null;
}

async function checkout(req: Request, env: Env, user: User): Promise<Response> {
  if ((await planFor(env, user.id)) === "pro") return Response.json({ error: "You're already on Pro." }, { status: 400 });
  const origin = new URL(req.url).origin;
  const customer = await customerFor(env, user);
  const session = await stripe<{ url: string }>(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: { 0: { price: env.STRIPE_PRICE_ID, quantity: 1 } },
    // Reuse the Stripe customer from an earlier subscription so their history stays in one place.
    ...(customer ? { customer } : { customer_email: user.email }),
    client_reference_id: user.id,
    subscription_data: { metadata: { user_id: user.id, email: user.email } },
    metadata: { user_id: user.id },
    allow_promotion_codes: true,
    success_url: `${origin}/tasks/?billing=success`,
    cancel_url: `${origin}/tasks/?billing=cancel`,
  });
  return Response.json({ url: session.url });
}

async function portal(req: Request, env: Env, user: User): Promise<Response> {
  const customer = await customerFor(env, user);
  if (!customer) return Response.json({ error: "No subscription to manage yet." }, { status: 400 });
  const session = await stripe<{ url: string }>(env, "POST", "/billing_portal/sessions", {
    customer,
    return_url: `${new URL(req.url).origin}/tasks/`,
  });
  return Response.json({ url: session.url });
}

/** /api/billing/* for the signed-in user, and /api/stripe/webhook for Stripe. */
export async function handleBilling(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/billing/") && path !== "/api/stripe/webhook") return null;
  if (!billingEnabled(env)) return Response.json({ error: "Billing isn't set up." }, { status: 404 });
  try {
    if (path === "/api/stripe/webhook" && req.method === "POST") return await webhook(req, env);
    const user = await currentUser(req, env);
    if (!user) return Response.json({ error: "signed out" }, { status: 401 });
    if (path === "/api/billing/checkout" && req.method === "POST") return await checkout(req, env, user);
    if (path === "/api/billing/portal" && req.method === "POST") return await portal(req, env, user);
  } catch (e) {
    console.error("billing", (e as Error).message);
    // A 500 makes Stripe retry the webhook, which is what we want after a transient failure.
    return Response.json({ error: "Billing is having trouble. Try again in a minute." }, { status: 500 });
  }
  return null;
}
