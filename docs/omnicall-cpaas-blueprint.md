# OmniCall CPaaS — implementation blueprint

> Product and engineering blueprint for evolving this repository's static Relay communications landing page into a multi-tenant Communications Platform as a Service. This document is a design and starter implementation, not a claim that the production integrations already exist. Carrier APIs, signature validation, delivery guarantees, and regulatory requirements must be verified for the selected provider and jurisdictions.

## Product scope

OmniCall gives businesses a workspace to provision phone numbers, send and receive SMS, configure voice/IVR workflows, inspect message and call records, manage API credentials, and pay for a monthly plan plus metered usage. A platform-admin role supports tenant support and aggregate operations.

### Recommended stack

- **Web:** Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui, React Server Components by default.
- **Application/API:** Next.js Route Handlers and Server Actions for the initial product; isolate carrier integrations in provider adapters so they can later move to a worker/service.
- **Data:** PostgreSQL, Prisma ORM, Supabase Auth or an OIDC-compatible identity provider. Use Postgres RLS as defense in depth; application authorization remains mandatory.
- **Jobs:** Queue-backed workers (e.g. managed queue) for webhook processing, retries, usage aggregation, and billing events. Do not rely on a request handler for long-running work.
- **Payments:** Stripe Checkout, Customer Portal, and signed webhooks. Store Stripe identifiers, never payment-card data.
- **Telephony:** Provider adapter for number inventory, SMS, voice, and status callbacks; validate signatures using the provider's official SDK and raw request body.

## Repository structure (target)

```text
app/
  (auth)/login/page.tsx
  (dashboard)/layout.tsx
  (dashboard)/dashboard/page.tsx
  (dashboard)/numbers/page.tsx
  (dashboard)/messages/page.tsx
  (dashboard)/calls/page.tsx
  (dashboard)/settings/billing/page.tsx
  admin/page.tsx
  api/webhooks/carrier/sms/route.ts
  api/webhooks/carrier/voice/route.ts
  api/webhooks/stripe/route.ts
  api/stripe/checkout/route.ts
  api/stripe/portal/route.ts
components/
  dashboard/overview.tsx
  admin/platform-overview.tsx
  ui/                         # shadcn/ui components
lib/
  auth.ts                     # session and organization access
  db.ts                       # Prisma client
  permissions.ts              # RBAC helpers
  providers/telecom.ts        # carrier interface and adapters
  stripe.ts
  validation.ts
prisma/schema.prisma
prisma/migrations/
workers/                      # queue consumers and retry jobs
```

## Data model and PostgreSQL migration

The SQL below is a PostgreSQL baseline. Auth identities are managed by the configured identity provider; `users.auth_subject` links the provider's immutable subject. All tenant-owned rows carry `organization_id`. Provision Supabase's `auth.uid()` function if using Supabase; otherwise replace `app_user_id()` with a trusted session variable set by your connection/auth layer. Never accept a tenant ID as authorization from an untrusted request body.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE org_status AS ENUM ('active', 'suspended');
CREATE TYPE subscription_status AS ENUM
  ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE message_status AS ENUM ('queued', 'sent', 'delivered', 'failed', 'received');
CREATE TYPE call_status AS ENUM ('queued', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text,
  platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status org_status NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role org_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  plan_key text NOT NULL CHECK (plan_key IN ('starter', 'pro', 'enterprise')),
  status subscription_status NOT NULL DEFAULT 'incomplete',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  e164 text NOT NULL,
  provider text NOT NULL,
  provider_number_id text,
  capabilities jsonb NOT NULL DEFAULT '{"sms":false,"voice":false}'::jsonb,
  voice_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_number_id),
  UNIQUE (organization_id, e164)
);

CREATE TABLE sms_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
  provider_message_id text UNIQUE,
  direction message_direction NOT NULL,
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  body text,
  status message_status NOT NULL,
  segments integer NOT NULL DEFAULT 1 CHECK (segments > 0),
  error_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
  provider_call_id text UNIQUE,
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  status call_status NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  started_at timestamptz,
  ended_at timestamptz,
  recording_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('sms_segment', 'call_minute', 'phone_number_day')),
  quantity numeric(14,4) NOT NULL CHECK (quantity >= 0),
  idempotency_key text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sms_org_time_idx ON sms_logs (organization_id, occurred_at DESC);
CREATE INDEX calls_org_time_idx ON call_logs (organization_id, created_at DESC);
CREATE INDEX usage_org_time_idx ON usage_events (organization_id, occurred_at DESC);
CREATE INDEX members_user_idx ON organization_members (user_id);

-- Supabase example. Apply equivalent policies for every tenant table in use.
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM users WHERE auth_subject = auth.uid()::text
$$;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_member_read ON organizations FOR SELECT
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = organizations.id AND m.user_id = app_user_id()));
CREATE POLICY member_read_self_or_org ON organization_members FOR SELECT
  USING (user_id = app_user_id() OR EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = organization_members.organization_id AND m.user_id = app_user_id()));

-- Tenant-scoped policy template; repeat for each tenant table. Membership writes
-- should be restricted to owner/admin in application logic and corresponding policies.
CREATE POLICY numbers_member_access ON phone_numbers FOR ALL
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = phone_numbers.organization_id AND m.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = phone_numbers.organization_id AND m.user_id = app_user_id()));
CREATE POLICY sms_member_access ON sms_logs FOR ALL
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = sms_logs.organization_id AND m.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = sms_logs.organization_id AND m.user_id = app_user_id()));
CREATE POLICY calls_member_access ON call_logs FOR ALL
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = call_logs.organization_id AND m.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = call_logs.organization_id AND m.user_id = app_user_id()));
CREATE POLICY subscription_member_read ON subscriptions FOR SELECT
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = subscriptions.organization_id AND m.user_id = app_user_id()));
CREATE POLICY keys_member_access ON api_keys FOR ALL
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = api_keys.organization_id AND m.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = api_keys.organization_id AND m.user_id = app_user_id()));
CREATE POLICY usage_member_read ON usage_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM organization_members m
    WHERE m.organization_id = usage_events.organization_id AND m.user_id = app_user_id()));

-- Add equivalent SELECT policies for subscriptions and org-scoped tables as needed.
-- Keep carrier/Stripe webhook DB access on a server-only role; never expose service credentials.
```

**RLS production notes:** The sample policies establish tenant membership isolation but intentionally do not fully encode role permissions. Add role-sensitive `WITH CHECK` policies and verify with tests using two organizations. `FOR ALL` is permissive for any member; in production narrow writes to appropriate roles (e.g. only owner/admin can manage keys, numbers, and billing). Platform-admin access should use a separate server-only authorization path and audited operations, not a broad public RLS bypass. Do not use a privileged database key in browser code.

### RBAC baseline

| Action | Owner | Admin | Member | Viewer |
|---|---:|---:|---:|---:|
| View dashboard, logs, numbers | Yes | Yes | Yes | Yes |
| Send messages / operate voice | Yes | Yes | Yes | No |
| Manage numbers and API keys | Yes | Yes | No | No |
| Invite/remove members | Yes | Yes | No | No |
| Change plan / cancel billing | Yes | Optional policy | No | No |
| Transfer ownership / delete workspace | Yes | No | No | No |

## Carrier webhook routes (Next.js / TypeScript)

Example provider-neutral handlers. The `telecom.verifyWebhook` adapter must implement the selected carrier's documented signature algorithm against the raw body and request URL. Reject invalid signatures, enforce replay protections where supported, and make processing idempotent. Persist and enqueue before returning success; a worker should apply state changes and downstream actions. Do not trust callback organization IDs: resolve the tenant from the provider's known number/call record.

```ts
// lib/providers/telecom.ts
export type SmsCallback = {
  id: string;
  from: string;
  to: string;
  body: string;
  status?: "received" | "sent" | "delivered" | "failed";
  errorCode?: string;
};
export type VoiceCallback = {
  id: string;
  from: string;
  to: string;
  status: "queued" | "ringing" | "in_progress" | "completed" | "failed" | "busy" | "no_answer";
  durationSeconds?: number;
  startedAt?: string;
  endedAt?: string;
};
export interface TelecomProvider {
  verifyWebhook(input: { url: string; rawBody: string; headers: Headers }): Promise<boolean>;
  parseSms(input: { rawBody: string; headers: Headers }): SmsCallback;
  parseVoice(input: { rawBody: string; headers: Headers }): VoiceCallback;
}
```

```ts
// app/api/webhooks/carrier/sms/route.ts
import { NextRequest, NextResponse } from "next/server";
import { telecom } from "@/lib/providers/registry";
import { enqueueCarrierEvent } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const valid = await telecom.verifyWebhook({
    url: request.url,
    rawBody,
    headers: request.headers,
  });
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let event;
  try {
    event = telecom.parseSms({ rawBody, headers: request.headers });
    if (!event.id || !event.from || !event.to) throw new Error("Missing callback fields");
  } catch {
    return NextResponse.json({ error: "Invalid callback" }, { status: 400 });
  }

  // Queue insertion is idempotent on provider + event ID; worker resolves tenant
  // by the platform-owned destination number and upserts the message state.
  await enqueueCarrierEvent({ providerEventId: event.id, kind: "sms", payload: event });
  return new NextResponse(null, { status: 204 });
}
```

```ts
// app/api/webhooks/carrier/voice/route.ts
import { NextRequest, NextResponse } from "next/server";
import { telecom } from "@/lib/providers/registry";
import { enqueueCarrierEvent } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (!(await telecom.verifyWebhook({ url: request.url, rawBody, headers: request.headers }))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  try {
    const event = telecom.parseVoice({ rawBody, headers: request.headers });
    if (!event.id || !event.to || !event.status) throw new Error("Missing callback fields");
    await enqueueCarrierEvent({ providerEventId: event.id, kind: "voice", payload: event });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Invalid callback" }, { status: 400 });
  }
}
```

## Stripe subscription lifecycle

- Create Checkout Sessions on the server after checking workspace role and allowed plan/price IDs. Set `organization_id` in Stripe metadata and the customer record.
- Create Customer Portal sessions only for authorized workspace users.
- Verify webhook signatures against the raw request body. Deduplicate using `stripe_webhook_events.event_id` before applying changes.
- Handle at least `checkout.session.completed`, `customer.subscription.created|updated|deleted`, and `invoice.payment_failed|paid`. Treat Stripe events as the source of truth; update local state idempotently.
- Meter usage from durable `usage_events`, aggregate by billing period, and submit to Stripe's metered billing API or invoice items. Ensure usage submission is idempotent and reconcile periodically.
- Plans shown in the UI are illustrative: Starter $29/mo, Pro $99/mo, Enterprise custom. Configure actual Stripe price IDs through environment variables and disclose usage rates, taxes, and number rental fees.

## Dashboard overview component

```tsx
// components/dashboard/overview.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type OverviewStats = {
  activeNumbers: number;
  smsSent: number;
  smsReceived: number;
  callMinutes: number;
  monthToDateCents: number;
};

export function DashboardOverview({ stats }: { stats: OverviewStats }) {
  const cards = [
    ["Active numbers", stats.activeNumbers.toLocaleString()],
    ["SMS sent", stats.smsSent.toLocaleString()],
    ["SMS received", stats.smsReceived.toLocaleString()],
    ["Call minutes", stats.callMinutes.toLocaleString()],
    ["Month-to-date", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(stats.monthToDateCents / 100)],
  ];
  return (
    <section aria-labelledby="overview-heading" className="space-y-4">
      <h1 id="overview-heading" className="text-2xl font-semibold">Workspace overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-bold">{value}</p></CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
```

Fetch and aggregate these values on the server with the active organization derived from the authenticated session. Paginate message and call tables, redact sensitive content where appropriate, and use a subscription/stream mechanism for live updates rather than polling every row.

## Super-admin panel component

```tsx
// components/admin/platform-overview.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PlatformStats = {
  activeOrganizations: number;
  activeNumbers: number;
  mrrCents: number;
  smsThisMonth: number;
  callMinutesThisMonth: number;
  health: "healthy" | "degraded" | "outage";
};

export function PlatformOverview({ stats }: { stats: PlatformStats }) {
  const items = [
    ["Active organizations", stats.activeOrganizations.toLocaleString()],
    ["Active numbers", stats.activeNumbers.toLocaleString()],
    ["MRR", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(stats.mrrCents / 100)],
    ["SMS this month", stats.smsThisMonth.toLocaleString()],
    ["Call minutes", stats.callMinutesThisMonth.toLocaleString()],
    ["System health", stats.health],
  ];
  return (
    <main className="space-y-6">
      <header><h1 className="text-2xl font-semibold">Platform administration</h1><p className="text-muted-foreground">Aggregate operations and tenant health</p></header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-bold">{value}</p></CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
```

The admin route must authorize `users.platform_admin` server-side on every request. Keep tenant suspension, plan changes, and support access behind explicit confirmation, least privilege, and an audit log. Avoid exposing message bodies or call recordings in aggregate views.

## Security, reliability, and launch checklist

1. Implement OAuth/email auth, session rotation, CSRF protections for mutations, and server-side RBAC checks on every action.
2. Test tenant isolation under RLS, including forged organization IDs, cross-tenant foreign keys, and service-role boundaries.
3. Hash API keys with a modern one-way hash; show the secret only once, scope keys, support revocation, and rate-limit use.
4. Verify carrier and Stripe signatures, use raw request bodies, deduplicate callbacks, and retry transient worker failures safely.
5. Encrypt secrets, redact PII from logs, define retention/deletion policies, and secure recording URLs.
6. Add monitoring, audit logs, backups/restore tests, usage reconciliation, alerts, and provider health checks.
7. Complete telecom regulatory, consent, opt-out, A2P registration, emergency calling, recording-consent, and privacy reviews for each market before launch.
