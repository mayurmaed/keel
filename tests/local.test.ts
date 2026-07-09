import { describe, it, expect, vi } from "vitest";
import { deployLocal, listLocal, destroyLocal, shellExec, captureExec, type Exec } from "../src/targets/local";
import type { AppConfig } from "../src/config";

const cfg: AppConfig = {
  name: "web", branch: "main", port: 3000, target: "local",
  env: { API_KEY: "abc" }, healthPath: "/",
};

function fakeExec() {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  return { calls, exec };
}

describe("deployLocal", () => {
  it("builds, replaces any old container, and runs with port + env", async () => {
    const { calls, exec } = fakeExec();
    const url = await deployLocal(cfg, "/app/dir", exec);
    expect(url).toBe("http://localhost:3000");
    expect(calls[0]).toEqual(["docker", "build", "-t", "keel/web", "/app/dir"]);
    expect(calls[1]).toEqual(["docker", "rm", "-f", "keel-web"]);
    expect(calls[2]).toEqual([
      "docker", "run", "-d", "--name", "keel-web", "--label", "keel=1",
      "--restart", "unless-stopped", "-p", "3000:3000", "-e", "API_KEY=abc", "keel/web",
    ]);
  });

  it("ignores rm -f failure (first-ever deploy)", async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "rm") throw new Error("No such container");
      return "";
    };
    await expect(deployLocal(cfg, ".", exec)).resolves.toBe("http://localhost:3000");
  });

  it("propagates build failure", async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "build") throw new Error("docker exited 1");
      return "";
    };
    await expect(deployLocal(cfg, ".", exec)).rejects.toThrow(/exited 1/);
  });
});

describe("listLocal", () => {
  it("lists keel containers via label filter", async () => {
    const { calls, exec } = fakeExec();
    await listLocal(exec);
    expect(calls[0]).toEqual([
      "docker", "ps", "--filter", "label=keel=1",
      "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}",
    ]);
  });

  it("returns [] when output is empty and lines otherwise", async () => {
    expect(await listLocal(async () => "")).toEqual([]);
    expect(await listLocal(async () => "keel-web\tUp 2 minutes\t3000")).toEqual([
      "keel-web\tUp 2 minutes\t3000",
    ]);
  });
});

describe("destroyLocal", () => {
  it("force-removes the container by name", async () => {
    const { calls, exec } = fakeExec();
    await destroyLocal("web", exec);
    expect(calls[0]).toEqual(["docker", "rm", "-f", "keel-web"]);
  });
});

describe("exec implementations", () => {
  it("shellExec streams and returns stdout", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await shellExec("node", ["-e", "process.stdout.write('ping')"]);
    expect(result).toBe("ping");
    // spy is called with Buffer containing "ping"
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0].toString()).toContain("ping");
    spy.mockRestore();
  });

  it("captureExec returns stdout without streaming", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await captureExec("node", ["-e", "process.stdout.write('ping')"]);
    expect(result).toBe("ping");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("includes captured stderr in the failure error", async () => {
    const spyOut = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        captureExec("node", ["-e", "process.stderr.write('boom'); process.exit(3)"]),
      ).rejects.toThrow(/exited 3.*boom/s);
    } finally {
      spyOut.mockRestore();
      spyErr.mockRestore();
    }
  });
});
