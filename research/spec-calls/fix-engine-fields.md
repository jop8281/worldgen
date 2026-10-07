# Spec calls: fix-engine-fields

- All six findings reproduced at base (probes-a p5 / C2 cases): fieldSchema accepted bad state initial, unknown transition targets, enum default outside values, int min > max, string default over maxLength or off pattern, and an invalid regex. All now refused.
- New catalog codes: `field.default_invalid`, `field.range_inverted`, `field.pattern_invalid`. State problems reuse `state.bad_machine` with the same path, found and hint text as check.ts. Why: one code per fix target, no duplicate wording. Reversible: yes.
- Mechanism: each kind's zod object gets a superRefine calling `consistency()`; refinement issues carry `params.issue` and `fromZod` mints the catalog issue instead of `schema.invalid`. Why: checkWorld, applyEdit and fieldSchema all go through fromZod, so acceptance 3 holds without touching check.ts.
- Consequence: a bad state machine now fails at the `schema` layer, not `references`. check.ts still reports unreachable states (needs the whole machine). Test edit outside scope under standing order 15: test/check.test.ts "reports an initial state that is not declared" lists `routes` among the blocked sections because the schema layer skips the references layer for routes too. Behavior assertions (code, path, found, hint) unchanged.
- number min > max is refused as well as int (same defect class). int/number default outside min/max is not checked (not listed). Reversible: yes.
- An invalid pattern suppresses the default-vs-pattern check, so one problem yields one issue.
- test/fields.test.ts: the old validate test passed pattern '(' through schema.parse; it now builds the def literally, since the schema refuses it.
