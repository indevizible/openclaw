import path from "node:path";
import type {
  ConditionalInstallClaim,
  ConditionalInstallReceipt,
} from "../../infra/install-package-dir-conditional.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../../infra/sqlite-schema-ensure.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";

const ensureSchema = createSqliteSchemaEnsurer(
  () =>
    getOpenClawStateFeatureSchemaSql("skill_local_install_requests", {
      endMarker: "CREATE TABLE IF NOT EXISTS skill_uploads (",
      includeEndMarker: false,
    }),
  { tables: ["skill_local_install_requests"], indexes: ["idx_skill_local_install_active_target"] },
);

function durableWrite<T>(
  context: WorkerWriteOperationContext,
  write: (database: ReturnType<WorkerWriteOperationContext["open"]>) => T,
): T {
  const { db } = context.open();
  if (isPostgresSqlConnection(db) || db.isTransaction) {
    throw new Error("Conditional local installs require an independently admitted SQLite writer.");
  }
  // The shared owner normally uses NORMAL. Each receipt must reach storage before a tree move.
  db.exec("PRAGMA synchronous = FULL"); // sqlite-allow-raw -- Operation-scoped durability primitive, outside BEGIN.
  try {
    return context.writeAdmitted(write);
  } finally {
    db.exec("PRAGMA synchronous = NORMAL"); // sqlite-allow-raw -- Restore the shared owner's configured default.
  }
}

export const conditionalSkillInstallOperations = {
  "conditionalSkillInstall.claim": (
    receipt: ConditionalInstallReceipt,
    context: WorkerWriteOperationContext,
  ) =>
    durableWrite<ConditionalInstallClaim>(context, ({ db }) => {
      ensureSchema(db);
      const kysely = getNodeSqliteKysely<Pick<DB, "skill_local_install_requests">>(db);
      // Conservatively serialize ASCII slug aliases on case-insensitive filesystems too.
      const targetKey = `${receipt.workspaceIdentity}:skills/${path.basename(receipt.targetDir).toLowerCase()}`;
      const prior = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("skill_local_install_requests")
          .selectAll()
          .where("request_id", "=", receipt.requestId),
      );
      if (prior) {
        if (prior.binding !== receipt.binding) {
          return { conflict: "Request ID is already bound to different install inputs." };
        }
        return {
          fresh: false,
          receipt: JSON.parse(prior.receipt_json) as ConditionalInstallReceipt,
        };
      }
      const active = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("skill_local_install_requests")
          .select("request_id")
          .where("target_key", "=", targetKey)
          .where("active", "=", 1),
      );
      if (active) {
        return {
          conflict: `Conditional install conflict: request ${active.request_id} owns this target; inspect or recover that request.`,
          owningRequestId: active.request_id,
        };
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("skill_local_install_requests").values({
          request_id: receipt.requestId,
          binding: receipt.binding,
          target_key: targetKey,
          active: 1,
          receipt_json: JSON.stringify(receipt),
        }),
      );
      return { fresh: true, receipt };
    }),
  "conditionalSkillInstall.save": (
    receipt: ConditionalInstallReceipt,
    context: WorkerWriteOperationContext,
  ) =>
    durableWrite<void>(context, ({ db }) => {
      const kysely = getNodeSqliteKysely<Pick<DB, "skill_local_install_requests">>(db);
      const updated = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("skill_local_install_requests")
          .set({
            active: receipt.phase === "installed" || receipt.phase === "conflict" ? 0 : 1,
            receipt_json: JSON.stringify(receipt),
          })
          .where("request_id", "=", receipt.requestId)
          .where("binding", "=", receipt.binding),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("Conditional install receipt is missing or changed.");
      }
    }),
};

export const conditionalSkillInstallReadOperations = {
  "conditionalSkillInstall.receipt": (requestId: string, db: EngineConnection) => {
    const row = tableExists(db, "skill_local_install_requests")
      ? executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<Pick<DB, "skill_local_install_requests">>(db)
            .selectFrom("skill_local_install_requests")
            .select("receipt_json")
            .where("request_id", "=", requestId),
        )
      : undefined;
    return {
      type: "conditionalSkillInstall.receipt" as const,
      receipt: row ? (JSON.parse(row.receipt_json) as ConditionalInstallReceipt) : undefined,
    };
  },
};
