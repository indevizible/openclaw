-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "skill_local_install_requests" (
  "request_id" text COLLATE "C" NOT NULL,
  "binding" text COLLATE "C" NOT NULL,
  "target_key" text COLLATE "C" NOT NULL,
  "active" bigint NOT NULL,
  "receipt_json" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("request_id"),
  CHECK (("active" IN (0, 1)))
);

CREATE UNIQUE INDEX "idx_skill_local_install_active_target" ON "skill_local_install_requests" (("target_key") ASC NULLS FIRST) WHERE ("active" = 1);
