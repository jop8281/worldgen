/**
 * Agent-episode analytics for the studio's Agent Playground (YOS-190): exported episodes grouped by
 * world, task and agent model, with success rate, failure causes, cost per successful episode and
 * the engine commits and world versions they ran on. Pure: no IO, no model.
 *
 * A success is `isCompleteSuccess` from the dataset schema: the engine scored the end state 1, the
 * agent finished with a reply, and the cost is fully known. A correct reply alone is not a success.
 */
import { isCompleteSuccess, type Episode } from '../dataset/schema.ts';

export type EpisodeGroup = {
  readonly world: string;
  readonly task: string;
  readonly model: string;
  readonly runs: number;
  readonly successes: number;
  /** Successes over runs, rounded to 4 decimals. */
  readonly successRate: number;
  /** Known model spend over every run of the group. */
  readonly costUsd: number;
  /** costUsd over successes, or null when nothing succeeded. */
  readonly costPerSuccessUsd: number | null;
  readonly meanTurns: number;
  /** Why runs that did not succeed ended: their stop reason, or `scored <n>` for a `done` run the engine scored below 1. */
  readonly failures: Readonly<Record<string, number>>;
  readonly engineCommits: readonly string[];
  readonly worldVersions: readonly string[];
};

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** Why a run that is not a complete success ended. */
function causeOf(e: Episode): string {
  if (e.stop_reason !== 'done') return e.stop_reason;
  if (e.score !== 1) return `scored ${e.score === null ? 'none' : e.score}`;
  if (e.error !== null) return 'error';
  return 'incomplete record';
}

/** Groups episodes by world, task and model, in that sort order. */
export function summarizeEpisodes(episodes: readonly Episode[]): readonly EpisodeGroup[] {
  const groups = new Map<string, Episode[]>();
  for (const e of episodes) {
    const key = JSON.stringify([e.world_id, e.task_id, e.model]);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, list]) => {
    const [world, task, model] = JSON.parse(key) as [string, string, string];
    const successes = list.filter(isCompleteSuccess).length;
    const costUsd = round(list.reduce((s, e) => s + e.usage.cost_usd, 0), 6);
    const failures: Record<string, number> = {};
    for (const e of list) {
      if (isCompleteSuccess(e)) continue;
      const cause = causeOf(e);
      failures[cause] = (failures[cause] ?? 0) + 1;
    }
    return {
      world, task, model,
      runs: list.length,
      successes,
      successRate: round(successes / list.length, 4),
      costUsd,
      costPerSuccessUsd: successes === 0 ? null : round(costUsd / successes, 6),
      meanTurns: round(list.reduce((s, e) => s + e.messages.filter((m) => m.role === 'assistant').length, 0) / list.length, 2),
      failures,
      engineCommits: [...new Set(list.map((e) => e.engine_commit))].sort(),
      worldVersions: [...new Set(list.map((e) => e.world_version))].sort(),
    };
  });
}
