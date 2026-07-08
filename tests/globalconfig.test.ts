import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig, writeGlobalConfig } from "../src/aws/globalconfig.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");

describe("global config", () => {
  it("round-trips", () => {
    const p = tmpPath();
    writeGlobalConfig({ region: "ap-south-1" }, p);
    expect(readGlobalConfig(p)).toEqual({ region: "ap-south-1" });
  });

  it("throws a keel-setup hint when missing", () => {
    expect(() => readGlobalConfig(tmpPath())).toThrow(/keel setup/);
  });
});
