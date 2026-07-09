# Keel Plan B2: AWS Runtime (public URLs) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a deployed app reachable at a URL. B1 built the image and
registered an ECS task definition; B2 runs it on Fargate behind a shared
Application Load Balancer and prints the URL. Adds `keel logs`/`destroy` for
AWS.

**Architecture:** A lazily-created shared ingress CloudFormation stack
(`keel-ingress`: ALB + security groups) and one per-app stack
(`keel-app-<name>`: task security group, target group, Fargate service, and the
routing attachment). Ingress mode is chosen at `keel setup`:
- **port** mode (no domain): HTTP, each app on its own ALB listener port
  (`http://<alb-dns>:<port>`).
- **domain** mode (`--domain` given): HTTPS host-based routing
  (`https://<app>.<baseDomain>`) with a wildcard ACM cert and Route53 records.

All AWS access goes through the injected-client seam from B1; no test hits the
network. Per-app resources live in their own stack so `keel destroy` is a
single `DeleteStack`.

**Tech stack:** B1 stack + `@aws-sdk/client-elastic-load-balancing-v2` is NOT
needed (all ELB/service resources are declared in CloudFormation, driven
through the existing `cfn` client). Adds `@aws-sdk/client-cloudwatch-logs`
usage for `keel logs` (client already in the factory).

**Spec:** `docs/superpowers/specs/2026-07-07-keel-deploy-platform-design.md`
**Recorded deviation (approved):** Fargate tasks run in **public subnets** with
a security group allowing ingress only from the ALB security group — private
subnets would need a NAT gateway (~$32/mo), violating the cost posture. Tasks
get a public IP so they can pull from ECR without NAT.

## Global Constraints

- Runtime deps unchanged (commander, @inquirer/prompts, @aws-sdk/*). No new deps.
- TypeScript strict ESM NodeNext; `.js` extensions inside `src/`; **extension-less test imports** (this has regressed four times — check every new test file).
- CLI errors: thrown `Error` with actionable message; only `src/cli.ts` catches/exits.
- All AWS access via injected clients (`{ send }`); tests use fakes keyed on command constructor name.
- New naming: ingress stack `keel-ingress`; per-app stack `keel-app-<name>`; ALB `keel-alb`; app port range **8001–8999** (port mode), assigned per app and stored on the app record as `port` is the container port — store the **public** port separately as `albPort`.
- Config gains `ingress: "port" | "domain"` (default `"port"`) alongside the existing `baseDomain?`.
- Deploy statuses unchanged (`queued`/`building`/`live`/`failed`). "live" continues to mean image+taskdef ready; the CLI prints the URL after ensuring the service.
- Commit style: conventional commits. Tests in `tests/*.test.ts`, `npx vitest run`.

## Design notes (read before Task 1)

**Deploy ordering (why the app stack is created by the CLI, after the build):**
an ECS service must reference an existing task definition family. On the *first*
deploy the family doesn't exist until the build registers it. So `deployAws`
becomes: ensure ingress stack → StartBuild + poll to `live` (image + taskdef) →
ensure app stack (creates the service on first deploy; no-op after) → print URL.
On *subsequent* deploys the buildspec's existing `update-service
--force-new-deployment` rolls the running service to the new task def, and the
app-stack step is a no-op.

**Port assignment (port mode):** the app record stores `albPort`. Assignment =
`8001 + (count of existing apps with an albPort)`, computed by the CLI when the
app is first registered for AWS; deterministic and stored, never recomputed.

**Domain mode prerequisites:** the user must have a Route53 **public hosted
zone** for `baseDomain` (i.e. the domain's nameservers delegated to AWS).
`keel setup --domain` verifies the zone exists and fails with an actionable
message if not. The wildcard ACM cert (`*.baseDomain`) is DNS-validated via
that zone inside the ingress stack.

---

### Task 1: Config + setup ingress-mode choice

**Files:**
- Modify: `src/aws/globalconfig.ts` (add `ingress` to `GlobalConfig`)
- Modify: `src/commands/setup.ts` (prompt/flag for ingress mode; store it)
- Modify: `src/program.ts` (setup `--ingress` option)
- Test: `tests/setup.test.ts` (append)

**Interfaces:**
- `GlobalConfig` gains `ingress: "port" | "domain"`.
- `SetupOpts` gains `ingress?: "port" | "domain"`.
- setup: resolve ingress mode (flag → prompt, default `port`). If `domain`, require `--domain`/prompt and verify a Route53 hosted zone for it exists (`ListHostedZonesByNameCommand`); throw an actionable error if absent. Store `ingress` and `baseDomain` in config.

- [ ] **Step 1: Append failing tests**

`tests/setup.test.ts` (new cases inside the existing describe):
```ts
  it("stores ingress=port by default", async () => {
    const { clients } = fakeClients();
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    await setupCommand({ region: "ap-south-1", yes: true }, { clients, configPath });
    expect(JSON.parse(readFileSync(configPath, "utf8")).ingress).toBe("port");
  });

  it("stores ingress=domain and baseDomain when a hosted zone exists", async () => {
    const { clients } = fakeClients();
    (clients as any).route53 = {
      send: async (c: any) =>
        c.constructor.name === "ListHostedZonesByNameCommand"
          ? { HostedZones: [{ Name: "example.com.", Id: "/hostedzone/Z1" }] }
          : {},
    };
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    await setupCommand(
      { region: "ap-south-1", ingress: "domain", domain: "example.com", yes: true },
      { clients, configPath },
    );
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.ingress).toBe("domain");
    expect(cfg.baseDomain).toBe("example.com");
  });

  it("fails domain mode when no hosted zone exists", async () => {
    const { clients } = fakeClients();
    (clients as any).route53 = { send: async () => ({ HostedZones: [] }) };
    await expect(
      setupCommand(
        { region: "ap-south-1", ingress: "domain", domain: "nope.com", yes: true },
        { clients, configPath: "/dev/null" },
      ),
    ).rejects.toThrow(/hosted zone/i);
  });
```

Add a `route53` client to `fakeClients()` in the test helper returning `{}` by default so the existing cases keep passing.

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/setup.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/aws/clients.ts` add the Route53 client:
```ts
import { Route53Client } from "@aws-sdk/client-route-53";
// ...in AwsClients: route53: Route53Client;
// ...in makeClients: route53: new Route53Client({ region }),
```
Install: `npm install @aws-sdk/client-route-53`.

In `src/aws/globalconfig.ts`, add to `GlobalConfig`:
```ts
  ingress: "port" | "domain";
```

In `src/commands/setup.ts`, extend `SetupOpts` with `ingress?: "port" | "domain"` and, after the region block, resolve the mode:
```ts
import { ListHostedZonesByNameCommand } from "@aws-sdk/client-route-53";
import { select } from "@inquirer/prompts";
// ...
const ingress =
  opts.ingress ??
  (opts.yes
    ? "port"
    : ((await select({
        message: "How should deployed apps be reachable?",
        choices: [
          { name: "port  — http://<alb>:<port>, no domain needed", value: "port" },
          { name: "domain — https://<app>.<your-domain>, needs a Route53 zone", value: "domain" },
        ],
      })) as "port" | "domain"));

let baseDomain = opts.domain;
if (ingress === "domain") {
  baseDomain = baseDomain ?? (opts.yes ? undefined : await input({ message: "Base domain (e.g. apps.example.com)" }));
  if (!baseDomain) throw new Error("domain mode needs --domain <base domain>");
  const zones = await clients.route53.send(
    new ListHostedZonesByNameCommand({ DNSName: baseDomain }),
  );
  const match = (zones.HostedZones ?? []).some(
    (z) => z.Name === `${baseDomain}.` || z.Name === baseDomain,
  );
  if (!match) {
    throw new Error(
      `no Route53 hosted zone found for ${baseDomain} — create one and delegate the domain's nameservers to it, then re-run`,
    );
  }
}
```
Include `ingress` (and `baseDomain` when set) in the `writeGlobalConfig` object. Add `.option("--ingress <mode>", '"port" or "domain"')` to the setup command in `src/program.ts`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS.
```bash
git add src/aws/clients.ts src/aws/globalconfig.ts src/commands/setup.ts src/program.ts package.json package-lock.json tests/setup.test.ts
git commit -m "feat: setup chooses ingress mode (port or domain), verifies route53 zone"
```

---

### Task 2: Ingress stack (shared ALB) + ensureIngress

**Files:**
- Create: `infra/ingress.yaml`, `src/aws/ingress.ts`
- Test: `tests/ingress.test.ts`

**Interfaces:**
- `ensureIngress(clients, gcfg): Promise<IngressInfo>` — creates/updates the `keel-ingress` stack (idempotent via `deployStack` from B1) and returns `{ albDns, albArn, listenerArn, albSgId, taskSgId, httpsListenerArn? }` from stack outputs.
- `infra/ingress.yaml` parameters: `Mode` (port|domain), `VpcId`, `Subnets` (comma list), `BaseDomain` (domain mode), `HostedZoneId` (domain mode). Resources: ALB (`keel-alb`, internet-facing, public subnets), ALB SG (ingress: port mode → TCP 8001-8999 from 0.0.0.0/0; domain mode → 80+443 from 0.0.0.0/0), task SG (ingress from ALB SG only, all TCP), and in domain mode: an ACM cert (`*.BaseDomain`, DNS-validated via `HostedZoneId`), an HTTPS:443 listener (default action: fixed 404) and an HTTP:80 listener that redirects to HTTPS. In port mode: no default listener (per-app listeners are added by app stacks). Outputs: `AlbDns`, `AlbArn`, `AlbSgId`, `TaskSgId`, and (domain) `HttpsListenerArn`.

- [ ] **Step 1: Write failing test**

`tests/ingress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ensureIngress } from "../src/aws/ingress";

function fakeClients(outputs: Record<string, string>) {
  const calls: string[] = [];
  const cfn = {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      calls.push(cmd);
      if (cmd === "DescribeStacksCommand") {
        if (!calls.includes("CreateStackCommand")) {
          throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
        }
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
      }
      return {};
    },
  };
  return { calls, clients: { cfn } as any };
}

const gcfg = { region: "ap-south-1", ingress: "port", controlPlane: { vpcId: "vpc-1", subnetIds: ["s-1", "s-2"] } } as any;

describe("ensureIngress", () => {
  it("creates the ingress stack and returns outputs", async () => {
    const { calls, clients } = fakeClients({ AlbDns: "keel-alb-123.elb.amazonaws.com", AlbArn: "arn:alb", AlbSgId: "sg-alb", TaskSgId: "sg-task" });
    const info = await ensureIngress(clients, gcfg);
    expect(calls).toContain("CreateStackCommand");
    expect(info.albDns).toBe("keel-alb-123.elb.amazonaws.com");
    expect(info.taskSgId).toBe("sg-task");
  });

  it("passes Mode=port and the subnets as parameters", async () => {
    const seen: any[] = [];
    const clients = { cfn: { send: async (c: any) => {
      if (c.constructor.name === "CreateStackCommand") seen.push(c.input.Parameters);
      if (c.constructor.name === "DescribeStacksCommand") {
        if (!seen.length) throw Object.assign(new Error("no"), { name: "ValidationError" });
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [{ OutputKey: "AlbDns", OutputValue: "d" }, { OutputKey: "AlbArn", OutputValue: "a" }, { OutputKey: "AlbSgId", OutputValue: "s" }, { OutputKey: "TaskSgId", OutputValue: "t" }] }] };
      }
      return {};
    } } } as any;
    await ensureIngress(clients, gcfg);
    const params = Object.fromEntries(seen[0].map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.Mode).toBe("port");
    expect(params.Subnets).toBe("s-1,s-2");
  });
});

describe("ingress template", () => {
  const tpl = readFileSync("infra/ingress.yaml", "utf8");
  it("declares mode-conditional ALB, SGs, and outputs", () => {
    for (const k of ["Mode", "keel-alb", "AlbDns", "TaskSgId", "AlbSgId"]) expect(tpl).toContain(k);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails** — `npx vitest run tests/ingress.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/aws/ingress.ts`**

```ts
import { readFileSync } from "node:fs";
import type { AwsClients } from "./clients.js";
import type { GlobalConfig } from "./globalconfig.js";
import { deployStack } from "./stack.js";

export interface IngressInfo {
  albDns: string;
  albArn: string;
  albSgId: string;
  taskSgId: string;
  httpsListenerArn?: string;
}

const INGRESS_STACK = "keel-ingress";

export async function ensureIngress(clients: Pick<AwsClients, "cfn">, gcfg: GlobalConfig): Promise<IngressInfo> {
  if (!gcfg.controlPlane) throw new Error("run `keel setup` first");
  const template = readFileSync(new URL("../../infra/ingress.yaml", import.meta.url), "utf8");
  const params: Record<string, string> = {
    Mode: gcfg.ingress,
    VpcId: gcfg.controlPlane.vpcId,
    Subnets: gcfg.controlPlane.subnetIds.join(","),
    BaseDomain: gcfg.baseDomain ?? "",
    HostedZoneId: gcfg.hostedZoneId ?? "",
  };
  const out = await deployStack(clients.cfn, INGRESS_STACK, template, params);
  return {
    albDns: out.AlbDns,
    albArn: out.AlbArn,
    albSgId: out.AlbSgId,
    taskSgId: out.TaskSgId,
    ...(out.HttpsListenerArn ? { httpsListenerArn: out.HttpsListenerArn } : {}),
  };
}
```
(Add `hostedZoneId?: string` to `GlobalConfig`; store it in setup domain mode from the matched zone's `Id`.)

**`infra/ingress.yaml`:** ALB + SGs with a `Mode` parameter and CloudFormation
`Conditions` (`IsDomain: !Equals [!Ref Mode, domain]`). Port mode: ALB SG opens
8001-8999; no listeners (app stacks add them). Domain mode: ALB SG opens 80/443,
an ACM `Certificate` for `!Sub "*.${BaseDomain}"` with `ValidationMethod: DNS`
and `DomainValidationOptions` pointing at `HostedZoneId`, an HTTPS:443 listener
(default `fixed-response` 404) and an HTTP:80 listener (default `redirect` to
443). Outputs `AlbDns` (`!GetAtt Alb.DNSName`), `AlbArn`, `AlbSgId`, `TaskSgId`,
and `HttpsListenerArn` (domain only, guarded by `Condition`).

> The full YAML is written during implementation following the B1 template's
> style (short-form tags, `CAPABILITY_NAMED_IAM` not needed here). Keep the ACM
> cert and HTTPS listener behind `Condition: IsDomain` so port mode creates
> neither.

- [ ] **Step 4: Verify and commit** — `npx vitest run && npx tsc --noEmit`, then:
```bash
git add infra/ingress.yaml src/aws/ingress.ts src/aws/globalconfig.ts tests/ingress.test.ts
git commit -m "feat: shared ingress stack (ALB + security groups), port and domain modes"
```

---

### Task 3: Per-app runtime stack + ensureAppStack

**Files:**
- Create: `infra/app.yaml`, `src/aws/appstack.ts`
- Test: `tests/appstack.test.ts`

**Interfaces:**
- `ensureAppStack(clients, gcfg, app, ingress, albPort): Promise<string>` — deploys `keel-app-<name>` and returns the app URL.
- `infra/app.yaml` parameters: `AppName`, `Cluster`, `VpcId`, `Subnets`, `TaskSgId`, `AlbArn`, `Mode`, `ContainerPort`, `HealthPath`, `AlbPort` (port mode), `BaseDomain`+`HttpsListenerArn`+`HostedZoneId` (domain mode). Resources: `TargetGroup` (target-type `ip`, health check `HealthPath`), `Service` (Fargate, `keel-<AppName>` task def family, `desiredCount` 1, public subnets, `AssignPublicIp: ENABLED`, task SG, load-balancer wiring to the target group), and routing: port mode → a `Listener` on `AlbPort` forwarding to the target group; domain mode → a `ListenerRule` on the HTTPS listener matching host `<AppName>.<BaseDomain>` + a Route53 `A`-alias record to the ALB. Output `Url`.

- [ ] **Step 1–4:** TDD as above — a fake `cfn` asserting the stack is created with the right parameters per mode (`Mode=port` → `AlbPort` present; `Mode=domain` → host rule params present), a template-content test, then implement `appstack.ts` (mirrors `ingress.ts`: read template, build params from mode, `deployStack`, return `out.Url`) and `infra/app.yaml`. Commit:
```bash
git commit -m "feat: per-app runtime stack (target group, fargate service, routing) both modes"
```

---

### Task 4: Wire deployAws — ensure ingress, assign port, ensure app stack, print URL

**Files:**
- Modify: `src/targets/aws.ts` (deployAws, registerAwsApp), `src/aws/registry.ts` (AppRecord gains `albPort?`)
- Test: `tests/aws-target.test.ts` (extend)

**Interfaces:**
- `AppRecord` gains `albPort?: number`.
- `registerAwsApp` (port mode) assigns `albPort = 8001 + (apps with an albPort).length` and stores it.
- `deployAws` new flow: `ensureIngress` → StartBuild + poll to live (existing) → `ensureAppStack(...)` → print the returned URL.

- [ ] **Steps:** TDD — extend `fakeIo` so `cfn.send` answers Create/Describe for both stacks and the ddb scan returns the existing apps for port assignment; assert `deployAws` calls ensureIngress before StartBuild and ensureAppStack after live, and prints a URL (`http://…:8001` in port mode). Implement, keeping the existing StartBuild/poll block. Commit:
```bash
git commit -m "feat: deployAws provisions ingress + service and prints the app URL"
```

---

### Task 5: `keel logs` for AWS

**Files:**
- Modify: `src/targets/aws.ts` (add `logsAws`), `src/program.ts` (route logs by target)
- Test: `tests/aws-target.test.ts` (extend)

**Interfaces:**
- `logsAws(cfg, io?, opts?: { follow?: boolean })` — reads CloudWatch `/keel/apps` streams prefixed `<app>` via `FilterLogEventsCommand`; prints `timestamp  message`. With `follow`, polls every 3s from the last seen timestamp (sleep injectable).
- `src/program.ts`: `logs` action routes `target==="aws"` → `logsAws(cfg, {}, { follow })`; local unchanged. Remove the `localOnly` throw from `logs`.

- [ ] **Steps:** TDD with a fake `logs` client returning events; assert the FilterLogEvents call targets `/keel/apps` with `logStreamNamePrefix: cfg.name` and that events print. Commit:
```bash
git commit -m "feat: keel logs for aws (cloudwatch), follow mode"
```

---

### Task 6: `keel destroy` for AWS

**Files:**
- Modify: `src/targets/aws.ts` (add `destroyAws`), `src/program.ts` (route destroy)
- Test: `tests/aws-target.test.ts` (extend)

**Interfaces:**
- `destroyAws(cfg, io?)` — `DeleteStackCommand` for `keel-app-<name>` (removes service, target group, routing), waits for delete, then deletes the app + deploy records from DynamoDB and the app's SSM params (`/keel/<app>/*`). Leaves the shared ingress stack and ECR images (other apps may share; images are cheap). Prints what was removed. Requires confirmation unless `--yes`.
- `src/program.ts`: `destroy` routes `target==="aws"` → `destroyAws`; local unchanged. Remove the `localOnly` throw from `destroy`.

- [ ] **Steps:** TDD with a fake asserting DeleteStack for `keel-app-<name>` and the DynamoDB/SSM deletes; guard the destructive path behind `--yes` in non-interactive use. Commit:
```bash
git commit -m "feat: keel destroy for aws (delete app stack + records + secrets)"
```

---

### Task 7: Pay down deferred B1 findings

**Files:** `src/aws/stack.ts`, `infra/webhook-handler.cjs`, `infra/control-plane.yaml`, `src/targets/aws.ts`, `src/program.ts`, `tests/*`

Fold in the B1 review's deferred minors now that B2 touches these areas:
- `stack.ts` `stackExists`: narrow the catch to `ValidationError`/"does not exist"; rethrow other errors.
- `webhook-handler.cjs`: guard `rec.Item.branch?.S` (and repo/port) — malformed record → controlled `204`/`500` message, not an unhandled throw. Keep it under 4096 bytes.
- `control-plane.yaml` BuildRole: narrow the SSM read from `/keel/*` to `/keel/github-token` and `/keel/<app>/env/*` (drop access to other apps' webhook secrets).
- `aws.ts` deploy poll: drive the 20-min deadline off an injected clock (`io.now?`) or an iteration cap so a no-op-sleep test can't busy-loop.
- `program.ts`: extract the duplicated local `list`/`status` formatting into one helper.
- Add unit tests for `statusAws`, `envAws`, and the auto-register branch of `deployAws`.

- [ ] **Steps:** one focused commit per fix or a single grouped commit; each with its covering test. Commit:
```bash
git commit -m "refactor: pay down deferred B1 review findings (stackExists, webhook guard, iam scope, poll clock, dedup, tests)"
```

> **Note on the control-plane change:** narrowing BuildRole updates the
> `keel-control-plane` stack — re-run `keel setup` in Task 8 to apply it, and
> re-verify a deploy still succeeds (BuildRole must still read the app's env).

---

### Task 8: Live verification (REQUIRES USER — real AWS)

Executed inline with the user. Costs a few cents of CodeBuild + a running
Fargate task + the shared ALB (~$0.02/hr while up).

- [ ] **Step 1:** `keel setup --profile keel --region ap-south-1 --github-token <pat> --ingress port` (updates the control plane with the Task 7 IAM change; ingress stack is created on first deploy).
- [ ] **Step 2:** deploy `sample-app` (aws) → expect `live`, then a printed URL like `http://keel-alb-….ap-south-1.elb.amazonaws.com:8001`. `curl` it → `hello from keel`. (Allow ~1–2 min for the Fargate task to reach healthy.)
- [ ] **Step 3:** `keel logs` → shows the app's `listening on 3000`. `keel status` → the live deploy.
- [ ] **Step 4:** push a commit to main → webhook auto-deploys → `curl` the URL again reflects the new image.
- [ ] **Step 5:** `keel destroy --yes` → app stack deleted, `curl` now fails, records gone. Restore `sample-app/keel.json` to local; update README/GUIDE status; commit:
```bash
git commit -m "chore: verify aws runtime end-to-end (public URL, logs, destroy)"
```

> **Optional domain-mode check:** only if the user has a Route53 zone — re-run
> `keel setup --ingress domain --domain <base>` and deploy to confirm
> `https://sample-app.<base>` serves. Skip if no domain.

---

## Plan B3 preview (not part of B2)

Autoscaling policies (`keel scale`), custom domains per app beyond the wildcard,
buildpacks (no-Dockerfile builds), the real dashboard (the skeleton's live data),
and cost/teardown helpers. Then Phase 2 (Postgres provisioning).

## Self-review

- **Spec coverage (B2 scope):** public URL ✔ (both modes), shared ALB ✔ (lazy ingress stack), per-app service ✔, security groups ALB-only ✔, public-subnet deviation honored ✔, logs ✔, destroy ✔.
- **Ordering hazard addressed:** service-after-taskdef sequencing is called out in Design notes and encoded in Task 4's deployAws flow.
- **Regression guard:** the extension-less-test-import rule is restated in Global Constraints (it has regressed four times) and every new test file must be checked in review.
- **Deferred-debt paydown:** Task 7 closes the B1 review's deferred minors in the same areas B2 touches, rather than letting them accrete.
- **Known unavoidable manual step:** domain mode requires the user to delegate a domain to Route53 first — verified in setup with an actionable error, live-checked only if the user has one.
