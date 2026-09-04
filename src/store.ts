import type { PublicFollowupMutation } from "./public-followup.js";
import type {
  Dep,
  PriorityCounts,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskUpdateResult,
  TaskQuery,
  TransitionOpts,
} from "./model.js";

/**
 * Backend capability descriptor (report §8). Optional capabilities degrade
 * gracefully: the CLI computes a missing capability from the core verbs, or
 * returns a structured error naming the capability — never a raw backend error.
 */
export interface Capabilities {
  /** Backend identifier, e.g. "markdown". */
  backend: string;
  deps: boolean;
  prune: boolean;
  comments: boolean;
  fullTextSearch: boolean;
  realtimeSync: boolean;
  /** Can it represent backend-specific states beyond queued/in_flight/done? */
  customStates: boolean;
  /** Does the server assign its own ids (remote trackers)? */
  serverMintsIds: boolean;
  /** Supports the durable, receipt-gated public-followup state machine. */
  publicFollowups: boolean;
}

export interface PruneOptions {
  state: State;
  keep: number;
  archive: boolean;
}

export interface PruneResult {
  archived: number;
  ids: string[];
}

export interface DependencyQueryResult {
  task: Task;
  items: Dep[];
}

export interface ClaimResult {
  task: Task;
  already: boolean;
}

/**
 * The single narrow seam every backend implements (report §8). The CLI layer
 * (arg parsing, TOON rendering, suggestions, help) never knows which backend
 * is active. `held` and public delivery readiness are derived in the CLI;
 * `ready`, `blocked`, and dependency reads use native backend hooks when
 * available and otherwise derive from the same core graph.
 *
 * The core contract is create/get/update/remove/list/transition/addDep/
 * removeDep/updatePublicFollowup. Backends may expose native coordination
 * queries and exclusive claiming; the CLI falls back to the core graph for
 * read-only queries. `prune` and `render` are optional and capability-gated.
 */
export interface Store {
  capabilities(): Capabilities;

  // CRUD
  create(input: TaskInput): Promise<Task>;
  get(id: string): Promise<Task | null>;
  /** Apply a patch and report which fields actually changed. */
  update(id: string, patch: TaskPatch): Promise<TaskUpdateResult>;
  remove(id: string): Promise<Task>;

  // query
  list(query: TaskQuery): Promise<{ items: Task[]; total: number }>;
  /** Backend-native dispatchable-work query when one exists. */
  ready?(query: TaskQuery): Promise<{ items: Task[]; total: number }>;
  /** Backend-native blocked-work query when one exists. */
  blocked?(query: TaskQuery): Promise<{ items: Task[]; total: number }>;
  /** Typed dependency query, including the owning task. */
  deps?(id: string): Promise<DependencyQueryResult>;
  /** Backend-native priority histogram when a cheap one exists; else derived. */
  priorities?(): Promise<PriorityCounts>;

  // state + dependencies
  transition(id: string, to: State, opts?: TransitionOpts): Promise<Task>;
  /** Atomically claim a task for the backend's current actor. */
  claim?(id: string): Promise<ClaimResult>;
  addDep(id: string, dep: Dep): Promise<boolean>;
  removeDep(id: string, dep: Dep): Promise<boolean>;

  /** Atomically replace one typed obligation revision and optionally complete it. */
  updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task>;

  // maintenance (optional, capability-gated)
  prune?(options: PruneOptions): Promise<PruneResult>;
  /** Normalize the persisted view (markdown: rewrite every item canonically). */
  render?(): Promise<number>;
}
