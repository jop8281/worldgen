/**
 * Ends every switch over a closed union (RunEvent, StopReason, Decision, Input, FieldType).
 * Such switches end in `default: return assertNever(x)`, never in a silent default.
 * test/architecture.test.ts fails on a `default:` branch that does not call assertNever.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}
