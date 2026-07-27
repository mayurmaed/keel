import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ResourceKind = "app" | "db" | "auth";

export interface ProjectResource {
  kind: ResourceKind;
  /** Resource name — unique per kind (app "web", db "maindb", auth "login"). */
  name: string;
  project: string;
  region: string;
  /** CloudFormation stack backing it, so `status --all` can point at the real thing. */
  stack: string;
  /** Apps only: the directory the app was deployed from. */
  repoPath?: string;
  url?: string;
  createdAt: string;
}

/**
 * Resolved per call, not once at import, so `KEEL_HOME` can redirect it — that is
 * what keeps the test suite (and anyone running keel against a scratch home) from
 * writing into the real `~/.keel`.
 */
export function projectsPath(): string {
  return join(process.env.KEEL_HOME ?? join(homedir(), ".keel"), "projects.json");
}

/**
 * The registry is a convenience index over resources that already exist in AWS —
 * DynamoDB stays the source of truth. So every operation here degrades to a no-op
 * rather than throwing: a missing, unreadable or corrupt file must never break a
 * per-repo command or fail a provision that already succeeded.
 */
export function readProjects(path = projectsPath()): ProjectResource[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { resources?: unknown };
    if (!Array.isArray(parsed?.resources)) return [];
    return parsed.resources.filter(
      (r): r is ProjectResource =>
        !!r && typeof (r as ProjectResource).name === "string" && typeof (r as ProjectResource).kind === "string",
    );
  } catch {
    return [];
  }
}

function writeProjects(resources: ProjectResource[], path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, resources }, null, 2) + "\n");
  } catch {
    // ponytail: swallowed on purpose — see the note above. Losing the index is
    // recoverable (the resource is still in DynamoDB); failing the command is not.
  }
}

/** Upsert by (kind, name) so a redeploy refreshes the entry instead of duplicating it. */
export function recordResource(res: ProjectResource, path = projectsPath()): void {
  const others = readProjects(path).filter((r) => !(r.kind === res.kind && r.name === res.name));
  writeProjects([...others, res], path);
}

export function forgetResource(kind: ResourceKind, name: string, path = projectsPath()): void {
  writeProjects(readProjects(path).filter((r) => !(r.kind === kind && r.name === name)), path);
}

/** Rendered lines for `keel status --all`. Pure, so it is cheap to test. */
export function formatProjects(resources: ProjectResource[]): string[] {
  if (!resources.length) {
    return ["no keel resources recorded on this machine — deploy an app or create a database first"];
  }
  const byProject = new Map<string, ProjectResource[]>();
  for (const r of resources) {
    byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  }
  const order: ResourceKind[] = ["app", "db", "auth"];
  const lines: string[] = [];
  for (const project of [...byProject.keys()].sort()) {
    const rows = byProject.get(project)!;
    const regions = [...new Set(rows.map((r) => r.region))].sort();
    lines.push(`${project}  (${regions.join(", ")})`);
    const sorted = [...rows].sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
    for (const r of sorted) {
      lines.push(`  ${r.kind.padEnd(4)}  ${r.name.padEnd(20)}  ${r.stack.padEnd(24)}  ${r.url ?? r.repoPath ?? ""}`.trimEnd());
    }
  }
  lines.push("");
  lines.push("cost per project: AWS Cost Explorer, grouped by the keel:project tag");
  return lines;
}
