---
doc-schema-version: 1
summary: "CLI reference for `openclaw skills` (search/install/update/verify/list/info/check/library/workshop)"
read_when:
  - You want to see which skills are available and ready to run
  - You want to search ClawHub or install skills from ClawHub, Git, or local directories
  - You need to remove an installed ClawHub skill
  - You want to verify a ClawHub skill with ClawHub
  - You want to debug missing binaries/env/config for skills
title: "Skills CLI"
---

# `openclaw skills`

Inspect local skills, search ClawHub, install skills from ClawHub/Git/local
directories, verify ClawHub skills, and update ClawHub-tracked installs.

Use [`openclaw plugins`](/cli/plugins) for plugin packages. The standalone
[ClawHub CLI](/clawhub/cli) handles [publishing](/clawhub/publishing), registry
maintenance, and [removing ClawHub skills](/cli/skills#remove-a-clawhub-skill).

Related:

- Skills system: [Skills](/tools/skills)
- Skill authoring: [Creating skills](/tools/creating-skills)
- Skill Workshop: [Skill Workshop](/tools/skill-workshop)
- Skills config: [Skills config](/tools/skills-config)

## Commands

```bash
openclaw skills search "calendar"
openclaw skills search --limit 20 --json
openclaw skills install @owner/<slug>
openclaw skills install @owner/<slug> --version <version>
openclaw skills install skills-sh:<owner>/<repo>/<slug>
openclaw skills install git:owner/repo
openclaw skills install git:owner/repo@main
openclaw skills install ./path/to/skill --as custom-name
openclaw skills install @owner/<slug> --force
openclaw skills install @owner/<slug> --force-install
openclaw skills install @owner/<slug> --acknowledge-install-policy-warning
openclaw skills install @owner/<slug> --agent <id>
openclaw skills install @owner/<slug> --global
openclaw skills update @owner/<slug>
openclaw skills update @owner/<slug> --force
openclaw skills update @owner/<slug> --force-install
openclaw skills update @owner/<slug> --acknowledge-install-policy-warning
openclaw skills update @owner/<slug> --global
openclaw skills update --all
openclaw skills update --all --agent <id>
openclaw skills update --all --global
openclaw skills verify @owner/<slug>
openclaw skills verify @owner/<slug> --json
openclaw skills verify @owner/<slug> --version <version>
openclaw skills verify @owner/<slug> --tag <tag>
openclaw skills verify @owner/<slug> --card
openclaw skills verify @owner/<slug> --global
openclaw skills list
openclaw skills list --eligible
openclaw skills list --json
openclaw skills list --verbose
openclaw skills list --agent <id>
openclaw skills inspect <slug> --json
openclaw skills info <name>
openclaw skills info <name> --json
openclaw skills info <name> --agent <id>
openclaw skills check
openclaw skills check --agent <id>
openclaw skills check --json
openclaw skills workshop list
openclaw skills workshop changes --limit 20
openclaw skills workshop show <name>
openclaw skills workshop archive <name> --reason "Superseded"
openclaw skills workshop restore <name>
```

`search`, `update`, and `verify` use ClawHub directly. `install @owner/<slug>`
installs a native ClawHub skill. `install skills-sh:<owner>/<repo>/<slug>` asks
ClawHub to resolve an external listing to its exact synchronized GitHub commit;
OpenClaw does not download from skills.sh. These entries are shown as
**Not scanned by ClawHub**, and that trust state is preserved through updates
and verification. Claimed or ClawHub-scanned skills use `@owner/<slug>`.
`install git:owner/repo[@ref]` clones an unmanaged Git skill, and `install
./path` copies a local skill directory. Both fail before copying when the root
`SKILL.md` is not loadable under the same content rules: frontmatter with a
description, within `skills.limits.maxSkillFileBytes`. A hardlinked source file
is copied as a new file, so that link does not fail the check. By default, `install`,
`update`, and `verify` target the active workspace `skills/` directory; with
`--global`, they target the shared managed skills directory. `list`/`info`/`check`
and bare `openclaw skills` request the selected Gateway's authoritative skill
inventory. A configured remote Gateway or an explicit `OPENCLAW_GATEWAY_URL`
never falls back to client-local skills: missing URLs, connection failures, and
authentication errors remain visible. Only an implicitly selected local Gateway
can fall back to local inventory when it is unavailable. Workspace-backed
commands resolve the target workspace from `--agent <id>`, then the current
working directory when it is inside a configured agent workspace, then the
default agent.

Search results add `v` only to numeric version labels, preserving existing prefixes
and build names. JSON output keeps the registry's original version values.

The skills table renders horizontal tabs as single spaces so descriptions
stay aligned with the neighboring columns.
JSON output preserves tabs and line endings in descriptions and paths as escaped
characters.

`info` resolves an exact skill name before a metadata key. Key, case-insensitive,
and separator-normalized matches must identify one skill; ambiguous selectors
fail instead of choosing discovery order.

`check` separates **inventory**, **readiness**, and **visibility**:

- **Inventory** means OpenClaw found the skill in a configured root or bundled
  source and can report its status.
- **Readiness** means the skill's declared prerequisites are satisfied for the
  selected Gateway or node, so it is eligible to run.
- **Visibility** means an eligible skill is exposed to the selected agent's
  prompt, picker, or command surface after agent filters and invocation flags
  are applied.

`check` reports missing prerequisites independently of agent exclusion: a skill
excluded by the agent allowlist can also appear under **Missing requirements**.
Disabled skills and skills blocked by the bundled allowlist keep their separate
readiness categories. Treat a listed skill with missing requirements as present
in inventory but not currently eligible or visible to the agent; install or
configure the reported prerequisite before expecting the model to use it
successfully.

Workshop commands preserve the same target boundary. They never read or mutate
client-local state after an explicitly selected Gateway fails; intentional
offline behavior remains available only for an implicitly selected local
Gateway.

Git and local directory installs expect `SKILL.md` at the source root. The
install slug comes from `SKILL.md` frontmatter `name` when it is valid, then
the source directory or repository name; use `--as <slug>` to override it.
`--version` is ClawHub-only. Skill installs do not support npm package specs
or zip/archive paths, and `openclaw skills update` updates ClawHub-tracked
installs only.

## Conditional local directory installs

**Draft prototype: destination conditions, permanent receipts, retention, and recovery
still need upstream maintainer acceptance.** See [the design issue](https://github.com/openclaw/openclaw/issues/172142)
and [the advisory review](https://github.com/openclaw/openclaw/issues/172142#issuecomment-6169274051).
This implementation is not an accepted persistence design. Broad CI skips Draft
PRs; focused local proof is required before review.

Use a conditional install when automation must preserve an unexpected destination
or local edits. Stop the local Gateway first: this CLI path acquires exclusive
offline custody of the shared state database. Direct conditional API calls also
require current maintenance custody of that exact database, including fresh
installs and retries. The existing target queue serializes each entire attempt
with recovery within that custody. The selected workspace must already exist.
This Draft has no remote or Gateway protocol integration. Ordinary installs and updates keep their existing behavior.

```bash
openclaw skills inspect sample --agent example --json
openclaw skills install ./sample --as sample --agent example \
  --if-absent --request-id example-create-1 --json
openclaw skills install ./sample --as sample --agent example \
  --if-revision '<revision-from-inspect>' --request-id example-replace-1 --json
```

`inspect` always emits JSON for exactly the writable `workspace/skills/<slug>`
destination. It does not use discovery precedence, skill display names, or
`skills info`. An absent destination returns `state: "absent"`; a supported tree
returns `state: "present"` and `revision: "skill-v1:sha256:..."`. Both include
`slug`, canonical `workspaceDir`, and `targetDir`. The existing `--agent` selection
rules apply; `--global` selects the shared managed destination and cannot be
combined with `--agent`.

Specify exactly one of `--if-absent` and `--if-revision`, plus `--request-id`.
IDs are 1–200 ASCII letters, digits, periods, underscores, colons, or hyphens.
An ID is permanent within that shared database. It binds the canonical workspace
identity, destination, local source path and complete source content, and condition.
Reusing it with different inputs fails. Repeating completed inputs returns the
recorded outcome separately from the current destination observation. A completed
receipt never overwrites later edits or repeats install hooks, provenance writes,
ClawHub untracking, or discovery refresh. If the current destination is missing or
changed, replay exits nonzero while retaining `recordedPhase: "installed"` and the
historical `revision`. Human output labels the recorded outcome and current state.

Complete revisions include every relative name, file byte, permission/mode bit,
empty directory, root mode, and provenance file. They exclude timestamps and inode
numbers from the content digest. Symlinks, hardlinked files, special files, and
detected changes during reads fail closed. A revision is an observation, not an
atomic tree snapshot. The existing ClawHub digest format is unchanged.

Fresh publication uses strict native no-replace, so any existing destination,
including a racing empty directory, prevents publication. Replacement first moves
the current target to an owned, unique `previous` path with strict no-replace,
then checks that displaced tree against the expected revision. It publishes the
prepared stage only while the target name is absent. **Replacement is not an
atomic tree-content compare-and-swap:** the target is briefly absent, readers
holding descriptors can continue writing the displaced tree, and edits after
validation are possible. Successful replacement retains that entire displaced
tree for this reason. Native no-replace does not atomically bind the source inode:
a source-name swap can move the then-current tree. This is not source inode CAS.
The installer checks the published identity and complete revision before completion,
and synchronously checks identity again at ClawHub tracking mutation. Observations
are not locks: later edits and name replacements remain possible.

If the displaced revision does not match, restoration also uses strict
no-replace. If another target appears, both trees are preserved and recovery is
required. Native calls can fail after moving a directory; such errors never
trigger a blind rollback. Provenance is prepared inside staging before
publication. No conditional install writes provenance into its published tree.
Workspace ClawHub tracking and discovery/hooks retain their existing owners.

`install --json` requires conditional mode; ordinary installs reject that flag.
Conditional results contain `ok`, and on failure `error`. Once a request is
confirmed, `conditional` includes `requestId`, `status`, `recordedPhase`, `targetDir`,
`stageDir`, `backupDir`, and the prepared historical `revision` when available.
`current` describes the observed target: `absent`, `unreadable`, or `present` with
identity, revision when readable, and `matchesPublished`. `publicationObserved`
records an observed publication; it does not promise that the tree still occupies
the target. Replays add `repeated: true`. Status is `installed`, `conflict`, or
`recovery-required`; it must be interpreted with `current` and `ok`.
Confirmed claim refusals have no stage/backup paths and may identify
`owningRequestId`. A lost claim reply reports an unknown claim outcome, without
inventing artifact paths. Uncertain outcomes include `recoveryIncomplete`.

Paths describe recorded locations; a stage or restored backup may no longer be
present. A successful replacement retains the displaced tree at
`workspace/skills/.openclaw-conditional-<unique-id>/previous`.
There is **no automatic tree cleanup**, expiry, or cleanup command. Failed stages,
probe directories, and successful backups consume disk until an operator reviews
them. Keep backups until all old writers have stopped and their late writes have
been reviewed.

Inspect and reconcile without the original source directory:

```bash
openclaw skills inspect sample --agent example --request-id example-replace-1 --json
openclaw skills recover sample --agent example --request-id example-replace-1 --json
```

Request inspection is read-only. It returns the recorded `receipt` and current
`observations` for its target, stage, backup, and operation directory; it does not
initialize a missing receipt table. The request must match this exact canonical
destination and workspace identity. Inspection remains available when the source
was removed or edited. Recovery is an explicit mutation under exclusive offline
SQLite maintenance custody, serialized with in-process installs. It uses the
same journal and publication owner, never a new installation.

- Before target mutation (`intent`/`prepared`), recovery settles a conflict and
  retains staging artifacts.
- Around displacement/restoration (`detaching`/`detached`/`restoring`), it restores
  the recorded backup only into an absent target using strict native no-replace.
  An existing destination and displaced backup are both retained for operator review.
- During `publishing`, it recognizes the recorded stage at the target only after
  the stage name disappeared, identity and complete revision match, and moved
  parents are durably synced. It records installation without replaying tracking
  or hooks; those effects may remain incomplete. Otherwise it never republishes;
  it can restore a recorded backup only into an absent target.
- Unreadable or rebound recorded artifact identities require recovery without
  filesystem effects. The target reservation remains active until safe settlement
  can be established. Settled conflicts release it, including preserved-both-tree
  outcomes that still require operator review.

Repeating identical install inputs can perform the same reconciliation under
offline custody. Stop writers and inspect first; use `recover` if the temporary
source is gone. If recovery remains unresolved, preserve the database/WAL and all
reported paths for maintainer review. Do not manually edit SQLite, delete receipts,
force-install over the target, or discard a backup to bypass recovery. This command
is reconciliation, not cleanup, and cannot reconstruct an unrecorded successor or
prove what an external writer did after a move.

Unsupported inputs include Git, registry, archive, remote workspace adapters,
remote Gateway targets, PostgreSQL shared state, force/registry flags, and a host
or filesystem lacking native no-replace or durable directory synchronization.
There is no check-and-rename or
copy fallback. Install policy still evaluates the staged local content; warnings
require the existing explicit acknowledgement, and denial/failure cannot be
bypassed by a condition or request ID.

### Conditional install storage proposal

**Draft design: pending upstream maintainer acceptance.** The dedicated first-use
`skill_local_install_requests` table in `openclaw.sqlite` owns permanent request
bindings, target reservations, phase/intents, artifact paths and identities, and
results. Reservations use workspace identity and case-folded ASCII slugs, so case
aliases conflict even on case-sensitive filesystems. It is separate from expiring
uploads and the retired skill lifecycle.
The shared worker performs synchronous Kysely transactions under existing
exclusive offline admission for this CLI-only Draft. Receipt commits use operation-scoped SQLite `FULL`
synchronization; prepared trees and moved parents use filesystem durability
syncs. This adds no Gateway main-thread database access.

The additive table and its active-target uniqueness index are created on first
conditional use, without a numeric schema-version bump. There is no backfill,
expiry, retention sweep, or automatic receipt deletion; storage grows with request
count and retained trees. Receipts contain local paths but no source file bodies.
Back up the shared database together with retained directories. Restoring only an
older database loses request history and can no longer establish idempotency for
filesystem effects performed afterward.

Older builds do not implement these reservations or recovery semantics. Preserve
the table and artifacts during downgrade; do not use an older writer to continue
an incomplete operation. Package rollback alone does not undo filesystem moves.
The table, permanent retention, durability cost, recovery workflow, and downgrade
contract require maintainer design acceptance before this Draft is ready to land.

## Install policy

Gateway-backed skill dependency installs triggered from onboarding or Skills
settings use the separate `skills.install` request path instead.

When `security.installPolicy` returns `warn` in an interactive terminal,
OpenClaw prints the reason and findings, then asks `type: '<skill>' to install
anyway` (or `update anyway`). If the fully rendered review exceeds 4,000
characters, OpenClaw stops before prompting; reduce or coalesce the
policy output first. A matching answer evaluates the staged skill
again before continuing. Declined and non-interactive direct CLI commands stop
before commit; after review, `--acknowledge-install-policy-warning` is the
explicit noninteractive approval for every warning in that command invocation.
Every approved warning is re-evaluated before continuing. Automatic and managed
skill installs cannot use that flag themselves. Use an equivalent direct CLI
command when one exists; otherwise, change `security.installPolicy` to return
`allow` for the reviewed request, then retry the managed flow. Neither `--force`
nor the acknowledgement overrides `block` or a policy failure.

Notes:

| Flag/behavior                    | Description                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search [query...]`              | Optional query; omit it to browse the ClawHub Trending skills feed.                                                                                                                                                                                                                                                               |
| `search --limit <n>`             | Caps returned results.                                                                                                                                                                                                                                                                                                            |
| `install git:owner/repo[@ref]`   | Installs a Git skill. Branch refs may contain slashes, such as `git:owner/repo@feature/foo`.                                                                                                                                                                                                                                      |
| `install ./path/to/skill`        | Installs a local directory whose root contains `SKILL.md`.                                                                                                                                                                                                                                                                        |
| `install --as <slug>`            | Overrides the inferred slug for Git and local directory installs.                                                                                                                                                                                                                                                                 |
| `install --version <version>`    | Applies to native ClawHub skill refs, not `skills-sh:` refs; the mirrored reference already identifies the exact synchronized commit.                                                                                                                                                                                             |
| `install --force`                | Overwrites an existing workspace skill folder for the same slug.                                                                                                                                                                                                                                                                  |
| `update --force`                 | Replaces a tracked skill even when its installed files no longer match recorded install digests. Without it, updates preserve local changes. Pre-digest installs require one forced update before later updates can be verified. Force those skills individually; `--all --force` also replaces skills with detected local edits. |
| `install/update --force-install` | Installs a pending GitHub-backed ClawHub skill before ClawHub's scan completes.                                                                                                                                                                                                                                                   |
| `--global`                       | Targets the shared managed skills directory; cannot combine with `--agent <id>`.                                                                                                                                                                                                                                                  |
| `--agent <id>`                   | Targets one configured agent workspace; overrides current working directory inference.                                                                                                                                                                                                                                            |
| `update @owner/<slug>`           | Updates a single tracked skill. Add `--global` to target the shared managed skills directory instead of the workspace.                                                                                                                                                                                                            |
| `update --all`                   | Updates tracked ClawHub installs in the selected workspace, or the shared managed skills directory with `--global`.                                                                                                                                                                                                               |
| `verify @owner/<slug>`           | Prints ClawHub's `clawhub.skill.verify.v1` JSON envelope by default. `--json` is accepted as the explicit machine-output spelling. Bare slugs are accepted for compatibility when the skill is already installed or unambiguous; owner-qualified refs avoid publisher ambiguity.                                                  |
| `verify` provenance              | When ClawHub returns server-resolved source provenance, verify JSON also includes a commit-pinned `openclaw.verifiedSourceUrl`. Unavailable or self-declared source URLs stay only in the raw provenance envelope and are not promoted.                                                                                           |
| `verify` version selector        | `verify` uses `.clawhub/origin.json` for installed ClawHub skills, so it verifies the installed version against the registry it came from. `--version` and `--tag` override the version selector but keep that installed registry when origin metadata exists.                                                                    |
| `verify --card`                  | Prints the generated Skill Card Markdown instead of JSON. Exits non-zero when ClawHub returns `ok: false` or `decision: "fail"`.                                                                                                                                                                                                  |
| Skill Card fingerprint           | Installed ClawHub bundles can include a generated `skill-card.md`. OpenClaw treats verification as a ClawHub server decision and does not reject an installed skill just because that generated card changes the bundle fingerprint.                                                                                              |
| `check --agent <id>`             | Checks the selected agent's workspace and reports which ready skills are actually visible to that agent's prompt or command surface.                                                                                                                                                                                              |
| `workshop --agent <id>`          | Accepted before or after a Workshop leaf command, for example `workshop --agent <id> list` or `workshop list --agent <id>`. If both are provided, the leaf value wins.                                                                                                                                                            |
| `list`                           | Default action when no subcommand is provided.                                                                                                                                                                                                                                                                                    |
| `list`/`info`/`check` output     | Rendered output goes to stdout. With `--json`, the machine-readable payload stays on stdout for pipes and scripts.                                                                                                                                                                                                                |

On servers supporting full scanner reports, verification JSON includes `security.scannerReports.aig` (the full upstream SARIF report)
and `security.scannerReports.skillspector` (the full upstream JSON report) when ClawHub
has retained them. Nested scanner fields pass through unchanged, including
coverage and incomplete-analysis details. A report is `null` when unavailable,
including older scans whose full output was not retained; summaries are not
substituted. Older servers may omit `security.scannerReports` entirely. `verify`
reads the stored scan and does not start another scan. Verification responses
can be up to 64 MiB; larger responses fail explicitly without printing partial
reports. Other ClawHub JSON requests retain their 16 MiB limit.

## Release trust

Community ClawHub skill installs and updates check trust before downloading.
Versioned community archive releases use exact-release trust metadata.
Resolver-backed GitHub skills rely on ClawHub's install resolver to enforce
scan and force-install policy before it returns a pinned commit; use
`--force-install` to install a pending GitHub-backed skill before that scan
completes. Malicious or blocked community releases are refused. Review
outcomes print the exact ClawHub audit overview and details link, then continue.
Official ClawHub skill publishers and bundled OpenClaw skill sources bypass
this release-trust check.

## Remove a ClawHub skill

Use the standalone ClawHub CLI to remove a ClawHub-tracked skill. If the CLI
is not installed, install it explicitly first:

```bash
npm i -g clawhub
clawhub uninstall @owner/my-skill
```

The CLI asks for confirmation before deleting the skill directory and its
`.clawhub/lock.json` entry. Use the installed skill's owner-qualified name or
bare slug, not its original `skills-sh:` reference.

Select the same root where the skill was installed: the agent workspace for an
agent-specific skill, or the OpenClaw state directory for a shared skill
installed with `--global`:

```bash
clawhub --workdir /path/to/agent-workspace uninstall @owner/my-skill
clawhub --workdir ~/.openclaw uninstall @owner/my-skill
```

If `OPENCLAW_STATE_DIR` is set, use that configured state directory for shared
skills instead:

```bash
clawhub --workdir "$OPENCLAW_STATE_DIR" uninstall @owner/my-skill
```

The default [skills watcher](/tools/skills#snapshots-and-refresh) picks up the
removal on the next agent turn. If watching is disabled, start a new session.

## Personal skill library

`openclaw skills library` manages the identified caller's skills on the selected
Gateway. It uses the same owner-aware service as the Control UI and agent
workflow; it never writes the library database or revision directories on the
CLI host.

```bash
openclaw skills library --help
```

List your library:

```bash
openclaw skills library list --scope mine --json
```

Create a private skill from a directory containing `SKILL.md`:

```bash
openclaw skills library create ./my-skill --slug my-skill
```

Read its stable ID and current revision before editing:

```bash
openclaw skills library read <skill-id> --json
```

Update only the instructions while preserving supporting files:

```bash
openclaw skills library update <skill-id> ./SKILL.md --expected-revision <revision-hash>
```

A directory input replaces the complete bundle. A single `SKILL.md` input
preserves the current supporting files; repeat `--delete-file <relative-path>`
to remove files explicitly. Updates compare the revision that was read; a
conflict requires reviewing the newer content, not a force overwrite.
Supporting files are part of the revision, including binary assets and
executable flags.

Import a ZIP privately:

```bash
openclaw skills library import ./my-skill.zip --slug my-skill
```

Import a ClawHub skill without publishing your library:

```bash
openclaw skills library import @owner/<slug> --clawhub --slug my-skill
```

`--version <version>` selects a ClawHub version and requires `--clawhub`.
`share`, `unshare`, `transfer`, `enable`, `disable`, `remove`, and `rollback`
take `<skill-id> --expected-revision <hash>`. Rollback also requires
`--revision <retained-hash>`.

Attach an exact revision to an existing session:

```bash
openclaw skills library attach --session <session-key> --skill-id <skill-id> --revision <revision-hash>
```

`detach` takes the same session and skill ID. Refresh one selected skill:

```bash
openclaw skills library refresh --session <session-key> --skill-id <skill-id>
```

Omitting `--skill-id` refreshes all selected skills and requires current library
access to each one. It never replaces the selection with the current caller's
library. Each operation reports its effect on the next turn.

Use `list --session <session-key>` to inspect selected revisions and the skills
you can attach, without changing the session. `read --session <session-key>`
also requires `--revision <hash>` and reads only that exact selected revision;
it does not expose other private revisions or grant permission to edit them.

Personal operations require an authenticated Gateway profile. The Control UI on a
single-user Gateway uses a durable owner profile, but ephemeral CLI connections
do not inherit it. A CLI shared token or password alone still has no personal
profile; use the existing workspace commands in that case. An explicitly selected
remote Gateway never falls back to a client-local personal library.

Sharing makes a skill available to teammates but does not grant edit access.
Transfer to team ownership requires administrator authority. Saving affects
new sessions by default; attach or refresh a selection explicitly for an
existing session. Removal preserves already selected revisions. See
[personal library ownership and revisions](/tools/skills#personal-skills-on-a-shared-gateway).

## Skill Workshop

`openclaw skills workshop` inspects and manages the learned (Workshop) skills
of the selected agent. Agents create and update these skills themselves; every
change applies immediately and saves the previous version first. See
[Skill Workshop](/tools/skill-workshop).

```bash
openclaw skills workshop list
openclaw skills workshop changes --limit 20
openclaw skills workshop show release-notes
openclaw skills workshop show release-notes --file references/checklist.md
openclaw skills workshop show release-notes --version <version-id>
openclaw skills workshop archive release-notes --reason "Superseded by deploy-notes"
openclaw skills workshop restore release-notes
openclaw skills workshop restore release-notes --version <version-id>
```

| Command                                        | Description                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `list`                                         | Lists live learned skills with usage counts, plus archived skills. Shows the autonomous mode and skills root.                   |
| `changes [--limit <n>]`                        | Shows recent changes, newest first: who made them (`agent`, `review`, `curator`, `user`), the action, and the saved version id. |
| `show <name> [--file <path>] [--version <id>]` | Prints `SKILL.md` or one support file, from the live skill or a saved version.                                                  |
| `archive <name> [--reason <text>]`             | Hides the skill from its agent. The skill stays restorable.                                                                     |
| `restore <name> [--version <id>]`              | Restores the newest saved version, or the named one. The current live copy is saved first, so restore is undoable.              |

Every Workshop command accepts `--agent <id>` and `--json`. `archive` and
`restore` act as `user` in the change feed.

## Related

- [CLI reference](/cli)
- [Skills](/tools/skills)
