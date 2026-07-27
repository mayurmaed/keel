import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Provisioning commands write a machine-level registry under ~/.keel by default.
// Point KEEL_HOME at a throwaway directory so a test run can never touch the real one.
const home = mkdtempSync(join(tmpdir(), "keel-test-home-"));
process.env.KEEL_HOME = home;

afterAll(() => rmSync(home, { recursive: true, force: true }));
