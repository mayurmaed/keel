# Contributing

## Build & test

```bash
npm install
npm run build   # tsc
npm test        # vitest run — 137 tests, no AWS/network needed
```

Tests are unit-level and mock AWS SDK clients — none of them touch a real AWS
account. Run a single file with `npx vitest run tests/<file>.test.ts`.

## Branches & PRs

- Branch off the repo's active integration branch (check `git branch` /
  `gh repo view --json defaultBranchRef` if unsure — don't assume `main`).
- One focused change per PR; keep commit messages short and imperative
  (`fix: ...`, `feat: ...`, `docs: ...`).
- `npm run build` and `npm test` must pass before you open a PR.

## Releasing

Releases are tag-driven — nothing publishes from an ordinary branch update.

```bash
npm version patch          # or minor / major; bumps package.json and creates the tag
git push --follow-tags
```

The `release` workflow then builds, runs the tests, checks the tag matches
`package.json`, verifies the tarball still contains `infra/` (the CLI reads those
templates at runtime — without them a fresh install fails on the first command),
publishes to npm with provenance, and opens a GitHub Release with generated notes.

Move the relevant `## [Unreleased]` entries in `CHANGELOG.md` under the new version
before tagging.

Publishing requires an `NPM_TOKEN` repository secret with publish rights.

## Code style

Match what's already there: TypeScript, ESM (`type: "module"`), no linter
config beyond `tsc`'s type checking. Look at a neighboring file in `src/`
before inventing a new pattern.
