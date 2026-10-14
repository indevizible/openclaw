import type { Command } from "commander";
import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveCliParentCommandPath } from "./parent-command-path.js";

/** Inspection always emits JSON; verification does unless a Markdown card is requested. */
export function isSkillsMachineOutput(argv: readonly string[], command?: Command): boolean {
  const subcommand = resolveCliParentCommandPath(argv, "skills")?.[1];
  return (
    subcommand === "inspect" ||
    (subcommand === "verify" && !hasMachineOutputOption(argv, "--card", command))
  );
}
