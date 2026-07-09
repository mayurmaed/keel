# Keel

Deploy apps to your own AWS account (or local Docker). Render/Supabase
replacement you run yourself. Phase 1: deploy pipeline. Spec and plans in
`docs/superpowers/`.

**→ [docs/GUIDE.md](docs/GUIDE.md)** — architecture, deploy-flow diagrams, and
how to use and test every piece.

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

## Deploy to your own AWS account

Requirements: an AWS account, the AWS CLI configured (a dedicated profile is
recommended), and a GitHub repo with a `Dockerfile`.

```bash
aws configure --profile keel                        # new account's credentials
keel setup --profile keel --region ap-south-1 \
  --github-token <fine-grained PAT, Contents:read>  # deploys the control plane (~3 min)

cd your-app/                                         # keel.json: target=aws, repo, dir
keel deploy                                          # build via CodeBuild → ECR → ECS task def
keel status                                          # recent deploys
# keel new also prints a `gh api ... /hooks` line — run it to enable
# push-to-deploy: every push to your branch auto-builds and deploys.
```

`keel setup` stands up a serverless control plane (DynamoDB, ECR, ECS cluster,
CodeBuild, a GitHub-webhook Lambda + HTTP API, scoped IAM) that costs ~$0/mo
idle. Apps run on Fargate.

## Status

- [x] Plan A: CLI + local Docker target
- [x] Plan B1: AWS control plane — `keel setup`, GitHub webhook auto-deploy, CodeBuild → ECR → ECS task definitions
- [x] Plan B2: AWS runtime — shared ALB, live public URLs, `keel logs`/`destroy` for AWS (live-verified end-to-end)
- [ ] Phase 2: Postgres provisioning
- [ ] Phase 3: Auth service
- [ ] Phase 4: Open-source packaging
