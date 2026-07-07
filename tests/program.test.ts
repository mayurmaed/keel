import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/program";

describe("program", () => {
  it("is named keel with a version", () => {
    const p = buildProgram();
    expect(p.name()).toBe("keel");
    expect(p.version()).toBe("0.1.0");
  });
});
