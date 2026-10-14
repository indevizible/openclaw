import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveWorkspaceSkillInstallDir, validateRequestedSkillSlug } from "./install-paths.js";

function sameObservation(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Complete local-tree revision, independent of the shipped ClawHub digest format. */
export async function readInstalledSkillRevision(directory: string): Promise<string> {
  const scoped = await root(directory, { symlinks: "reject", hardlinks: "reject" });
  const observations = new Map<string, BigIntStats>();
  const entries: Array<{
    path: string;
    mode: number;
    type: "directory" | "file";
    sha256?: string;
  }> = [];
  const visit = async (relative: string): Promise<void> => {
    const filename = path.join(directory, relative);
    const stat = await fs.lstat(filename, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1n)
    ) {
      throw new Error(`Unsupported skill tree entry: ${filename}`);
    }
    observations.set(filename, stat);
    const entry = { path: relative.split(path.sep).join("/"), mode: Number(stat.mode & 0o7777n) };
    if (stat.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      const names = (await fs.readdir(filename, { encoding: "buffer" })).map((bytes) => {
        const name = bytes.toString("utf8");
        if (!bytes.equals(Buffer.from(name))) {
          throw new Error(`Unsupported non-UTF-8 skill name in: ${filename}`);
        }
        return name;
      });
      for (const name of names.toSorted()) {
        await visit(path.join(relative, name));
      }
      return;
    }
    const opened = await scoped.open(relative, { symlinks: "reject", hardlinks: "reject" });
    try {
      if (!sameObservation(stat, await opened.handle.stat({ bigint: true }))) {
        throw new Error(`Skill tree changed while reading: ${filename}`);
      }
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0n;
      for (;;) {
        const { bytesRead } = await opened.handle.read(buffer);
        if (!bytesRead) {
          break;
        }
        size += BigInt(bytesRead);
        if (size > stat.size) {
          throw new Error(`Skill tree grew while reading: ${filename}`);
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (
        size !== stat.size ||
        !sameObservation(stat, await opened.handle.stat({ bigint: true }))
      ) {
        throw new Error(`Skill tree changed while reading: ${filename}`);
      }
      entries.push({ ...entry, type: "file", sha256: hash.digest("hex") });
    } finally {
      await opened.handle.close();
    }
  };
  await visit("");
  // Detect edits to earlier files and directory membership during the walk; this is not a snapshot/CAS.
  for (const [filename, stat] of observations) {
    if (!sameObservation(stat, await fs.lstat(filename, { bigint: true }))) {
      throw new Error(`Skill tree changed while reading: ${filename}`);
    }
  }
  return `skill-v1:sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

export function assertLocalSkillWorkspace(workspaceDir: string): void {
  if (getAgentWorkspaceAccess(workspaceDir)) {
    throw new Error(
      "Conditional skill installation and inspection require a local workspace filesystem.",
    );
  }
}

/** Resolve the writable destination, never a discovery-selected skill of the same name. */
export async function resolveLocalSkillDestination(params: { workspaceDir: string; slug: string }) {
  assertLocalSkillWorkspace(params.workspaceDir);
  const slug = validateRequestedSkillSlug(params.slug);
  const workspaceDir = await fs.realpath(params.workspaceDir);
  const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, slug);
  try {
    const skills = await fs.lstat(path.dirname(targetDir));
    if (!skills.isDirectory() || skills.isSymbolicLink()) {
      throw new Error("Conditional skills require a real workspace skills directory.");
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return { slug, workspaceDir, targetDir };
}

export async function inspectSkillDestination(params: { workspaceDir: string; slug: string }) {
  const destination = await resolveLocalSkillDestination(params);
  try {
    await fs.lstat(destination.targetDir);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { ...destination, state: "absent" as const };
    }
    throw error;
  }
  return {
    ...destination,
    state: "present" as const,
    revision: await readInstalledSkillRevision(destination.targetDir),
  };
}
