# Keel Phase 2: Database (Postgres on RDS) — Design

**Date:** 2026-07-10
**Status:** Approved by Mayur (brainstorming session)
**Scope:** Phase 2 of the Keel platform — managed Postgres in the user's own
AWS account, the Supabase-database replacement.

## Vision fit

Keel is a BYO-AWS platform. Phase 1 (deploy) and Plan B1/B2 (AWS runtime) are
complete and live-verified. Phase 2 adds databases as an **independently
selectable** feature: a project may have a deployment, a database, both, or
(later) auth — any subset. This spec establishes the project/resource model
that Phase 3 (auth) will extend.

## Decisions made

| Decision | Choice |
|---|---|
| Resource model | Project is a namespace; deploy/db/auth are independent resources in the registry. Any subset per project. |
| DB isolation | Selectable per DB: `shared` (a database+user on one shared instance) or `dedicated` (own instance). Default `shared`. |
| DB access | Public endpoint, firewalled to the developer's IP + the deployed app's security group. TLS required. |
| App ↔ DB linking | Optional `"db": "<name>"` field in an app's `keel.json`; `keel deploy` injects `DATABASE_URL` and opens the firewall to that one app. |
| Provisioning | The CLI connects to the RDS endpoint (its IP is allowed) and runs `CREATE DATABASE`/`CREATE ROLE` via `pg`. |
| New dependency | `pg` (node-postgres) — required to provision logical databases. |
| Per-app isolation | Every app gets its **own** task security group (Phase 2 changes B2's shared task SG). A DB grants access to exactly one app's SG — real network isolation, not just credential separation. |

## Prerequisite change to B2: per-app security groups

B2 currently gives every deployed app a single *shared* task security group
(`TaskSg`, in the `keel-ingress` stack). Phase 2's first task changes this so
each app owns its security:

- The per-app stack `keel-app-<name>` creates its **own** task security group
  (ingress on the container port only from the ALB security group), and the
  Fargate service uses it. The app stack **outputs** this SG id.
- `keel-ingress` keeps only the ALB security group; the shared `TaskSg` is
  removed. `ensureAppStack` no longer receives a `TaskSgId` parameter — it
  creates one.
- Existing B2 unit tests and the app-stack template update accordingly; this is
  a self-contained refactor verified by the same live path (deploy still serves
  the app) plus the new DB linking.

This gives every app a distinct network identity, which is what lets a database
grant access to exactly one app.

## The project/resource model

A **project** is a string name, nothing more. Resources reference it.

DynamoDB single-table registry (existing table `keel`) gains database items:

- App record (existing): `PK=APP#<name>, SK=META`. Gains optional `project` and
  `db` fields.
- **Database record (new):** `PK=DB#<name>, SK=META` with attributes: `name`,
  `project`, `isolation` (`shared`|`dedicated`), `access` (`public`),
  `engine` (`postgres`), `host`, `port`, `dbName`, `dbUser`, `stack`
  (CloudFormation stack that owns the instance), `createdAt`. The **password /
  full connection URL is never stored in DynamoDB** — it lives in SSM
  SecureString `/keel/db/<name>/url`.

`keel db list` scans `DB#*` items; `keel list` continues to scan `APP#*`. A
future `keel project <name>` view can join both by the `project` attribute.

## Commands

- `keel db create <name> [--isolation shared|dedicated] [--access public] [--project <p>]`
  Provisions a Postgres database and prints the connection string. `--project`
  defaults to `<name>`.
- `keel db list` — one line per database: `name  isolation  host  project`.
- `keel db url <name>` — prints the connection string (read from SSM).
- `keel db allow-ip [ip]` — re-point the DB firewall at the given IP (default:
  the caller's current public IP, auto-detected). For when the developer's IP
  changes. Applies to a specific DB via `--db <name>` or all of the developer's
  DBs.
- `keel db destroy <name>` — drops the database+user (shared) or deletes the
  instance stack (dedicated); removes the registry record and SSM secret.
  Confirmation-gated unless `--yes`.

**Linking to an app:** the app's `keel.json` may include `"db": "<name>"`.
There is no separate `attach` command — the declarative field is the single
source of truth. On `keel deploy` (aws target) when `db` is set:
1. keel reads the DB's connection URL from SSM,
2. writes it to the app's env store as `DATABASE_URL` (SSM
   `/keel/<app>/env/DATABASE_URL`), so the existing task-def secret mechanism
   injects it,
3. ensures the DB's security group allows the app's task security group.

## Infrastructure

### Shared mode (default)

A lazily-created CloudFormation stack `keel-db-shared` (created on the first
`--isolation shared` database):
- `AWS::RDS::DBInstance`, engine `postgres`, class `db.t4g.micro`, 20 GB gp3,
  `PubliclyAccessible: true`, in the control-plane VPC's public subnets (a DB
  subnet group across them), `StorageEncrypted: true`, `BackupRetentionPeriod:
  7`, deletion protection off (personal scale).
- Master username `keeladmin`; master password generated by the CLI and stored
  in SSM `/keel/db-shared/master` (SecureString) before stack creation, passed
  in as a `MasterPassword` NoEcho parameter.
- A DB security group: ingress on 5432 from the developer's IP (a `MasterIp`
  parameter, `/32`). A second optional ingress source — the app task security
  group (`TaskSgId` parameter, default empty) — is added later, at deploy time,
  only when an app links to the DB. **A database-only project never creates the
  ALB ingress stack**; that stack is a deploy-time concern.

`keel db create --isolation shared <name>`:
1. Ensure `keel-db-shared` exists (deploy the stack; ~7 min first time).
2. Connect to the instance endpoint as `keeladmin` over TLS using `pg`.
3. `CREATE ROLE "<name>" LOGIN PASSWORD '<generated>'; CREATE DATABASE "<name>"
   OWNER "<name>";` (name sanitized to a safe Postgres identifier).
4. Compose `postgres://<name>:<pw>@<host>:5432/<name>?sslmode=require`, store in
   SSM `/keel/db/<name>/url`, write the `DB#<name>` registry record.

### Dedicated mode

A per-database stack `keel-db-<name>` with its own `db.t4g.micro` instance and
security group (same access model). The provisioned database is the instance's
initial DB (`DBName: <name>`), owner = master role `keeladmin`. No separate
logical-DB SQL step — the stack *is* the database. Same SSM/registry writes.

### Firewall management

The developer's IP is a stack parameter (`MasterIp`). `keel db allow-ip`
updates it via a stack update (shared) or per-instance stack update
(dedicated), so a changed home/office IP is one command to fix. The app's task
security group is added as an ingress source at deploy time by updating the
owning DB stack's `TaskSgId` parameter (shared or dedicated alike) — so linking
an app to a DB is what opens the DB to that app, and a DB with no linked app
stays reachable only from the developer's IP.

## Data flow: app with a database

```
keel db create api        # RDS DB "api", URL in SSM /keel/db/api/url
# edit myapp/keel.json: add "db": "api"
keel deploy               # reads /keel/db/api/url → writes /keel/myapp/env/DATABASE_URL
                          #   → task def gets DATABASE_URL secret
                          #   → app boots with a working Postgres connection
```

## Security

- Firewalled security group (developer IP `/32` + task SG), never `0.0.0.0/0`.
- TLS required (`sslmode=require` in the URL; RDS enforces).
- Passwords generated (32-byte), stored only in SSM SecureString, never in
  DynamoDB, never logged, never printed except by explicit `keel db url`.
- Master password for the shared instance in SSM, passed to CFN as a `NoEcho`
  parameter.
- **Per-app network isolation:** each app has its own task security group (the
  B2 prerequisite change above), so a DB grants access to exactly one app —
  another keel app on the same account cannot reach it at the network layer,
  even before credentials. This is the "every application has its own security"
  requirement, built in from the start.

## Error handling

- No default VPC / control plane missing → the existing `keel setup` hint.
- RDS create failure → surfaced with the CloudFormation reason; stack left for
  inspection (not auto-deleted, so the user can read the error), `keel db
  destroy` cleans up.
- `pg` connection failure (wrong IP allowed, instance not ready) → actionable
  message naming `keel db allow-ip` and the instance status.
- Duplicate `keel db create <name>` → error if the registry record exists.
- Name validation: Postgres-safe identifier (`^[a-z][a-z0-9_]{0,62}$`),
  rejecting names that would need quoting or collide with reserved words.

## Testing

- All AWS access through the existing injected-client seam; a fake `pg` client
  (an object with `query`/`connect`/`end`) so no test touches a real database.
- Unit tests: name validation, registry read/write for `DB#`, the CREATE
  DATABASE/ROLE SQL sequence (assert exact statements), URL composition, the
  deploy-time DATABASE_URL injection, `allow-ip` parameter update.
- Live verification (with the user): `keel db create` a shared DB, connect from
  the laptop with `psql`, deploy an app that reads `DATABASE_URL`, `curl` it
  proving the app queried Postgres, then `keel db destroy`. Optionally a
  `--isolation dedicated` create/destroy.

## Out of scope (Phase 2)

Migrations tooling, RDS Proxy / connection pooling, custom backup schedules
(RDS 7-day default stays on), read replicas, Multi-AZ, `keel db connect` psql
shell, and any auth (Phase 3). (Per-app network isolation is now **in** scope —
the B2 prerequisite change above.)

## Deferred debt carried from B1/B2 (address opportunistically)

The B1/B2 reviews deferred several minors (webhook `branch.S` guard already
done; `keel scale`; dashboard). The per-app-SG item is now pulled **into**
Phase 2 (the prerequisite change above). The rest don't block Phase 2.
