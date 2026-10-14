import fs from "node:fs/promises";
import path from "node:path";
import { writeJson } from "../../infra/json-files.js";
import { untrackClawHubSkill } from "./clawhub-store.js";
import type { WorkspaceSkillLifecycle } from "./workspace-types.js";

export type { SkillSourceOrigin } from "./workspace-types.js";

/** Prepare native provenance; conditional installs call this only in their owned stage. */
export async function prepareSkillSourceMetadata(
  params: Parameters<WorkspaceSkillLifecycle["recordSkillSourceInstall"]>[0],
): Promise<void> {
  await Promise.all([
    fs.rm(path.join(params.targetDir, ".clawhub"), { recursive: true, force: true }),
    fs.rm(path.join(params.targetDir, ".clawdhub"), { recursive: true, force: true }),
  ]);
  await writeJson(path.join(params.targetDir, ".openclaw", "source-origin.json"), params.origin, {
    trailingNewline: true,
  });
}

/** Ordinary source installs retain their shipped post-publication tracking behavior. */
export async function recordSkillSourceInstall(
  params: Parameters<WorkspaceSkillLifecycle["recordSkillSourceInstall"]>[0],
): Promise<void> {
  await prepareSkillSourceMetadata(params);
  await untrackClawHubSkill(params.workspaceDir, params.origin.slug);
}
