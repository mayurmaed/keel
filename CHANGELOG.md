# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.x`, minor bumps may contain breaking changes.

## [Unreleased]

### Added

- Machine-level project registry at `~/.bareboat/projects.json` and `bareboat status --all`,
  which lists every app, database and auth service provisioned from this machine and
  works from any directory (#18).
- Every provisioned stack is tagged `bareboat:managed=true`; app, dedicated-database and
  auth stacks also carry `bareboat:project=<name>`, so per-project cost is a Cost Explorer
  query grouped by tag (#17).
- Packaging metadata, a least-privilege IAM policy for the CLI at `docs/iam-policy.json`,
  and a tag-driven release workflow (#11).

### Fixed

- The shared ECR repository is emptied on delete, so tearing down the control plane no
  longer fails when app images remain (#16).

## [0.1.0] - unreleased

First tagged release. Everything below already exists on `main`.

### Added

- `bareboat setup` — deploys the control plane (DynamoDB, SSM, CodeBuild, ECR, ECS cluster,
  webhook Lambda + API Gateway) into your own AWS account as one CloudFormation stack.
- `bareboat new` / `deploy` / `status` / `logs` / `env` / `destroy` for apps, against either
  the `aws` target (Fargate behind a shared ALB) or the `local` Docker target.
- Push-to-deploy: a GitHub webhook whose HMAC signature is verified in the Lambda before
  anything is parsed or started.
- `bareboat db` — managed RDS Postgres, shared or dedicated. Linking a database to an app
  injects `DATABASE_URL` and opens a per-app firewall path to it.
- `bareboat auth` — self-hosted GoTrue, storing users in a bareboat database and issuing
  Supabase-compatible JWTs.
- Ingress in either `port` mode (shared ALB, one port per app) or `domain` mode
  (per-app subdomain with HTTPS).

[Unreleased]: https://github.com/mayurmaed/bareboat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mayurmaed/bareboat/releases/tag/v0.1.0
