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

## Code style

Match what's already there: TypeScript, ESM (`type: "module"`), no linter
config beyond `tsc`'s type checking. Look at a neighboring file in `src/`
before inventing a new pattern.
