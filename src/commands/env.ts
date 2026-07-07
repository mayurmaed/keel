import { loadAppConfig, saveAppConfig } from "../config.js";

export function envCommand(action: "set" | "unset" | "list", pairs: string[], dir = process.cwd()): void {
  const cfg = loadAppConfig(dir);
  if (action === "list") {
    for (const [k, v] of Object.entries(cfg.env)) console.log(`${k}=${v}`);
    return;
  }
  if (action === "set") {
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i < 1) throw new Error(`expected KEY=VALUE, got "${p}"`);
      cfg.env[p.slice(0, i)] = p.slice(i + 1);
    }
  } else {
    for (const k of pairs) delete cfg.env[k];
  }
  saveAppConfig(dir, cfg);
  console.log("saved — run `keel deploy` to apply");
}
