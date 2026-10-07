# Spec calls: engine-fields

- validate rejects null for every type. Why: nullable is a field-level flag the store checks before calling validate; keeping validate pure per type avoids two sources of truth. Reversible: yes, one line per kind.
- Datetime accepts `YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z` only, calendar-checked by hand (no Date, banned in core). compare normalizes fractions, so `...:00Z` equals `...:00.000Z`. Why: ISO 8601 UTC with a Z suffix only; offsets are rejected. Reversible: yes.
- Sorting uses code-unit order for strings, declaration order for enum and state values. Why: deterministic, no locale. Reversible: yes.
- inferFromCsv ignores blank cells and sets `nullable: true` when any exist; an all-blank column infers nothing. Why: CSV exports leave missing values blank. Reversible: yes.
- inferFromCsv never returns money, ref or state. Why: a column cannot name a currency or target entity, and state needs transitions. Reversible: yes, add detection later.
- inferFromCsv returns number for decimals or non-safe integers (e.g. 1.0, 1e3), int only for safe integer literals. Why: keeps int lossless. Reversible: yes.
- Enum inference needs at least 30 rows (blank rows count) and at most 20 distinct non-blank values; values keep first-seen order. Why: reading of acceptance 6 ("length >= 30"). Reversible: yes, constants ENUM_MIN_ROWS and ENUM_MAX_DISTINCT.
- string vs text: any non-blank cell over 200 chars makes text. Why: acceptance says "by length" without a number. Reversible: yes, STRING_MAX_CHARS.
- text.parseQuery always fails with "no filter". Why: doc says text is not filterable. Reversible: yes.
- parseQuery for int and money accepts an optional leading minus and then applies min and max. number accepts decimals and exponents, not NaN or Infinity. Why: query strings should obey the same bounds as writes. Reversible: yes.
- string.validate with an invalid `pattern` fails with an expected naming the bad pattern instead of throwing. Why: validate never throws; check.ts owns catching bad patterns. Reversible: yes.
- ref examples.invalid also includes ''. Why: acceptance 4 says non-empty. Reversible: yes.
