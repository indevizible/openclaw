import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { syncDirectory } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import type {
  ConditionalDestinationObservation,
  ConditionalInstallReceipt,
  ConditionalInstallResult,
  ConditionalPackageInstall,
} from "./install-package-dir-conditional.types.js";
import { moveInstallDirectoryNoReplace } from "./install-package-dir-native.js";
import type { installPackageDir } from "./install-package-dir.js";

const operations = new KeyedAsyncQueue();
const targetKey = (workspaceIdentity: string, targetDir: string) =>
  `${workspaceIdentity}:skills/${path.basename(targetDir).toLowerCase()}`;

export function installDirectoryIdentity(directory: string): string {
  const stat = fsSync.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${directory}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

async function syncParent(directory: string): Promise<void> {
  const outcome = await syncDirectory(directory);
  if (outcome.status === "unsupported") {
    throw new Error(
      "Conditional skill install is unsupported without durable directory synchronization.",
    );
  }
}

async function syncPreparedTree(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncPreparedTree(filename);
    } else {
      const file = await fs.open(filename, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
  await syncParent(directory);
}

async function observe(directory: string): Promise<ConditionalDestinationObservation> {
  try {
    const stat = await fs.lstat(directory, { bigint: true });
    return { state: "present", identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    return hasErrnoCode(error, "ENOENT")
      ? { state: "absent" }
      : { state: "unreadable", error: String(error) };
  }
}

export async function observeConditionalInstallReceipt(
  receipt: ConditionalInstallReceipt,
  readRevision: ConditionalPackageInstall["readRevision"],
) {
  const target = await observe(receipt.targetDir);
  if (target.state === "present") {
    try {
      target.revision = await readRevision(receipt.targetDir);
      target.matchesPublished =
        target.identity === receipt.stageIdentity &&
        target.revision === receipt.revision &&
        installDirectoryIdentity(receipt.targetDir) === target.identity;
    } catch (error) {
      target.error = String(error);
      target.matchesPublished = false;
    }
  }
  return {
    target,
    stage: await observe(receipt.stageDir),
    backup: await observe(receipt.backupDir),
    operation: await observe(receipt.operationDir),
  };
}

type OperationContext = Pick<ConditionalPackageInstall, "journal" | "readRevision"> & {
  beforePersistentApply?: () => void;
  authorizeMutation?: () => Promise<void>;
};

/** One publication/reconciliation owner; never deletes or republishes recorded artifacts. */
function conditionalOperation(receipt: ConditionalInstallReceipt, context: OperationContext) {
  const rootDir = path.dirname(receipt.targetDir);
  const assertCurrent = () => {
    context.journal.assertCurrent();
    context.beforePersistentApply?.();
    if (
      installDirectoryIdentity(receipt.workspaceDir) !== receipt.workspaceIdentity ||
      (receipt.rootIdentity && installDirectoryIdentity(rootDir) !== receipt.rootIdentity) ||
      (receipt.operationIdentity &&
        installDirectoryIdentity(receipt.operationDir) !== receipt.operationIdentity)
    ) {
      throw new Error("Conditional install workspace or staging namespace changed.");
    }
  };
  const assertPublished = () => {
    assertCurrent();
    if (installDirectoryIdentity(receipt.targetDir) !== receipt.stageIdentity) {
      throw new Error("Published target changed; successor tracking must be preserved.");
    }
  };
  const save = async (phase: ConditionalInstallReceipt["phase"]) => {
    assertCurrent();
    await context.journal.save({ ...receipt, phase });
    receipt.phase = phase;
  };
  const move = async (from: string, to: string, identity: string) => {
    assertCurrent();
    await moveInstallDirectoryNoReplace({
      rootDir,
      rootIdentity: receipt.rootIdentity!,
      from: path.relative(rootDir, from),
      to: path.relative(rootDir, to),
      sourceIdentity: identity,
      assertCurrent,
      authorizeMutation: context.authorizeMutation,
    });
    // Root.move does not sync either parent entry.
    await syncParent(path.dirname(from));
    await syncParent(path.dirname(to));
  };
  const result = async (repeated = false, unresolved?: unknown) => {
    const observations = await observeConditionalInstallReceipt(receipt, context.readRevision);
    const status =
      unresolved || receipt.recoveryRequired
        ? "recovery-required"
        : receipt.phase === "installed"
          ? "installed"
          : "conflict";
    const conditional: ConditionalInstallResult = {
      requestId: receipt.requestId,
      status,
      recordedPhase: receipt.phase,
      targetDir: receipt.targetDir,
      stageDir: receipt.stageDir,
      backupDir: receipt.backupDir,
      revision: receipt.revision,
      publicationObserved: receipt.publicationObserved,
      current: observations.target,
      ...(repeated ? { repeated } : {}),
    };
    if (
      status === "installed" &&
      observations.target.state === "present" &&
      observations.target.matchesPublished
    ) {
      return { ok: true as const, conditional };
    }
    const error =
      status === "installed"
        ? "Recorded outcome is installed, but the current destination is missing or changed. No installation was repeated."
        : formatErrorMessage(unresolved ?? receipt.error ?? "Destination condition conflicted.");
    return {
      ok: false as const,
      error:
        status === "recovery-required"
          ? `Recovery required: ${error}. Preserve target ${receipt.targetDir}, stage ${receipt.stageDir}, and backup ${receipt.backupDir}. Stop writers, inspect --request-id ${receipt.requestId}, then use skills recover with the same slug and request ID. No tree is automatically deleted.`
          : error,
      conditional,
      observations,
      ...(status === "recovery-required" ? { recoveryIncomplete: true } : {}),
    };
  };
  const conflict = async (error: string, recoveryRequired = false) => {
    receipt.error = error;
    receipt.recoveryRequired = recoveryRequired;
    await save("conflict");
  };
  const reconcile = async () => {
    try {
      if (receipt.phase === "installed" || receipt.phase === "conflict") {
        return await result(true);
      }
      assertCurrent();
      const facts = await observeConditionalInstallReceipt(receipt, context.readRevision);
      for (const [entry, identity] of [
        [facts.stage, receipt.stageIdentity],
        [facts.backup, receipt.backupIdentity],
      ] as const) {
        if (
          entry.state === "unreadable" ||
          (entry.state === "present" &&
            (identity ? entry.identity !== identity : receipt.phase !== "intent"))
        ) {
          return await result(
            true,
            "Recorded artifact identity is unreadable or rebound; no recovery effects were attempted.",
          );
        }
      }
      if (receipt.phase === "intent" || receipt.phase === "prepared") {
        await conflict("Interrupted before target mutation; retained staging artifacts.");
        return await result(true);
      }
      if (facts.target.state === "unreadable") {
        return await result(true, "Current target is unreadable.");
      }
      if (
        receipt.phase === "publishing" &&
        facts.stage.state === "absent" &&
        facts.target.state === "present" &&
        facts.target.matchesPublished
      ) {
        await syncParent(receipt.operationDir);
        await syncParent(rootDir);
        assertPublished();
        receipt.publicationObserved = true;
        // Reconciliation records the publication only; it never replays hooks or tracking writes.
        await save("installed");
      } else if (facts.target.state === "absent" && facts.backup.state === "present") {
        await save("restoring");
        await move(receipt.backupDir, receipt.targetDir, facts.backup.identity);
        await conflict(
          "Interrupted install; displaced tree restored without overwriting a destination.",
        );
      } else {
        const uncertainPublication =
          receipt.phase === "publishing" && facts.stage.state === "absent";
        const retainedBackup = facts.backup.state === "present";
        await conflict(
          uncertainPublication
            ? "Publication may have completed, but the current target no longer matches the prepared tree. Preserve all paths for operator review."
            : retainedBackup
              ? "Another destination exists; retained both it and the displaced backup."
              : "Interrupted install did not complete; retained all recorded paths.",
          uncertainPublication || retainedBackup,
        );
      }
      return await result(true);
    } catch (error) {
      return await result(true, error);
    }
  };
  return { assertCurrent, assertPublished, save, move, result, conflict, reconcile };
}

export function recoverConditionalPackageDir(
  params: OperationContext & {
    workspaceIdentity: string;
    targetDir: string;
    readReceipt: () => Promise<ConditionalInstallReceipt>;
  },
) {
  return operations.enqueue(targetKey(params.workspaceIdentity, params.targetDir), async () => {
    params.journal.assertCurrent();
    return conditionalOperation(await params.readReceipt(), params).reconcile();
  });
}

/** Conditional branch of installPackageDir, serialized with source-independent recovery. */
export async function installConditionalPackageDir(
  params: Parameters<typeof installPackageDir>[0],
) {
  const conditional = params.conditional;
  if (
    !conditional ||
    !params.sourceDir ||
    params.hasDeps ||
    params.afterBackup ||
    params.afterInstall
  ) {
    return { ok: false as const, error: "Unsupported conditional package install options." };
  }
  return operations.enqueue(
    targetKey(conditional.workspaceIdentity, params.targetDir),
    async () => {
      const rootDir = path.dirname(params.targetDir);
      const operationDir = path.join(rootDir, `.openclaw-conditional-${randomUUID()}`);
      const intent: ConditionalInstallReceipt = {
        requestId: conditional.requestId,
        binding: conditional.binding,
        workspaceDir: conditional.workspaceDir,
        workspaceIdentity: conditional.workspaceIdentity,
        targetDir: params.targetDir,
        operationDir,
        stageDir: path.join(operationDir, "stage"),
        backupDir: path.join(operationDir, "previous"),
        phase: "intent",
      };
      const unclaimed = (
        status: "conflict" | "recovery-required",
        error: string,
        owningRequestId?: string,
      ) => ({
        ok: false as const,
        error,
        conditional: {
          requestId: conditional.requestId,
          status,
          targetDir: params.targetDir,
          ...(owningRequestId ? { owningRequestId } : {}),
        },
        ...(status === "recovery-required" ? { recoveryIncomplete: true } : {}),
      });
      let claim;
      try {
        conditional.journal.assertCurrent();
        params.beforePersistentApply?.();
      } catch (error) {
        return unclaimed("conflict", String(error));
      }
      try {
        claim = await conditional.journal.claim(intent);
      } catch (error) {
        return unclaimed(
          "recovery-required",
          `Claim outcome is unknown: ${String(error)}. Use skills inspect/recover with this request ID; no artifact paths are confirmed.`,
        );
      }
      if ("conflict" in claim) {
        return unclaimed("conflict", claim.conflict, claim.owningRequestId);
      }
      const receipt = claim.receipt;
      const owner = conditionalOperation(receipt, {
        ...conditional,
        beforePersistentApply: params.beforePersistentApply,
        authorizeMutation: params.authorizeMutation,
      });
      if (!claim.fresh) {
        return owner.reconcile();
      }
      try {
        owner.assertCurrent();
        await fs.mkdir(rootDir, { recursive: true });
        receipt.rootIdentity = installDirectoryIdentity(rootDir);
        await fs.mkdir(receipt.operationDir, { mode: 0o700 });
        receipt.operationIdentity = installDirectoryIdentity(receipt.operationDir);
        await syncParent(conditional.workspaceDir);
        await syncParent(rootDir);
        await owner.save("intent");
        const probe = path.join(receipt.operationDir, "native-probe");
        await fs.mkdir(probe);
        await owner.move(probe, `${probe}-moved`, installDirectoryIdentity(probe));
        await fs.cp(params.sourceDir!, receipt.stageDir, {
          recursive: true,
          verbatimSymlinks: true,
        });
        if ((await conditional.readRevision(receipt.stageDir)) !== conditional.sourceRevision) {
          throw new Error(
            "Local source changed during staging or its modes could not be preserved.",
          );
        }
        await params.afterCopy?.(receipt.stageDir);
        if ((await conditional.readRevision(receipt.stageDir)) !== conditional.sourceRevision) {
          throw new Error("Staged source changed during install-policy evaluation.");
        }
        await conditional.prepareStage(receipt.stageDir);
        receipt.revision = await conditional.readRevision(receipt.stageDir);
        receipt.stageIdentity = installDirectoryIdentity(receipt.stageDir);
        await syncPreparedTree(receipt.stageDir);
        await syncParent(receipt.operationDir);
        await owner.save("prepared");
        if (conditional.condition.kind === "revision") {
          receipt.backupIdentity = installDirectoryIdentity(receipt.targetDir);
          await owner.save("detaching");
          await owner.move(receipt.targetDir, receipt.backupDir, receipt.backupIdentity);
          await owner.save("detached");
          let matches = false;
          try {
            matches =
              (await conditional.readRevision(receipt.backupDir)) ===
              conditional.condition.revision;
          } catch {
            /* Unsupported or changing displaced trees also need no-clobber restoration. */
          }
          if (!matches) {
            await owner.save("restoring");
            await owner.move(receipt.backupDir, receipt.targetDir, receipt.backupIdentity);
            await owner.conflict(
              "Installed revision did not match; the displaced tree was restored.",
            );
            return await owner.result();
          }
        }
        await owner.save("publishing");
        await owner.move(receipt.stageDir, receipt.targetDir, receipt.stageIdentity);
        receipt.publicationObserved = true;
        const facts = await observeConditionalInstallReceipt(receipt, conditional.readRevision);
        if (facts.target.state !== "present" || !facts.target.matchesPublished) {
          throw new Error(
            "Published target changed before completion; successor tracking was preserved.",
          );
        }
        owner.assertPublished();
        await conditional.afterPublication(owner.assertPublished);
        await owner.save("installed");
        return await owner.result();
      } catch (error) {
        receipt.error = String(error);
        try {
          if (receipt.phase === "intent" || receipt.phase === "prepared") {
            await owner.conflict(String(error));
            return await owner.result();
          }
          // A joined native call with the original stage still present and an occupied target
          // can be settled without another move. No native error alone proves non-execution.
          if (receipt.phase === "publishing" && !receipt.backupIdentity) {
            const stage = await observe(receipt.stageDir),
              target = await observe(receipt.targetDir);
            if (
              stage.state === "present" &&
              stage.identity === receipt.stageIdentity &&
              target.state === "present"
            ) {
              await owner.conflict(`Destination publication conflicted: ${String(error)}`);
              return await owner.result();
            }
          }
          await owner.save(receipt.phase);
        } catch {
          /* The last durable intent remains the recovery authority. */
        }
        return await owner.result(false, error);
      }
    },
  );
}
