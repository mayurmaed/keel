import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAppConfig, loadAppConfig, saveAppConfig, type AppConfig } from "../src/config";

const tmp = () => mkdtempSync(join(tmpdir(), "keel-test-"));

describe("validateAppConfig", () => {
  it("accepts a valid local config", () => {
    expect(validateAppConfig({ name: "my-app", port: 3000, target: "local" })).toEqual([]);
  });

  it("rejects bad name, port, and target with one error each", () => {
    const errs = validateAppConfig({ name: "My App", port: 0, target: "cloud" });
    expect(errs).toHaveLength(3);
  });

  it("requires a github https repo for the aws target", () => {
    const errs = validateAppConfig({ name: "web", port: 80, target: "aws" });
    expect(errs.join()).toMatch(/repo/);
    expect(
      validateAppConfig({ name: "web", port: 80, target: "aws", repo: "https://github.com/me/web" }),
    ).toEqual([]);
  });

  it("rejects repo URLs with trailing garbage, accepts optional .git", () => {
    expect(
      validateAppConfig({ name: "web", port: 80, target: "aws", repo: "https://github.com/me/web/extra" }),
    ).toHaveLength(1);
    expect(
      validateAppConfig({ name: "web", port: 80, target: "aws", repo: "https://github.com/me/web.git" }),
    ).toEqual([]);
  });

  it("rejects wrong types for branch, env, healthPath, dir", () => {
    const errs = validateAppConfig({
      name: "web", port: 80, target: "local",
      branch: 5, env: "oops", healthPath: "nope", dir: "/abs",
    });
    expect(errs).toHaveLength(4);
  });

  it("accepts a relative dir", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", dir: "sample-app" })).toEqual([]);
  });
});

describe("load/save", () => {
  it("round-trips and applies defaults", () => {
    const dir = tmp();
    saveAppConfig(dir, { name: "web", port: 3000, target: "local" } as AppConfig);
    const cfg = loadAppConfig(dir);
    expect(cfg.branch).toBe("main");
    expect(cfg.env).toEqual({});
    expect(cfg.healthPath).toBe("/");
  });

  it("throws a keel-new hint when keel.json is missing", () => {
    expect(() => loadAppConfig(tmp())).toThrow(/keel new/);
  });

  it("throws on invalid stored config", () => {
    const dir = tmp();
    saveAppConfig(dir, { name: "BAD NAME", port: 3000, target: "local" } as AppConfig);
    expect(() => loadAppConfig(dir)).toThrow(/name/);
  });

  it("rejects db field if not matching DB_NAME_RE pattern", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", db: "My-DB" })).toContainEqual(
      expect.stringMatching(/db must be a lowercase/),
    );
  });

  it("accepts valid db field", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", db: "api_db" })).toEqual([]);
  });

  it("rejects project field if not a string", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", project: 5 })).toContainEqual(
      expect.stringMatching(/project must be a string/),
    );
  });

  it("accepts valid project field", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", project: "my-project" })).toEqual([]);
  });
});
