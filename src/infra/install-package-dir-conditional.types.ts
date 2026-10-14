export type PackageDirectoryCondition = { kind: "absent" } | { kind: "revision"; revision: string };

export type ConditionalInstallReceipt = {
  requestId: string;
  binding: string;
  workspaceDir: string;
  workspaceIdentity: string;
  targetDir: string;
  operationDir: string;
  stageDir: string;
  backupDir: string;
  rootIdentity?: string;
  operationIdentity?: string;
  stageIdentity?: string;
  backupIdentity?: string;
  revision?: string;
  phase:
    | "intent"
    | "prepared"
    | "detaching"
    | "detached"
    | "restoring"
    | "publishing"
    | "installed"
    | "conflict";
  error?: string;
  publicationObserved?: boolean;
  recoveryRequired?: boolean;
};

export type ConditionalInstallResult = {
  requestId: string;
  status: "installed" | "conflict" | "recovery-required";
  targetDir: string;
  stageDir?: string;
  backupDir?: string;
  revision?: string;
  recordedPhase?: ConditionalInstallReceipt["phase"];
  publicationObserved?: boolean;
  current?: ConditionalDestinationObservation;
  owningRequestId?: string;
  repeated?: boolean;
};

export type ConditionalInstallClaim =
  | { fresh: boolean; receipt: ConditionalInstallReceipt }
  | { conflict: string; owningRequestId?: string };

export type ConditionalPackageInstall = {
  requestId: string;
  binding: string;
  workspaceDir: string;
  workspaceIdentity: string;
  condition: PackageDirectoryCondition;
  sourceRevision: string;
  readRevision: (directory: string) => Promise<string>;
  prepareStage: (directory: string) => Promise<void>;
  /** Workspace tracking only. The published tree must never be mutated here. */
  afterPublication: (assertPublished: () => void) => Promise<void>;
  journal: {
    claim: (receipt: ConditionalInstallReceipt) => Promise<ConditionalInstallClaim>;
    save: (receipt: ConditionalInstallReceipt) => Promise<void>;
    assertCurrent: () => void;
  };
};

export type ConditionalDestinationObservation =
  | { state: "absent" }
  | { state: "unreadable"; error: string }
  | {
      state: "present";
      identity: string;
      revision?: string;
      matchesPublished?: boolean;
      error?: string;
    };
