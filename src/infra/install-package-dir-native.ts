import { Worker } from "node:worker_threads";

// Native configuration belongs only to this disposable worker. The host supplies live
// authority at fs-safe's synchronous mutation callback, after its awaited preparation.
const MOVE_SCRIPT = `
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
const gate = new Int32Array(workerData.gate);
(async () => {
  const { configureFsSafeNative, getFsSafeNativeStatus } = await import(workerData.configUrl);
  configureFsSafeNative({ mode: 'require' });
  const status = await getFsSafeNativeStatus({ probe: true });
  if (!status.loaded) throw new Error('Strict native no-replace is unsupported: ' + status.reason);
  const { root } = await import(workerData.rootUrl);
  const scoped = await root(workerData.rootDir, { hardlinks: 'reject', symlinks: 'reject' });
  const identity = (p) => { const s=fs.lstatSync(p,{bigint:true}); return s.dev+':'+s.ino; };
  const assertBeforeMutation = () => {
    Atomics.store(gate, 0, 0);
    parentPort.postMessage('authorize');
    const waited = Atomics.wait(gate, 0, 0, 30000);
    if (waited === 'timed-out' || Atomics.load(gate, 0) !== 1) throw new Error('Conditional install authority unavailable');
    if (identity(workerData.rootDir) !== workerData.rootIdentity ||
        identity(path.join(workerData.rootDir,workerData.from)) !== workerData.sourceIdentity) {
      throw new Error('Conditional install directory identity changed');
    }
  };
  await scoped.move(workerData.from, workerData.to, { overwrite: false, assertBeforeMutation });
})().then(() => parentPort.postMessage('moved'), (error) => {
  parentPort.postMessage({ error: String(error) });
});
`;

/** Never falls back to check+rename/copy. A rejected call may already have moved the tree. */
export async function moveInstallDirectoryNoReplace(params: {
  rootDir: string;
  rootIdentity: string;
  from: string;
  to: string;
  sourceIdentity: string;
  assertCurrent: () => void;
  authorizeMutation?: () => Promise<void>;
}): Promise<void> {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const { assertCurrent, authorizeMutation, ...input } = params;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(MOVE_SCRIPT)}`), {
    workerData: {
      ...input,
      gate: gate.buffer,
      configUrl: import.meta.resolve("@openclaw/fs-safe/config"),
      rootUrl: import.meta.resolve("@openclaw/fs-safe/root"),
    },
  });
  let moved = false;
  let failure: Error | undefined;
  const timer = setTimeout(() => {
    failure = new Error("Strict native move timed out; inspect retained paths.");
    void worker.terminate();
  }, 60_000);
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message: unknown) => {
        if (message === "authorize") {
          void (async () => {
            try {
              await authorizeMutation?.();
              assertCurrent();
              Atomics.store(gate, 0, 1);
            } catch (error) {
              failure = error instanceof Error ? error : new Error(String(error));
              Atomics.store(gate, 0, -1);
            }
            Atomics.notify(gate, 0);
          })();
        } else if (message === "moved") {
          moved = true;
        } else if (message && typeof message === "object" && "error" in message) {
          failure ??= new Error(String(message.error));
        }
      });
      worker.once("error", reject);
      worker.once("exit", (code) =>
        failure
          ? reject(failure)
          : moved && code === 0
            ? resolve()
            : reject(
                new Error("Strict native move ended without a receipt; inspect retained paths."),
              ),
      );
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
