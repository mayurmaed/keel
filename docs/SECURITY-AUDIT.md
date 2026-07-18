# Secret scan — public-readiness audit

Run 2026-07-15, before the OSS launch. Audit only — no history was rewritten.

## Tooling

- `gitleaks` v8.30.1 (installed via `brew install gitleaks` for this audit)
- Fallback pattern grep across full history as a second pass

## Scope & results

**Working tree** (`gitleaks detect --source . --no-git`): scanned ~1.41 MB,
**no leaks found**.

**Full git history, all local refs** (`gitleaks detect --source . --log-opts="--all"`):
73 commits scanned (of 80 total reachable via `git rev-list --all` — the
7-commit gap is merge commits, which carry no unique diff under `git log -p`
and are gitleaks' normal scan unit), **no leaks found**.

**Fallback grep** across `git log -p --all` for `ghp_`, `github_pat_`, `AKIA...`,
PEM headers, `aws_secret`, `api[_-]?key\s*[=:]`: matches found are all test
fixtures / docs placeholders, not real credentials:

- `ghp_x`, `<github_pat_...>` — placeholder tokens in `docs/GUIDE.md` and
  test setup calls (`tests/setup.test.ts`), never real values.
- `API_KEY=abc`, `API_KEY: "abc"` — fixture env values in
  `tests/db-commands.test.ts` / `tests/commands.test.ts`, not secrets.

## Verdict: CLEAN

No real credentials (AWS keys, GitHub tokens, private keys) found in the
working tree or in any commit reachable from a local branch ref. No
owner-decision blocker.

## Note for the record

An empty `.git-rewrite/` directory exists at the repo root (untracked, not
under `.git/`), left over from a prior `git filter-branch` (or similar) run.
It's empty — no residual content — but its presence indicates history may
have been rewritten previously. Not a blocker for this audit, but worth the
owner double-checking that the earlier rewrite fully achieved whatever it
was for.
