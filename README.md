# Keel

Deploy apps to your own AWS account (or local Docker). Render/Supabase
replacement you run yourself. Phase 1: deploy pipeline. Spec and plans in
`docs/superpowers/`.

## Quickstart (local target)

Requirements: Node ≥ 20, Docker. Your app repo must contain a `Dockerfile`.

```bash
npm install && npm run build
cd your-app/
keel new        # answers: name, port, target=local
keel deploy     # docker build + run
keel list
keel logs -f
keel env set KEY=value && keel deploy
keel destroy
```

## Status

- [x] Plan A: CLI + local Docker target
- [ ] Plan B: AWS target (control plane, GitHub webhook auto-deploy, ECS)
- [ ] Phase 2: Postgres provisioning
- [ ] Phase 3: Auth service
- [ ] Phase 4: Open-source packaging
