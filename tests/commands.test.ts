import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCommand } from "../src/commands/new";
import { envCommand } from "../src/commands/env";
import { loadAppConfig } from "../src/config";

const tmp = () => mkdtempSync(join(tmpdir(), "bareboat-test-"));

describe("newCommand (non-interactive)", () => {
  it("writes a valid bareboat.json from flags", async () => {
    const dir = tmp();
    await newCommand({ name: "web", port: "3000", target: "local" }, dir);
    const cfg = loadAppConfig(dir);
    expect(cfg).toMatchObject({ name: "web", port: 3000, target: "local", branch: "main" });
  });

  it("rejects invalid flags with the validation errors", async () => {
    await expect(newCommand({ name: "BAD", port: "3000", target: "local" }, tmp())).rejects.toThrow(/name/);
  });
});

describe("envCommand", () => {
  it("sets, lists, and unsets vars in bareboat.json", async () => {
    const dir = tmp();
    await newCommand({ name: "web", port: "3000", target: "local" }, dir);
    envCommand("set", ["A=1", "B=x=y"], dir);
    expect(loadAppConfig(dir).env).toEqual({ A: "1", B: "x=y" });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    envCommand("list", [], dir);
    expect(log.mock.calls.flat().join("\n")).toContain("A=1");
    log.mockRestore();

    envCommand("unset", ["A"], dir);
    expect(loadAppConfig(dir).env).toEqual({ B: "x=y" });
  });

  it("rejects malformed set pairs", async () => {
    const dir = tmp();
    await newCommand({ name: "web", port: "3000", target: "local" }, dir);
    expect(() => envCommand("set", ["NOVALUE"], dir)).toThrow(/KEY=VALUE/);
  });
});
