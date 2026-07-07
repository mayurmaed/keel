# Keel — Phase 1: Deploy Pipeline — Design

**Date:** 2026-07-07
**Status:** Approved by Mayur (brainstorming session)
**Scope:** Phase 1 of a self-hosted Supabase + Render replacement on AWS.

## Vision (whole platform)

A BYO-AWS platform-as-a-service: a tool (not a hosted service) that deploys
and manages apps, databases, and auth **in the user's own AWS account**. Mayur
is user #1; the product direction is open-source distribution (open-core
monetization later — the Coolify/SST model), positioned as the escape hatch
for teams outgrowing Render/Vercel/Supabase pricing. Decided 2026-07-07: no
hosted/multi-tenant offering (Option 2 rejected — reselling compute against
funded incumbents with 24/7 ops burden). Every user runs their own instance in
their own account, so tenant isolation comes free.

Phases:

1. **Deploy pipeline** (this spec) — the Render replacement.
2. **Postgres provisioning** — shared RDS instance, per-project databases/users, `keel db create`.
3. **Auth service** — signup/login, JWTs, permissions (the Supabase-Auth part).
4. **Open-source packaging** — docs, `keel setup` hardened for strangers'
   AWS accounts, sample app templates, license + repo hygiene.

Each phase gets its own spec → plan → implementation cycle. Nothing in this
spec builds ahead for later phases beyond keeping interfaces clean.

## Decisions made

| Decision | Choice |
|---|---|
| Build strategy | Compose AWS managed services (not self-hosted OSS) |
| First slice | Deploy pipeline |
| Interface | Interactive CLI now; dashboard skeleton included, real dashboard later |
| Build method | Dockerfile required in every repo (buildpacks maybe later) |
| AWS account | Exists; CLI credentials not yet configured — `keel setup` walks through it |
| Cost posture | Platform itself ~$0/mo (serverless control plane); apps pay-per-use; local Docker target for free development |
| CLI name | `keel` |
| Language | TypeScript (Node) |

## Cost model

- **Control plane:** API Gateway + Lambda (webhook receiver), CodeBuild
  (pay-per-build-minute), ECR (image storage, pennies), DynamoDB (state, free
  tier), SSM Parameter Store standard tier (free). Idle cost ≈ $0/mo.
- **Apps:** one Fargate task per app (smallest 0.25 vCPU / 0.5 GB by default;
  Fargate Spot for dev apps). The only fixed cost is one shared Application
  Load Balancer (~$18/mo), created lazily on the first AWS deploy and shared
  by all apps.
- **Local target:** `--target local` runs the same workflow against local
  Docker. Zero AWS cost; used for development and testing of Keel itself.

## Architecture

### 1. `keel` CLI (TypeScript, runs on the developer machine)

Interactive prompts (asks for details, per the original requirement). Commands:

- `keel setup` — one-time. Checks/configures AWS credentials (guides through
  `aws configure` / SSO), asks for region and base domain, deploys the
  control-plane CloudFormation stack (API Gateway, Lambda, DynamoDB table,
  ECR, CodeBuild project, ECS cluster, VPC or default-VPC reuse, IAM roles).
- `keel new` — registers an app. Prompts: name, GitHub repo, branch, container
  port, env vars, target (local/aws), instance size. Writes app record to
  DynamoDB (or local state file for local-only apps). Prints the GitHub
  webhook URL + secret to add to the repo.
- `keel deploy [--target local|aws]` — manual deploy of the current app.
- `keel list` / `keel status` — apps and recent deploys with state.
- `keel logs [--follow]` — tails CloudWatch logs (or `docker logs` locally).
- `keel env set/unset/list` — env vars; secrets go to SSM Parameter Store.
- `keel destroy` — tears down an app's resources (with confirmation).

### 2. Auto-deploy path (GitHub → running container)

```
GitHub push → webhook → API Gateway (HTTP API) → Lambda
  → verify HMAC signature (per-app secret)
  → look up app in DynamoDB, match branch
  → start CodeBuild run
CodeBuild: clone repo → docker build (repo's Dockerfile) → push to ECR
  → register new ECS task definition revision → update service
Lambda/CodeBuild write deploy status (queued/building/deploying/live/failed)
  to DynamoDB; `keel status` reads it.
```

### 3. App runtime (AWS target)

- One shared ECS cluster (Fargate), one shared ALB.
- Host-based routing: `<app>.<base-domain>` via wildcard ACM cert + Route53.
- Each app: one ECS service, one target group, one ALB listener rule.
- Env vars from the app record; secrets injected from SSM Parameter Store.
- Apps run in private subnets; only the ALB is public.
- Health check: HTTP on the app's declared port/path (default `/`).

### 4. Local target

`keel deploy --target local` = `docker build` + `docker run -p` with the same
app config (port, env vars). State kept in `~/.keel/local.json`. No AWS calls.

### 5. Dashboard skeleton

`dashboard/` — minimal Next.js app with placeholder pages (app list, deploy
history) wired to a stub API module that will later read the same DynamoDB
data. Deliberately non-functional beyond static rendering; exists so the
future dashboard has a home and the API shape is sketched.

## Data model (DynamoDB, single table)

- `APP#<name>` — repo, branch, port, target, size, env var refs, webhook secret ref, created.
- `APP#<name> / DEPLOY#<timestamp>` — commit SHA, status, CodeBuild run id, timestamps.

Secrets (webhook secrets, app secrets) live in SSM Parameter Store
(`/keel/<app>/...`), never in DynamoDB.

## Security baseline

- GitHub webhook HMAC (X-Hub-Signature-256) verified per app.
- Least-privilege IAM: Lambda can only StartBuild + read/write the table;
  CodeBuild can only push its app's ECR repo + update ECS; task roles empty
  by default.
- Secrets in SSM Parameter Store; injected as container secrets, never logged.
- Apps in private subnets; security groups allow only ALB → app port.

## Error handling

- Webhook Lambda: bad signature → 401, unknown app/branch → 204 (ignore), AWS
  errors → deploy record marked `failed` with reason.
- CodeBuild failure → status `failed`; `keel status` shows the failure phase
  and `keel logs --build` shows build logs.
- ECS deploy uses circuit breaker (auto-rollback to previous task def on
  failed health checks).
- CLI validates Dockerfile presence and port before registering/deploying.

## Testing

- Local target provides end-to-end testing of the CLI without AWS.
- One sample hello-world app repo (with Dockerfile) validates the full AWS
  path: webhook → build → live URL.
- Small integration check per CLI command (against local target + mocked AWS
  where cheap). No heavyweight test frameworks beyond the runner.

## Out of scope (Phase 1)

Buildpacks, custom domains per app beyond the wildcard, autoscaling policies,
multi-region, RDS/Postgres, auth service, billing, real dashboard
functionality, teams/multi-user.
