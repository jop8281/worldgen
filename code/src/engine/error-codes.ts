/**
 * The closed catalog of runtime HTTP error codes: every code the engine itself answers a
 * request with, and its status (YOS-184).
 *
 * Invariants:
 * - `RuntimeErrorCode` is `keyof typeof RUNTIME_ERROR_CODES`. A code that is not in the
 *   catalog does not compile where the engine mints it: api.ts throws `refusal()`, http.ts
 *   answers through `worldError` and `adminError`, all typed on this union.
 * - Check issues are a different closed catalog (`ISSUES` in issues.ts): they name problems
 *   in a world.yaml, these name refused requests. The two sets share no code. Handler codes
 *   are a third, open set: a handler may `ctx.fail(409, 'ticket.closed')` with any code, so
 *   they stay world data (design.md s4 item 9).
 * - Out on purpose: `tx.aborted`, which an action turns into `action.failed`, and every code
 *   a handler passes to ctx.fail.
 * - Pure: one row per code, its HTTP status and a one-line meaning. openApiOf reads this
 *   table for `x-error-codes`, and test/error-codes.test.ts pins every literal in api.ts and
 *   http.ts to a member, so the document and the responses cannot drift apart.
 */
export const RUNTIME_ERROR_CODES = {
  // A routed call: api.ts, and the store refusals it surfaces
  'path.invalid': { status: 400, meaning: 'A path segment is not valid percent-encoding.' },
  'query.invalid': { status: 400, meaning: 'A query value does not parse: a filter, limit, sort, or the percent-encoding itself.' },
  'query.unknown': { status: 400, meaning: 'A query parameter this operation does not declare.' },
  'cursor.invalid': { status: 400, meaning: 'The cursor was not returned by this list, or was issued under another sort.' },
  'body.invalid': { status: 400, meaning: 'The request body is not a JSON object.' },
  'input.invalid': { status: 400, meaning: "The body breaks the action's input fields." },
  'route.not_found': { status: 404, meaning: 'No route or action matches the path.' },
  'row.not_found': { status: 404, meaning: 'No row has this id.' },
  'entity.unknown': { status: 404, meaning: 'An action handler named an entity the world does not have.' },
  'method.not_allowed': { status: 405, meaning: 'The path exists only under other methods.' },
  'field.unique': { status: 409, meaning: 'Another row already holds this value in a unique field.' },
  'delete.restricted': { status: 409, meaning: 'Another row references this one with onDelete restrict.' },
  'field.unknown': { status: 422, meaning: 'The body names a field the entity does not have.' },
  'field.readonly': { status: 422, meaning: 'The body sets id, created_at, updated_at or a readonly field.' },
  'field.required': { status: 422, meaning: 'A required field is missing.' },
  'field.null': { status: 422, meaning: 'A field that is not nullable would be null.' },
  'field.type': { status: 422, meaning: "A value does not fit the field's type." },
  'ref.unresolved': { status: 422, meaning: 'A ref names a row that does not exist.' },
  'state.initial': { status: 422, meaning: 'A create sets a state field to something other than its initial state.' },
  'state.transition': { status: 422, meaning: 'A write moves a state field along an undeclared transition.' },
  'action.failed': { status: 500, meaning: 'The action handler threw or returned a malformed result.' },
  // The runtime around a call: api.ts
  'idempotency_error': { status: 400, meaning: 'The Idempotency-Key was already used with a different request.' },
  'engine.internal': { status: 500, meaning: 'The runtime around the call failed; the call left no partial change.' },
  // The HTTP adapter: http.ts
  'body.too_large': { status: 413, meaning: 'The request body is larger than the adapter reads.' },
  'engine.error': { status: 500, meaning: 'The HTTP adapter failed while answering the request.' },
  // The admin routes: http.ts
  'clock.invalid': { status: 400, meaning: 'The admin clock body is not {"advance": "<duration>"}, or the move passes the latest instant.' },
  'task.unknown': { status: 404, meaning: 'The admin grade route names a task the world does not have.' },
  'grade.failed': { status: 500, meaning: 'Grading the named task failed.' },
} as const satisfies Record<string, { status: number; meaning: string }>;
export type RuntimeErrorCode = keyof typeof RUNTIME_ERROR_CODES;
