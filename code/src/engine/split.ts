/**
 * The public/private world split (YOS-159, A-224).
 *
 * Private task material is what a grader needs or what could teach one: `grader`, `solution`,
 * every decoy (`script` and `why`) and every alternative. Public: `difficulty` and `instruction`
 * (research/architecture.md, "Private task boundary": the instruction is public, the agent is
 * told it). Everything outside `tasks` is public: the model, routes, handlers, jobs, seed,
 * fixtures and the world's own `tests`, which are acceptance scenarios the world author wrote.
 *
 * A world is either private (every task complete) or public (every task bare). A mix is
 * `tasks.private_mixed`, because a public bundle of it would still carry grader source. The
 * check layer (check.ts) enforces the rule; the pipeline (dataset/pipeline.ts) writes both
 * forms through saveWorld. The WID is computed from the full private world only (worldIdOf in
 * index.ts), so the public form stays bound to the private one by identity, never by content.
 */
import type { CheckedWorld } from './check.ts';
import type { Task, World } from './format.ts';

/** A task with its private material: grader and solution present. */
export function isPrivateTask(task: Task): boolean {
  return task.grader !== undefined && task.solution !== undefined;
}

/** A task with no private material at all: difficulty and instruction only. */
export function isPublicTask(task: Task): boolean {
  return task.grader === undefined && task.solution === undefined && task.decoys.length === 0 && task.alternatives.length === 0;
}

/** How a world's tasks split. `private` for a world with no tasks, so `world.too_few_tasks` stays its error. */
export type TaskPrivacy = 'private' | 'public' | 'mixed';

export function taskPrivacy(world: World): TaskPrivacy {
  const tasks = Object.values(world.tasks);
  if (tasks.length === 0) return 'private';
  if (tasks.every(isPublicTask)) return 'public';
  if (tasks.every(isPrivateTask)) return 'private';
  return 'mixed';
}

/** Every task of the world that is not a public task, with whether it is complete. */
export function privacySplit(world: World): { readonly complete: readonly string[]; readonly bare: readonly string[] } {
  const complete: string[] = [];
  const bare: string[] = [];
  for (const [id, task] of Object.entries(world.tasks)) {
    if (isPrivateTask(task)) complete.push(id);
    else bare.push(id);
  }
  return { complete, bare };
}

/** The public form of one task: difficulty and instruction, nothing else. */
export function publicTask(task: Task): Task {
  return { difficulty: task.difficulty, instruction: task.instruction, decoys: [], alternatives: [] };
}

/**
 * The public form of a world: every task bare, every other section untouched. Same task ids,
 * same difficulty and instruction, same entities, routes, actions, jobs, fixtures, seed and
 * tests. Not checked: `checkWorld(publicWorldOf(w))` mints the CheckedWorld a public bundle
 * serves from, and the tasks layer accepts it because every task is bare.
 */
export function publicWorldOf(world: CheckedWorld): World {
  return { ...world, tasks: Object.fromEntries(Object.entries(world.tasks).map(([id, task]) => [id, publicTask(task)])) };
}
