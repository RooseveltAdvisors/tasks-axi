# tasks-axi — agent notes

Agent-ergonomic task/backlog CLI in the `*-axi` family, built on `axi-sdk-js` and mirroring `gh-axi`.
It ships markdown and Beads (`bd`) backends behind a `Store` seam; sqlite and remote trackers are deferred.

## Architecture

The CLI layer never knows which backend is active — it only talks to the `Store` interface.

- `src/cli.ts` — `runAxiCli` wiring: `DESCRIPTION`, `TOP_HELP`, verb→handler map (aliases create/view/edit/delete/close), optional `task` noun prefix, global `--backend` / `--file` flags.
- `src/context.ts` — `resolveTasksContext` builds backend `Store` + `ResolvedConfig` received by every command.
- `src/store.ts` — `Store` interface and `Capabilities`. Core contract: `create/get/update/remove/list/transition/addDep/removeDep/updatePublicFollowup`; optional hooks: `ready`/`blocked`/`deps`/`claim`/`priorities`, `prune`/`render`.
- `src/model.ts` — `Task` data model.
- `src/pr-url.ts` — `isPrUrl`, canonical PR-URL seam (GitHub `/pull/<n>` on github.com, Forgejo `/pulls/<n>` on lowercase DNS host); near-misses derive as `doc` links, never `pr`. Shared by link derivation, `--pr`, and public-followup `pr_url`.
- `src/derive.ts` — fallback worker `blocked` / `ready` / active `held`, public delivery, and priority-histogram projections.
- `src/priority-why.ts` — `priority-why: <text>` managed body line: parsed into `task.priority_why` (out of displayed body), re-emitted first on dirty render so `update --body` cannot silently strip it.
- `src/backends/markdown*.ts` — byte-preserving Markdown backend (`markdown-grammar.ts` pure parse/render, `markdown.ts` lock/I/O).
- `src/backends/beads.ts` — `bd` CLI adapter: maps ID, hold, and dep reasons; native ready/blocked/deps/claim hooks. Unbounded streaming runner `spawnBd` (see comment in file; guarded by `test/backends/beads-runner.test.ts`). Standalone temporary Git repo required before `bd init` (`test/backends/beads-live.test.ts`).
- `src/public-followup.ts` — schema, privacy-safe validation, canonical encoding, immutable fields, lifecycle invariants for `kind=public-followup`; state machine in `src/commands/public-followup.ts`.
- `src/commands/*` — verb handlers; `src/view.ts` (read TOON projection), `src/confirm.ts` (terse `ok:` line, `--json`, `renderMutation`).
- Shared helpers: `args.ts`, `body.ts`, `format.ts`, `fields.ts`, `toon.ts`, `suggestions.ts`, `skill.ts`.

## Beads reads must stay bounded, not proportional to backlog size

Every `bd` invocation spawns `git` and takes `.beads/embeddeddolt/.lock`. N+1 reads cause fleet-wide lock contention and hangs. All reads must remain bounded O(1) calls (regression-tested on invocation sequences in `test/backends/beads.test.ts`; benchmark in `scripts/bench-beads.ts`):

- **Payloads carry dependency graph inline:** `bd list`/`bd ready` attach edge records (`issue_id`/`depends_on_id`/`type`); `bd show` attaches dependency beads with status. `inlineDeps` decodes both: `list` is one `bd list --all` plus one `bd blocked` (no `bd dep list` or `bd show` fan-out). `bd dep list` survives only for `remove`'s `--direction up` check.
- **Statuses resolve from data in hand:** blocker statuses come from `bd list --all` or show's inline deps. Missing ids are batched via `bd show <ids...>` capped by `SHOW_BATCH_SIZE`.
- **Reads cached per process:** keyed by exact bd argv (`readCache` in `call`). Dropped on any mutating verb.
- **`bd blocked` owns native blocker refs:** tasks without blocked-by deps report empty blockers without calling `bd blocked`; tasks with deps use cached whole-backlog `bd blocked`. Never derive blocker refs yourself.
- **Fail-open on mid-read vanishing:** if another agent removes a task between reads, the survivor keeps its edges and the missing task does not render without failing the read.
- **Single-task read (`showCommand`):** exactly two subprocesses (`bd show` + cached `bd blocked` when blocked-by deps exist).
- **CLI view layer avoids fan-out:** `withDependencyTargets` (`src/commands/state.ts`) resolves dep-target states through one `store.list({})` call, never per-target `get`.

## Markdown grammar invariants (the hard part — do not regress)

`src/backends/markdown-grammar.ts` is pure parse/render with no I/O; `markdown.ts` adds locking and atomic writes.

- **Byte-exact round-trip (D1):** `render(parse(src)) === src` on untouched files. Untouched entries retain verbatim `raw` lines; dirty entries re-render from structured fields. Tested against `test/fixtures/backlog.md` and `test/fixtures/firstmate-backlog.md`.
- **Section headers carry state:** `## In flight`, `## Queued`, `## Done`. Rendering normalizes both in-flight and queued to `- [ ] id - …` (done to `- [x] id - …`). Legacy `- **id**` in-flight normalizes to `- [ ]` and is never rewritten back.
- **Free-form lines (D7):** lines not matching `<slug> - ` delimiter are preserved verbatim and never operated on by id.
- **Trailing-tag extraction:** canonical tags (`(repo:)`, `(kind:)`, `(priority: 0-4)`, `(since DATE)`, `(merged|reported|done|closed DATE)`, `(hold:)`, `(hold-kind:)`, `(hold-until:)`, `blocked-by:/parent:/discovered-from:`) are extracted only from the trailing tag region and re-emitted in canonical order. Dates require `YYYY-MM-DD`. Mid-sentence or non-date parentheticals stay in prose.
- **Dependency edges with optional reason:** format `blocked-by: <id> - <reason>`. Reason is preserved in `Dep.reason`. Bare edges render after title before `( … )` tags; edges with reasons render last after all tags for idempotent re-parsing.
- **Links and leading-word kinds:** live in prose, not managed tags. `done --pr`/`--report` append to title. `kind` is extracted from `(kind:)` or leading keywords (`SHIP`/`SCOUT`/`DOCS-ONLY`/`PERSISTENT SECONDMATE`).
- **Body block:** 2-space indented or blank lines under a bullet. Managed `priority-why: <text>` is lifted into `task.priority_why` and re-emitted first on dirty render; deeper indentation (4+ spaces) is ordinary body. Inspect with `show <id> --full`, update via `update --body` or `--body-file` (`--archive-body` preserves superseded body in `note-archive.md`).
- **Public-followup metadata:** reserved comment `  <!-- tasks-axi:public-followup/v1:<base64url-canonical-json> -->` immediately below bullet. Excluded from human body, strictly validated, preserved across operations. Generic worker readiness cannot dispatch/complete/reopen/remove/change kind; only receipt or Captain waiver completes it.
- **Concurrency:** mutations use advisory lock `<path>.lock` via `withLock` (stale lock reported if timeout expires). Corruption-safe atomic temp-file + rename. Concurrent hand-edits are detected and refused. Reads do not lock.

## Conventions

- **`bd create` carries `--due`:** house Beads fork enforces `due.required`. Adapter supplies relative offsets `BEADS_DUE_LADDER` (`+1d` P0 .. `+30d` P4) to match `bd q`. Never disable or auto-fill. Fixtures shelling out to `bd create` must supply one (`test/fixtures/synthetic-beads.ts` uses fixed date).
- **bd validation errors on STDOUT:** `call` (`src/backends/beads.ts`) parses JSON error on stdout first, falling back to stderr.
- **Priority discipline:** `add` defaults to P2 on beads (markdown has no default). P0/P1 requires `--why "<one line>"` on beads; `--why` is forbidden on P2+ (`parsePriorityPair` in `src/commands/crud.ts`). Persists as `priority-why:` body line. Caller body text carrying it is rejected (`assertNoManagedPriorityWhyLine` in `src/priority-why.ts`).
- **`priorities` reports open first, all-time second:** headline counts open tasks, all-time beneath (`countPriorities` in `src/derive.ts`; native hook on beads).
- **Ids:** caller-supplied join keys (D6) validated by `ID_RE` (slug); `add --mint [--prefix]` generates `slug-xx`.
- **Pruning & archiving:** `prune` appends surplus Done tasks to `markdown.archive` or `done-archive.md`, never deleting (D4). Free-form lines are preserved and uncounted. `done` auto-prunes on Markdown to `config.doneKeep` (default 10) unless `--no-prune`.
- **`done` idempotency:** completing an already-Done task backfills `--pr`, `--report`, and non-duplicate `--note` without replacing original closed date.
- **Dependency validation:** `add --blocked-by` and `block --by` reject missing blockers and self-blocks. Dangling blockers treated as resolved for legacy files.
- **Blocking tasks protected:** `rm` and single-id `mv` reject tasks blocking active dependents.
- **Atomic cross-file `mv`:** `mv <id...> --to <path>` moves task sets under multi-file lock (`MarkdownStore.moveManyTo`). Intra-set deps survive; split deps are rejected (`requireNoSplitDeps`).
- **Structured holds:** `hold <id> --reason "<text>" [--until YYYY-MM-DD] [--kind captain|external|load|parked|future]`, cleared by `unhold <id>`. Reasons cannot contain parentheses. Active holds gate readiness (`ready --include-held` emits held group). Filters via `list --state held`, `--fields held,...`.
- **Hold migration mapping:** prose markers map to structured kinds (`HELD` -> captain, `PARKED` -> parked, `DEFERRED` -> future, load clearing -> load, external deps -> external).
- **Mutations & confirmation:** lead with terse `ok:` line (`confirm.ts`), followed by structured detail and state-aware hints (`getSuggestions`). Idempotent mutations exit 0 with `already: true`. Errors use SDK codes (`VALIDATION_ERROR`→2, else 1).
- **`--json` success signal:** replaces TOON output with `{ ok: true, action, [already], ... }`. Errors use structured stderr + non-zero exit.

## Entry point & the `--version` fast path

`bin/tasks-axi.ts` answers bare `-v`/`-V`/`--version` via `axi-sdk-js/fast-path` before dynamic import of `src/cli.js`. `src/version.ts` must remain a leaf importing only node builtins. Guarded deterministically by `test/bin/version-fast-path.test.ts`.

## Build / test / ship

- `pnpm build` (tsc), `pnpm test` (vitest, `test/` mirrors `src/`), `pnpm lint` (eslint), `pnpm run build:skill -- --check`.
- Shipped skill stays minimal and defers to CLI; regenerate via `pnpm run build:skill` (never hand-edit `skills/tasks-axi/SKILL.md`).
- Repo is no-mistakes-gated; ship through `/no-mistakes`.

### Release & packaging (mirrors `*-axi` siblings)

- Published to npm via `release-please` (`.github/workflows/release-please.yml`).
- PR workflows use `paths-ignore` for release files (`.release-please-manifest.json`, `CHANGELOG.md`, `package.json`), guarded by `test/release-ci-exclusions.test.ts`.
- Tarball ships runtime JS only (`package.json` `files` is `dist/**/*.js`). `prepack` runs `npm run build`. Verify with `npm pack --dry-run`.
- CI runs 3-OS matrix.
- `Require no-mistakes` workflow delegates to shared action `kunchenguid/no-mistakes/.github/actions/require-no-mistakes` pinned to immutable commit SHA. Push through `git push no-mistakes` to refresh PR body attestation. `on.pull_request.types` omits `synchronize`.

## Follow-ups (out of P1 scope)

- Migrate firstmate's own `backlog.md` onto tasks-axi.
- Additional backends: sqlite (P2), github/jira/linear (P3) behind `Store` seam.
- Count free-form Done lines toward prune keep or recognize compound ids.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
