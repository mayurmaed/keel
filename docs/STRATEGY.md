# Keel — Strategy & Context

> North-star context for the project. Read this first when picking Keel back up.
> Planning lives in **GitHub Issues + Milestones** (not Jira) — see the repo's
> [issues](https://github.com/mayurmaed/keel/issues) and milestones. This doc is the "why".

_Last updated: 2026-07-13_

## What Keel is

A **BYO-AWS deploy platform** — a self-hosted Render/Supabase alternative that deploys
apps into the user's *own* AWS account, with no hosted SaaS and no per-seat bill. The
value prop is escaping Render/Vercel/Supabase pricing while keeping full ownership of
the infrastructure.

Stack: TypeScript/Node CLI, AWS SDK, Commander, Vitest, `pg`. Deploy path is
GitHub webhook → CodeBuild → ECR → ECS/Fargate behind a shared ALB, with a control
plane, encrypted SSM env vars, and logs/destroy commands.

## Where it stands (as of this note)

- **Phase 1 (app deploy pipeline):** working — local Docker target + AWS target, shared
  ALB routing, status/logs/destroy, encrypted env vars.
- **Phase 2 (managed Postgres on RDS):** largely coded (`src/commands/db.ts`,
  `src/aws/dbstack.ts`, `src/aws/pgadmin.ts`, with tests) but **not yet verified on real
  AWS**, and the README checklist is stale (still marks Phase 2 unchecked). See issues in
  the *Phase 2* milestone.
- **Phase 3 (auth: signup/login, JWT, permissions):** spec-only.
- **Phase 4 (packaging/hardening, npm distribution):** spec-only.

## Decisions made (2026-07-13 session)

These are also mirrored in the owner's decision log (`~/.claude/decisions/keel.md`).

1. **Tracker = GitHub, not Jira/Confluence.** Considered Jira-first and reversed it the
   same day: the project is headed for open source, so the tracker must be visible to
   future contributors, and in-repo specs (`docs/superpowers/`) are already the pattern.

2. **Repo stays private now; flip to public soon** — gated on the **OSS Launch
   Readiness** milestone, not on a date. The gate:
   - Secrets audit of the *full git history* (blocker — AWS keys were used in dev)
   - Add a LICENSE (recommendation: **Apache-2.0** — permissive maximizes adoption for a
     BYO-AWS tool where trust/auditability drives usage; hosted-competitor risk is low
     since Keel runs in the *user's* account)
   - CI (lint/build/test + gitleaks) — none exists today
   - README + real deployment walkthrough
   - CONTRIBUTING / issue templates / Code of Conduct
   - One real dogfood workload running on Keel

   Rationale: open source is the trust model for a tool that takes your AWS credentials
   and provisions infra — but private→public has no reverse gear, so flip deliberately
   once the gate is green.

3. **Keel's cost-saving target is Render, not Supabase.** For the owner's own stack, Keel
   replaces the 3 Render services (bigger monthly line than a $25 Supabase bill).
   Self-hosting Supabase on AWS is break-even at best (~$30–36/mo for a t4g.medium + EBS)
   and Keel has no auth until Phase 3 anyway, so it can't replace a Supabase-with-RLS
   backend yet. RoleBolt stays on managed Supabase.

## Positioning (resolved)

**Keel is a standalone product** (D-3, reaffirmed D-5, 2026-07-14). It may be *used by*
other applications, but it is not built as any app's hosting engine, and no other
project's needs drive its roadmap. Phase 3 therefore targets single-team CLI/DX
(auth for your own apps), not programmatic multi-tenant provisioning. Any evaluation
of hosting a specific external app on Keel is done in that app's own repository against
a copy — never coupled into this repo.

## How to resume

1. Skim the open **milestones** — OSS Launch Readiness items are small and independent;
   start the dogfood one early (it's the only one with real elapsed time).
2. The public-flip gate is the near-term goal: "get things into shape fast."
3. Verify Phase 2 on real AWS before advancing to Phase 3.
