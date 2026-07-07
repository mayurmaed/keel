import { Command } from "commander";

export function buildProgram(): Command {
  return new Command("keel")
    .version("0.1.0")
    .description("Deploy apps to your own AWS account (or local Docker)");
}
