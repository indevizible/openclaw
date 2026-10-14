import {
  installDirectoryIdentity,
  observeConditionalInstallReceipt,
  recoverConditionalPackageDir,
} from "../../infra/install-package-dir-conditional.js";
import type { ConditionalPackageInstall } from "../../infra/install-package-dir-conditional.types.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  assertLocalSkillWorkspace,
  readInstalledSkillRevision,
  resolveLocalSkillDestination,
} from "./installed-revision.js";

/** Requires offline custody for the whole attempt; the shared actor owns database access. */
export function createConditionalInstallJournal(
  assertAllowed: () => void,
): ConditionalPackageInstall["journal"] {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    assertAllowed();
    if (!context.maintenanceScope?.ownsSchemaMaintenance) {
      throw new Error(
        "Conditional skill installation requires exclusive offline SQLite maintenance custody; use skills install or skills recover.",
      );
    }
    context.maintenanceScope.assertDatabaseAccess(context.admission.databasePath);
    context.admission.assertCurrent();
  };
  const admission = {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  };
  return {
    assertCurrent,
    claim: (receipt) =>
      runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute({ type: "conditionalSkillInstall.claim", input: receipt }),
        admission,
      ),
    save: (receipt) =>
      runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute({ type: "conditionalSkillInstall.save", input: receipt }),
        admission,
      ),
  };
}

/** Existing-state read only: does not initialize the feature table or settle requests. */
async function readConditionalInstallReceipt(requestId: string) {
  const reply = await executeExistingOpenClawStateRead(
    {},
    {
      type: "conditionalSkillInstall.receipt",
      input: requestId,
    },
    { current: true },
  );
  return reply?.receipt;
}

async function requestDestination(params: {
  workspaceDir: string;
  slug: string;
  requestId: string;
}) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(params.requestId)) {
    throw new Error("Invalid conditional request ID.");
  }
  const destination = await resolveLocalSkillDestination(params);
  const workspaceIdentity = installDirectoryIdentity(destination.workspaceDir);
  const readReceipt = async () => {
    const receipt = await readConditionalInstallReceipt(params.requestId);
    if (!receipt) {
      throw new Error("No conditional request receipt exists for this ID.");
    }
    if (
      receipt.workspaceDir !== destination.workspaceDir ||
      receipt.workspaceIdentity !== workspaceIdentity ||
      receipt.targetDir !== destination.targetDir
    ) {
      throw new Error("Request ID belongs to a different destination or workspace identity.");
    }
    return receipt;
  };
  return { ...destination, workspaceIdentity, readReceipt };
}

export async function inspectConditionalSkillRequest(params: {
  workspaceDir: string;
  slug: string;
  requestId: string;
}) {
  const destination = await requestDestination(params);
  const receipt = await destination.readReceipt();
  return {
    slug: destination.slug,
    receipt,
    observations: await observeConditionalInstallReceipt(receipt, readInstalledSkillRevision),
  };
}

export async function recoverConditionalSkillRequest(params: {
  workspaceDir: string;
  slug: string;
  requestId: string;
}) {
  const destination = await requestDestination(params);
  return recoverConditionalPackageDir({
    ...destination,
    readRevision: readInstalledSkillRevision,
    journal: createConditionalInstallJournal(() => assertLocalSkillWorkspace(params.workspaceDir)),
  });
}
