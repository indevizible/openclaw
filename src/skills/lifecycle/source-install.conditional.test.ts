import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runCliProcessChild } from "../../cli/cli-process-child.test-helpers.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import "../../test-utils/prepare-compiled-subprocesses.js";

// Real host broker, synthetic state. These native fixtures use POSIX modes, names, and SIGKILL.
const scenariosByBoundary = [
  ["CLI", ["cli"]],
  ["missing custody", ["no-custody"]],
  ["wrong database custody", ["wrong-custody"]],
  ["ordinary versus conditional policy race", ["policy-race-ordinary", "policy-race-conditional"]],
  ["publication and replay", ["repeat", "held-fd", "concurrent", "same-request", "history"]],
  ["revision mismatch", ["bytes", "mode", "empty-directory", "provenance"]],
  [
    "native refusal and restoration",
    [
      "publish-race",
      "publish-file",
      "publish-symlink",
      "restore-race",
      "before-detach",
      "rebound-backup",
    ],
  ],
  [
    "native publication and tracking",
    ["after-detach", "after-publication", "post-publication-replace", "untrack-race"],
  ],
  ["crash before preparation", ["crash-before-prepare"]],
  ["crash before detach", ["crash-before-detach"]],
  ["crash after detach", ["crash-after-detach"]],
  ["crash after publication", ["crash-after-publication"]],
  [
    "refusals",
    [
      "symlink",
      "hardlink",
      "remote",
      "unsupported",
      "unstable-read",
      // APFS rejects this filename at creation; Linux can exercise the tree reader's rejection.
      ...(process.platform === "linux" ? ["non-utf8"] : []),
      "force",
      "git",
      "policy",
    ],
  ],
] as const;
it.runIf(process.platform !== "win32").each(scenariosByBoundary)(
  "proves conditional local source %s at the real host boundary",
  async (_label, scenarios) => {
    await withTestDir({ prefix: "conditional-local-skill-" }, async (root) => {
      const entry = path.join(root, "run.mjs");
      const preload = path.join(root, "native-preload.mjs");
      const nativeUrl = new URL("native.js", import.meta.resolve("@openclaw/fs-safe/root")).href;
      // Loader interception invokes the actual OS primitive without editing dependency sources.
      await fs.writeFile(
        preload,
        `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import threads, { workerData, isMainThread } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
const replaceTarget=()=>{
  const root=process.env.CONDITIONAL_TEST_ROOT, target=path.join(root,'workspace/skills/sample');
  fs.renameSync(target,path.join(root,'published-retained'));
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'data.txt'),'successor bytes\\n');
  fs.mkdirSync(path.join(root,'workspace/.clawhub'),{recursive:true});
  fs.writeFileSync(path.join(root,'workspace/.clawhub/lock.json'),JSON.stringify({version:1,skills:{sample:{version:'9.0.0',installedAt:9}}}));
};
if(isMainThread) {
  const open=fsp.open.bind(fsp);
  fsp.open=async (filename,...args)=>{
    const handle=await open(filename,...args);
    if(process.env.CONDITIONAL_TEST_FAULT==='untrack-race' && String(filename).endsWith('/.clawhub/lock.json') && fs.existsSync(path.join(process.env.CONDITIONAL_TEST_ROOT,'native-published'))) {
      const close=handle.close.bind(handle);
      handle.close=async ()=>{
        await close();
        fs.unlinkSync(path.join(process.env.CONDITIONAL_TEST_ROOT,'native-published'));
        replaceTarget();
      };
    }
    return handle;
  };
  const { __setFsSafeTestHooksForTest } = await import(${JSON.stringify(import.meta.resolve("@openclaw/fs-safe/test-hooks"))});
  __setFsSafeTestHooksForTest({afterOpen:(filename,handle)=>{
    if(process.env.CONDITIONAL_TEST_FAULT==='unstable-read' && path.basename(filename)==='data.txt') {
      const read=handle.read.bind(handle);
      handle.read=async (...args)=>{
        const result=await read(...args);
        if(result.bytesRead) fs.appendFileSync(filename,'late read edit\\n');
        return result;
      };
    }
  }});
  const NativeWorker=threads.Worker;
  threads.Worker=class extends NativeWorker {
    constructor(file,options) {
      super(file,options?.workerData?.rootUrl ? {...options,execArgv:['--import',import.meta.url]} : options);
    }
  };
  syncBuiltinESMExports();
}
if(workerData?.rootUrl) {
  const { __setNativeLoaderForTest, __loadBundledNativeForTest } = await import(${JSON.stringify(nativeUrl)});
  const scenario=process.env.CONDITIONAL_TEST_FAULT;
  const target=path.join(process.env.CONDITIONAL_TEST_ROOT,'workspace/skills/sample');
  const crash=()=>{
    process.kill(process.pid,'SIGKILL');
    // Signal delivery can lag: do not execute another native call while termination is pending.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  };
  __setNativeLoaderForTest(()=>{
    if(scenario==='unsupported') throw new Error('synthetic native unavailable');
    const binding=__loadBundledNativeForTest(), rename=binding.renameNoReplace.bind(binding);
    return {...binding,renameNoReplace:(sfd,source,tfd,destination)=>{
      const publishing=path.basename(source)==='stage', detaching=path.basename(source)==='sample', restoring=path.basename(source)==='previous';
      if(publishing && scenario==='publish-race') fs.mkdirSync(target);
      if(publishing && scenario==='publish-file') fs.writeFileSync(target,'competing file');
      if(publishing && scenario==='publish-symlink') fs.symlinkSync('synthetic-missing',target);
      if(path.basename(source)==='native-probe' && scenario==='crash-before-prepare') crash();
      if(detaching && scenario==='crash-before-detach') crash();
      if(detaching && scenario==='before-detach') throw new Error('interrupted before detach');
      if(detaching && scenario==='restore-race') fs.appendFileSync(path.join(target,'data.txt'),'edit before detach\\n');
      if(restoring && scenario==='restore-race') fs.mkdirSync(target);
      const result=rename(sfd,source,tfd,destination);
      if(publishing && scenario==='post-publication-replace') replaceTarget();
      if(publishing && scenario==='untrack-race') fs.writeFileSync(path.join(process.env.CONDITIONAL_TEST_ROOT,'native-published'),'published');
      if((detaching && scenario==='crash-after-detach') || (publishing && scenario==='crash-after-publication')) crash();
      if((detaching && ['after-detach','rebound-backup'].includes(scenario)) || (publishing && scenario==='after-publication')) throw new Error('interrupted after native move');
      return result;
    }};
  });
}
`,
      );
      await fs.writeFile(
        entry,
        `
import { runConditionalSkillScenarios } from ${JSON.stringify(new URL("./source-install.conditional.test-support.ts", import.meta.url).href)};
await runConditionalSkillScenarios(${JSON.stringify(root)}, ${JSON.stringify(scenarios)});
`,
      );
      const run = () =>
        runCliProcessChild({
          nodeArgs: ["--import", import.meta.resolve("tsx/esm"), "--import", preload, entry],
          env: {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_TEST_FAST: "1",
            TSX_DISABLE_CACHE: "1",
            NO_COLOR: "1",
            NODE_ENV: "test",
          },
        });
      let result = await run();
      if (scenarios[0].startsWith("crash-")) {
        expect(result.signal, result.stderr).toBe("SIGKILL");
        const expected = result.stdout.match(/expected:(skill-v1:sha256:[a-f0-9]{64})/u)?.[1];
        expect(expected).toBeDefined();
        await fs.writeFile(
          entry,
          `
import { runConditionalSkillScenarios } from ${JSON.stringify(new URL("./source-install.conditional.test-support.ts", import.meta.url).href)};
await runConditionalSkillScenarios(${JSON.stringify(root)}, ${JSON.stringify(scenarios)}, ${JSON.stringify(expected)});
`,
        );
        result = await run();
      }
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`verified ${scenarios.length} scenarios`);
    });
  },
);
