/** Parsing evidence does not mint the engine's branded TaskVerdict. */
export interface TaskInventoryEntry {
  readonly task: string;
  readonly difficulty: 'easy' | 'medium' | 'hard';
  readonly decoyCount: number;
}
export interface ProofValidation {
  readonly ok: boolean;
  readonly issues: string[];
  readonly records: unknown[];
}
export function inventoryIssues(inventory: unknown): string[];
export function parseProofs(text: unknown, inventory: unknown): ProofValidation;
export function parseCheck(text: unknown): { ok: boolean; errors: number; issues: string[] };
