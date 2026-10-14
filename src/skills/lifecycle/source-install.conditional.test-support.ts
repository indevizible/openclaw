import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import {
  inspectConditionalSkillRequest,
  recoverConditionalSkillRequest,
} from "./conditional-install-journal.js";
import { inspectSkillDestination } from "./installed-revision.js";
import { installSkillFromSource } from "./source-install.js";

async function revision(workspaceDir: string): Promise<string> {
  const inspected = await inspectSkillDestination({ workspaceDir, slug: "sample" });
  assert(inspected.state === "present");
  return inspected.revision;
}

/** Runs in a real host process; no fabricated database admission or publication receipts. */
export async function runConditionalSkillScenarios(
  base: string,
  scenarios: readonly string[],
  resumeExpected?: string,
) {
  for (const scenario of scenarios) {
    const root = path.join(base, scenario);
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source");
    const target = path.join(workspaceDir, "skills/sample");
    if (!resumeExpected) {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(source);
      await fs.writeFile(
        path.join(source, "SKILL.md"),
        "---\nname: sample\ndescription: Synthetic conditional install\n---\n\nExample instructions.\n",
      );
      await fs.writeFile(path.join(source, "data.txt"), "source bytes\n");
    }
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    process.env.CONDITIONAL_TEST_ROOT = root;
    delete process.env.CONDITIONAL_TEST_FAULT;
    const install = (requestId: string, expected?: string) =>
      installSkillFromSource({
        workspaceDir,
        spec: source,
        config: { skills: { load: { watch: false } } },
        conditional: {
          requestId,
          condition: expected ? { kind: "revision", revision: expected } : { kind: "absent" },
        },
      });
    const initial = async () => {
      const result = await install("initial");
      assert.equal(result.ok, true, JSON.stringify(result));
      return result;
    };
    const exercise = async () => {
      process.stdout.write(`scenario:${scenario}\n`);
      try {
        if (scenario === "cli") {
          const configPath = path.join(root, "config.json");
          process.env.OPENCLAW_CONFIG_PATH = configPath;
          await fs.writeFile(
            configPath,
            JSON.stringify({
              agents: {
                defaults: { workspace: workspaceDir },
                entries: { example: { workspace: workspaceDir } },
              },
              skills: { load: { watch: false } },
              gateway: { mode: "local" },
            }),
          );
          const { Command } = await import("commander");
          const { registerSkillsCli } = await import("../../cli/skills-cli.js");
          const { defaultRuntime, ExitError } = await import("../../runtime.js");
          const output: string[] = [];
          const writeJson = defaultRuntime.writeJson;
          defaultRuntime.writeJson = (value) => {
            output.push(JSON.stringify(value));
          };
          const messages: string[] = [];
          const originalLog = defaultRuntime.log;
          const originalError = defaultRuntime.error;
          defaultRuntime.log = (...args) => {
            messages.push(args.join(" "));
          };
          defaultRuntime.error = (...args) => {
            messages.push(args.join(" "));
          };
          const run = async (args: string[], json = true) => {
            const program = new Command();
            registerSkillsCli(program);
            try {
              await program.parseAsync([
                "node",
                "openclaw",
                "skills",
                ...args,
                "--agent",
                "example",
                ...(json ? ["--json"] : []),
              ]);
            } catch (error) {
              if (!(error instanceof ExitError) || error.code !== 1) {
                throw error;
              }
            }
            if (!json) {
              return messages.splice(0).join("\n");
            }
            assert.equal(output.length, 1);
            return JSON.parse(output.pop()!);
          };
          try {
            assert.equal((await run(["inspect", "sample"])).state, "absent");
            const args = ["install", source, "--if-absent", "--request-id", "cli-example"];
            const created = await run(args);
            assert(created.ok && created.conditional.status === "installed");
            assert.equal((await run(args)).conditional.repeated, true);
            assert.equal((await run(["inspect", "sample"])).revision, created.conditional.revision);
            await fs.appendFile(path.join(target, "data.txt"), "cli drift\n");
            const drift = await run(args);
            assert(!drift.ok && drift.conditional.recordedPhase === "installed");
            const human = await run(args, false);
            assert(
              human.includes("recorded outcome installed") &&
                human.includes("matches recorded publication: false"),
              human,
            );
            assert(!human.includes("Installed sample"), human);
            process.env.CONDITIONAL_TEST_FAULT = "after-publication";
            const interrupted = await run([
              "install",
              source,
              "--if-revision",
              await revision(workspaceDir),
              "--request-id",
              "cli-recover",
            ]);
            assert(!interrupted.ok && interrupted.conditional.status === "recovery-required");
            delete process.env.CONDITIONAL_TEST_FAULT;
            await fs.rename(source, path.join(root, "source-retained"));
            const history = await run(["inspect", "sample", "--request-id", "cli-recover"]);
            assert.equal(history.receipt.phase, "publishing");
            const recovered = await run(["recover", "sample", "--request-id", "cli-recover"]);
            assert(
              recovered.ok && recovered.conditional.recordedPhase === "installed",
              JSON.stringify(recovered),
            );
          } finally {
            defaultRuntime.writeJson = writeJson;
            defaultRuntime.log = originalLog;
            defaultRuntime.error = originalError;
          }
        } else if (scenario === "no-custody" || scenario === "wrong-custody") {
          const result = await install("unowned");
          assert(!result.ok, JSON.stringify(result));
          const diagnostic =
            scenario === "no-custody"
              ? /requires exclusive offline SQLite maintenance custody/
              : /maintenance.*does not own this database/;
          assert.match(result.error, diagnostic);
          assert.equal(result.conditional?.stageDir, undefined);
          assert.equal(result.conditional?.backupDir, undefined);
          await assert.rejects(
            recoverConditionalSkillRequest({ workspaceDir, slug: "sample", requestId: "unowned" }),
            diagnostic,
          );
          assert.deepEqual(await fs.readdir(workspaceDir), []);
          await assert.rejects(fs.lstat(path.join(root, "state/state/openclaw.sqlite")), {
            code: "ENOENT",
          });
        } else if (scenario.startsWith("crash-")) {
          if (!resumeExpected) {
            await initial();
            const expected = await revision(workspaceDir);
            await new Promise<void>((resolve) => {
              process.stdout.write(`expected:${expected}\n`, () => resolve());
            });
            process.env.CONDITIONAL_TEST_FAULT = scenario;
            await install("interrupted", expected);
            assert.fail("The native boundary did not terminate the disposable host");
          }
          // Source-free inspection is read-only; recovery explicitly settles the recorded intent.
          await fs.rename(source, path.join(root, "source-retained"));
          const request = { workspaceDir, slug: "sample", requestId: "interrupted" };
          const inspected = await inspectConditionalSkillRequest(request);
          assert.notEqual(inspected.receipt.phase, "conflict");
          const result = await recoverConditionalSkillRequest(request);
          const paths = result.conditional!;
          if (scenario === "crash-after-publication") {
            assert(result.ok, JSON.stringify(result));
            assert.equal(paths.recordedPhase, "installed");
            assert.equal(
              await fs.readFile(path.join(paths.backupDir!, "data.txt"), "utf8"),
              "source bytes\n",
            );
            await assert.rejects(fs.lstat(paths.stageDir!), { code: "ENOENT" });
          } else {
            assert(!result.ok && paths.status === "conflict", JSON.stringify(result));
            assert.equal(await revision(workspaceDir), resumeExpected);
            if (scenario === "crash-before-prepare") {
              await assert.rejects(fs.lstat(paths.stageDir!), { code: "ENOENT" });
            } else {
              assert.equal(
                await fs.readFile(path.join(paths.stageDir!, "data.txt"), "utf8"),
                "source bytes\n",
              );
            }
          }
          assert.equal((await recoverConditionalSkillRequest(request)).conditional?.repeated, true);
        } else if (scenario === "repeat") {
          await fs.mkdir(path.join(source, ".clawhub"));
          await fs.writeFile(path.join(source, ".clawhub/origin.json"), "{}\n");
          await fs.mkdir(path.join(source, ".clawdhub"));
          await fs.mkdir(path.join(workspaceDir, ".clawhub"));
          await fs.writeFile(
            path.join(workspaceDir, ".clawhub/lock.json"),
            JSON.stringify({
              version: 1,
              skills: { sample: { version: "1.0.0", installedAt: 1 } },
            }),
          );
          assert.equal(
            (await inspectSkillDestination({ workspaceDir, slug: "sample" })).state,
            "absent",
          );
          const result = await initial();
          assert.equal(await fs.readFile(path.join(target, "data.txt"), "utf8"), "source bytes\n");
          const origin = JSON.parse(
            await fs.readFile(path.join(target, ".openclaw/source-origin.json"), "utf8"),
          );
          assert.equal(origin.source, "path");
          assert.equal(origin.slug, "sample");
          await assert.rejects(fs.lstat(path.join(target, ".clawhub")), { code: "ENOENT" });
          await assert.rejects(fs.lstat(path.join(target, ".clawdhub")), { code: "ENOENT" });
          const lock = JSON.parse(
            await fs.readFile(path.join(workspaceDir, ".clawhub/lock.json"), "utf8"),
          );
          assert.equal(lock.skills.sample, undefined);
          const before = await revision(workspaceDir);
          const repeated = await install("initial");
          assert.equal(repeated.ok, true, JSON.stringify(repeated));
          assert.deepEqual(repeated.conditional, { ...result.conditional, repeated: true });
          const changedCondition = await install("initial", before);
          assert(
            !changedCondition.ok && changedCondition.error.includes("different install inputs"),
            JSON.stringify(changedCondition),
          );
          await fs.appendFile(path.join(source, "data.txt"), "changed request\n");
          const conflict = await install("initial");
          assert(
            !conflict.ok && conflict.error.includes("different install inputs"),
            JSON.stringify(conflict),
          );
          assert.equal(conflict.conditional?.stageDir, undefined);
          assert.equal(await revision(workspaceDir), before);
        } else if (scenario.startsWith("policy-race-")) {
          const policy = path.join(root, "allow-and-create.cjs");
          await fs.chmod(root, 0o700);
          await fs.writeFile(
            policy,
            `#!${process.execPath}\nconst fs=require('node:fs'); process.stdin.resume(); process.stdin.on('end',()=>{fs.mkdirSync(${JSON.stringify(target)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(root, "race.json"))},JSON.stringify({ino:fs.lstatSync(${JSON.stringify(target)}).ino}));process.stdout.write(JSON.stringify({protocolVersion:1,decision:'allow'}));});\n`,
            { mode: 0o700 },
          );
          const conditional = scenario === "policy-race-conditional";
          const result = await installSkillFromSource({
            workspaceDir,
            spec: source,
            ...(conditional
              ? { conditional: { requestId: "race", condition: { kind: "absent" as const } } }
              : {}),
            config: {
              skills: { load: { watch: false } },
              security: {
                installPolicy: {
                  enabled: true,
                  exec: { source: "exec", command: policy, trustedDirs: [root] },
                },
              },
            },
          });
          const { ino } = JSON.parse(await fs.readFile(path.join(root, "race.json"), "utf8"));
          assert.equal(result.ok, !conditional, JSON.stringify(result));
          if (conditional) {
            assert.equal(result.conditional?.status, "conflict");
            assert.equal((await fs.lstat(target)).ino, ino);
            assert.deepEqual(await fs.readdir(target), []);
            assert.equal(
              (
                await inspectConditionalSkillRequest({
                  workspaceDir,
                  slug: "sample",
                  requestId: "race",
                })
              ).receipt.phase,
              "conflict",
            );
          } else {
            assert.notEqual((await fs.lstat(target)).ino, ino);
            assert.equal(
              await fs.readFile(path.join(target, "data.txt"), "utf8"),
              "source bytes\n",
            );
          }
        } else if (scenario === "history") {
          const original = await initial();
          await fs.appendFile(path.join(target, "data.txt"), "later edit\n");
          await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
          const lockfile = path.join(workspaceDir, ".clawhub/lock.json");
          const tracking = JSON.stringify({
            version: 1,
            skills: { sample: { version: "9.0.0", installedAt: 9 } },
          });
          await fs.writeFile(lockfile, tracking);
          const drift = await install("initial");
          assert(
            !drift.ok && drift.conditional?.recordedPhase === "installed",
            JSON.stringify(drift),
          );
          assert.equal(drift.conditional.revision, original.conditional?.revision);
          assert(
            drift.conditional.current?.state === "present" &&
              !drift.conditional.current.matchesPublished,
          );
          assert.equal(await fs.readFile(lockfile, "utf8"), tracking);
          await fs.rename(target, path.join(root, "later-owner"));
          const missing = await install("initial");
          assert(
            !missing.ok && missing.conditional?.current?.state === "absent",
            JSON.stringify(missing),
          );
          assert.equal(await fs.readFile(lockfile, "utf8"), tracking);
          await fs.rename(source, path.join(root, "source-retained"));
          assert.equal(
            (
              await inspectConditionalSkillRequest({
                workspaceDir,
                slug: "sample",
                requestId: "initial",
              })
            ).observations.target.state,
            "absent",
          );
          await assert.rejects(
            inspectConditionalSkillRequest({ workspaceDir, slug: "other", requestId: "initial" }),
            /different destination/,
          );
        } else if (scenario === "same-request") {
          const results = await Promise.all([install("same"), install("same")]);
          assert(
            results.every((r) => r.ok),
            JSON.stringify(results),
          );
          assert.equal(results.filter((r) => r.conditional?.repeated).length, 1);
          assert.equal(results[0].conditional?.stageDir, results[1].conditional?.stageDir);
        } else if (scenario === "held-fd" || scenario === "concurrent") {
          await initial();
          const expected = await revision(workspaceDir);
          const held = await fs.open(path.join(target, "data.txt"), "r+");
          try {
            await fs.writeFile(path.join(source, "data.txt"), "replacement\n");
            const results =
              scenario === "concurrent"
                ? await Promise.all([install("one", expected), install("two", expected)])
                : [await install("one", expected)];
            assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
            const winner = results.find((r) => r.ok)!;
            await held.write("late write\n", 0, "utf8");
            assert(
              (
                await fs.readFile(path.join(winner.conditional!.backupDir!, "data.txt"), "utf8")
              ).includes("late write\n"),
            );
            assert.equal(await fs.readFile(path.join(target, "data.txt"), "utf8"), "replacement\n");
            if (scenario === "concurrent") {
              assert(results.some((r) => !r.ok && /conflict|did not match/.test(r.error)));
            }
          } finally {
            await held.close();
          }
        } else if (["bytes", "mode", "empty-directory", "provenance"].includes(scenario)) {
          await initial();
          const expected = await revision(workspaceDir);
          if (scenario === "bytes") {
            await fs.appendFile(path.join(target, "data.txt"), "user edit\n");
          }
          if (scenario === "mode") {
            await fs.chmod(path.join(target, "data.txt"), 0o755);
          }
          if (scenario === "empty-directory") {
            await fs.mkdir(path.join(target, "empty"));
          }
          if (scenario === "provenance") {
            await fs.appendFile(path.join(target, ".openclaw/source-origin.json"), "\n");
          }
          const edited = await revision(workspaceDir);
          assert.notEqual(edited, expected);
          const result = await install("replace", expected);
          assert(!result.ok && result.conditional?.status === "conflict", JSON.stringify(result));
          assert.equal(await revision(workspaceDir), edited);
          assert.equal((await install("replace", expected)).conditional?.repeated, true);
        } else if (
          [
            "publish-race",
            "publish-file",
            "publish-symlink",
            "restore-race",
            "before-detach",
            "after-detach",
            "after-publication",
            "post-publication-replace",
            "untrack-race",
            "rebound-backup",
          ].includes(scenario)
        ) {
          let expected: string | undefined;
          if (
            !scenario.startsWith("publish-") &&
            !["post-publication-replace", "untrack-race"].includes(scenario)
          ) {
            await initial();
            expected = await revision(workspaceDir);
          }
          if (scenario === "untrack-race") {
            await fs.mkdir(path.join(workspaceDir, ".clawhub"));
            await fs.writeFile(
              path.join(workspaceDir, ".clawhub/lock.json"),
              JSON.stringify({
                version: 1,
                skills: { sample: { version: "1.0.0", installedAt: 1 } },
              }),
            );
          }
          process.env.CONDITIONAL_TEST_FAULT = scenario;
          const result = await install("interrupted", expected);
          assert(!result.ok, JSON.stringify(result));
          const paths = result.conditional!;
          assert.equal(
            paths.status,
            scenario.startsWith("publish-") ? "conflict" : "recovery-required",
          );
          if (scenario === "untrack-race") {
            assert(
              result.error.includes(
                "Published target changed; successor tracking must be preserved",
              ),
              result.error,
            );
          }
          if (scenario === "publish-file") {
            assert.equal(await fs.readFile(target, "utf8"), "competing file");
          }
          if (scenario === "publish-symlink") {
            assert.equal(await fs.readlink(target), "synthetic-missing");
          }
          delete process.env.CONDITIONAL_TEST_FAULT;
          if (scenario === "after-detach") {
            const blocked = await install("blocked", expected);
            assert(
              !blocked.ok && blocked.conditional?.owningRequestId === "interrupted",
              JSON.stringify(blocked),
            );
            assert.equal(blocked.conditional.stageDir, undefined);
            assert.equal(blocked.conditional.backupDir, undefined);
          }
          if (scenario === "rebound-backup") {
            const retained = path.join(root, "displaced-retained");
            await fs.rename(paths.backupDir!, retained);
            await fs.mkdir(paths.backupDir!);
            const request = { workspaceDir, slug: "sample", requestId: "interrupted" };
            const recovered = await recoverConditionalSkillRequest(request);
            assert(
              !recovered.ok && recovered.conditional?.status === "recovery-required",
              JSON.stringify(recovered),
            );
            assert.equal(
              (await inspectConditionalSkillRequest(request)).receipt.phase,
              "detaching",
            );
            await assert.rejects(fs.lstat(target), { code: "ENOENT" });
            assert.equal(
              await fs.readFile(path.join(retained, "data.txt"), "utf8"),
              "source bytes\n",
            );
            assert.deepEqual(await fs.readdir(paths.backupDir!), []);
            return;
          }
          const repeated = await install("interrupted", expected);
          assert.equal(repeated.conditional?.repeated, true);
          if (scenario === "after-publication") {
            assert(repeated.ok, JSON.stringify(repeated));
          } else {
            assert(!repeated.ok, JSON.stringify(repeated));
          }
          if (scenario === "publish-race" || scenario === "restore-race") {
            assert.deepEqual(await fs.readdir(target), []);
          }
          if (scenario === "after-detach" || scenario === "before-detach") {
            assert.equal(await revision(workspaceDir), expected);
          }
          if (["after-publication", "restore-race"].includes(scenario)) {
            assert(
              (await fs.readFile(path.join(paths.backupDir!, "data.txt"), "utf8")).includes(
                "source bytes\n",
              ),
            );
          }
          if (scenario === "restore-race") {
            assert(
              (await fs.readFile(path.join(paths.backupDir!, "data.txt"), "utf8")).includes(
                "edit before detach\n",
              ),
            );
          }
          if (["post-publication-replace", "untrack-race"].includes(scenario)) {
            assert.equal(paths.publicationObserved, true);
            assert.equal(
              await fs.readFile(path.join(target, "data.txt"), "utf8"),
              "successor bytes\n",
            );
            assert.equal(
              JSON.parse(await fs.readFile(path.join(workspaceDir, ".clawhub/lock.json"), "utf8"))
                .skills.sample.version,
              "9.0.0",
            );
            assert.equal(
              await fs.readFile(path.join(root, "published-retained/data.txt"), "utf8"),
              "source bytes\n",
            );
          }
          assert.equal(
            (
              await inspectConditionalSkillRequest({
                workspaceDir,
                slug: "sample",
                requestId: "interrupted",
              })
            ).receipt.phase,
            scenario === "after-publication" ? "installed" : "conflict",
          );
          const next = await install("different", expected);
          assert(next.ok || !next.error.includes("owns this target"), JSON.stringify(next));
        } else {
          let release: (() => void) | undefined;
          if (scenario === "symlink") {
            await fs.symlink(path.join(source, "data.txt"), path.join(source, "link"));
          }
          if (scenario === "hardlink") {
            await fs.link(path.join(source, "data.txt"), path.join(source, "link"));
          }
          if (scenario === "remote") {
            const forbidden = async (): Promise<never> => {
              throw new Error("Remote filesystem must not be invoked");
            };
            release = registerAgentWorkspaceAccess(workspaceDir, {
              bridge: { readFile: forbidden, writeFile: forbidden, stat: forbidden },
            });
          }
          if (scenario === "unsupported" || scenario === "unstable-read") {
            process.env.CONDITIONAL_TEST_FAULT = scenario;
          }
          if (scenario === "non-utf8") {
            await fs.writeFile(
              Buffer.concat([Buffer.from(source + path.sep), Buffer.from([0xff])]),
              "invalid name",
            );
          }
          try {
            let result;
            if (scenario === "policy") {
              const policy = path.join(root, "deny.cjs");
              await fs.chmod(root, 0o700);
              await fs.writeFile(
                policy,
                `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({protocolVersion:1,decision:'block',reason:'Synthetic policy denial'})));\n`,
                { mode: 0o700 },
              );
              result = await installSkillFromSource({
                workspaceDir,
                spec: source,
                conditional: { requestId: "denied", condition: { kind: "absent" } },
                config: {
                  security: {
                    installPolicy: {
                      enabled: true,
                      exec: { source: "exec", command: policy, trustedDirs: [root] },
                    },
                  },
                },
              });
            } else if (scenario === "force" || scenario === "git") {
              result = await installSkillFromSource({
                workspaceDir,
                spec: scenario === "git" ? "git:https://example.invalid/example.git" : source,
                force: scenario === "force",
                conditional: { requestId: "reject", condition: { kind: "absent" } },
              });
            } else {
              result = await install("reject");
            }
            assert(!result.ok, JSON.stringify(result));
            if (scenario === "policy") {
              assert(result.error.includes("Synthetic policy denial"), result.error);
            }
            if (scenario === "unsupported") {
              assert(result.error.includes("unsupported"), result.error);
            }
            if (scenario === "unstable-read") {
              assert(/changed|grew/.test(result.error), result.error);
            }
            if (scenario === "non-utf8") {
              assert(result.error.includes("non-UTF-8"), result.error);
            }
            await assert.rejects(fs.lstat(target), { code: "ENOENT" });
          } finally {
            release?.();
          }
        }
      } finally {
        await closeSkillsWatchers(true);
      }
    };
    if (scenario === "cli" || scenario === "no-custody") {
      await exercise();
    } else {
      const lock = await acquireGatewayLock({
        ...(scenario === "wrong-custody"
          ? { env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "other-state") } }
          : {}),
        allowInTests: true,
        role: "sqlite-maintenance",
        port: 18889,
        timeoutMs: 250,
      });
      assert(lock);
      try {
        await lock.run(exercise);
      } finally {
        await lock.release();
      }
    }
    await closeOpenClawStateDatabaseAsync();
  }
  process.stdout.write(`verified ${scenarios.length} scenarios\n`);
}
