import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjects, recordResource, forgetResource, formatProjects, type ProjectResource,
} from "../src/aws/projects";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bareboat-projects-"));
  path = join(dir, "projects.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function res(over: Partial<ProjectResource> = {}): ProjectResource {
  return {
    kind: "app", name: "web", project: "acme", region: "ap-south-1",
    stack: "bareboat-app-web", createdAt: "2026-07-27T00:00:00.000Z", ...over,
  };
}

describe("project registry (#18)", () => {
  it("records a resource and reads it back", () => {
    recordResource(res(), path);
    expect(readProjects(path)).toEqual([res()]);
  });

  it("upserts by (kind, name) so a redeploy refreshes rather than duplicates", () => {
    recordResource(res({ url: "http://old" }), path);
    recordResource(res({ url: "http://new" }), path);
    const all = readProjects(path);
    expect(all).toHaveLength(1);
    expect(all[0].url).toBe("http://new");
  });

  it("keeps same-named resources of different kinds apart", () => {
    recordResource(res({ kind: "app", name: "shared" }), path);
    recordResource(res({ kind: "db", name: "shared", stack: "bareboat-db-shared" }), path);
    expect(readProjects(path)).toHaveLength(2);

    forgetResource("db", "shared", path);
    const left = readProjects(path);
    expect(left).toHaveLength(1);
    expect(left[0].kind).toBe("app");
  });

  it("forgetting a resource that was never recorded is a no-op", () => {
    recordResource(res(), path);
    forgetResource("app", "nope", path);
    expect(readProjects(path)).toHaveLength(1);
  });

  it("creates the parent directory when it does not exist yet", () => {
    const nested = join(dir, "deeper", "projects.json");
    recordResource(res(), nested);
    expect(existsSync(nested)).toBe(true);
    expect(readProjects(nested)).toHaveLength(1);
  });

  // Graceful degradation: the registry is an index, DynamoDB is the source of truth.
  it("returns an empty list when the file is missing", () => {
    expect(readProjects(join(dir, "absent.json"))).toEqual([]);
  });

  it("returns an empty list rather than throwing on a corrupt file", () => {
    writeFileSync(path, "{ this is not json");
    expect(readProjects(path)).toEqual([]);
  });

  it("ignores a well-formed file whose resources key is the wrong shape", () => {
    writeFileSync(path, JSON.stringify({ version: 1, resources: "nope" }));
    expect(readProjects(path)).toEqual([]);
  });

  it("drops junk entries but keeps the valid ones", () => {
    writeFileSync(path, JSON.stringify({ version: 1, resources: [res(), null, 42, { kind: "db" }] }));
    expect(readProjects(path)).toEqual([res()]);
  });

  it("overwrites a corrupt file on the next record instead of staying broken", () => {
    writeFileSync(path, "garbage");
    recordResource(res(), path);
    expect(readProjects(path)).toEqual([res()]);
  });

  it("does not throw when the registry path cannot be written", () => {
    // A path whose parent is a file, not a directory — mkdir and write both fail.
    const blocked = join(path, "nested", "projects.json");
    writeFileSync(path, "{}");
    expect(() => recordResource(res(), blocked)).not.toThrow();
  });
});

describe("status --all output", () => {
  it("explains what to do when nothing is recorded", () => {
    expect(formatProjects([]).join("\n")).toMatch(/no bareboat resources recorded/);
  });

  it("groups by project, orders app > db > auth, and points at the cost tag", () => {
    const lines = formatProjects([
      res({ kind: "auth", name: "login", stack: "bareboat-auth-login", project: "acme" }),
      res({ kind: "db", name: "maindb", stack: "bareboat-db-maindb", project: "acme" }),
      res({ kind: "app", name: "web", stack: "bareboat-app-web", project: "acme" }),
      res({ kind: "app", name: "site", stack: "bareboat-app-site", project: "blog" }),
    ]);
    const text = lines.join("\n");
    expect(lines[0]).toBe("acme  (ap-south-1)");
    expect(lines[1]).toMatch(/^ {2}app {3}web/);
    expect(lines[2]).toMatch(/^ {2}db {4}maindb/);
    expect(lines[3]).toMatch(/^ {2}auth {2}login/);
    // "blog" sorts after "acme" and starts its own group
    expect(text.indexOf("blog  (")).toBeGreaterThan(text.indexOf("acme  ("));
    expect(text).toMatch(/bareboat:project tag/);
  });

  it("lists every region a project spans", () => {
    const lines = formatProjects([
      res({ region: "ap-south-1" }),
      res({ kind: "db", name: "maindb", region: "us-east-1" }),
    ]);
    expect(lines[0]).toBe("acme  (ap-south-1, us-east-1)");
  });
});
