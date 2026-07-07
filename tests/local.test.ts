import { describe, it, expect } from "vitest";
import { deployLocal, type Exec } from "../src/targets/local";
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
