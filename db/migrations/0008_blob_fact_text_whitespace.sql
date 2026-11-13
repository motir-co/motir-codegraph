-- 0008: blob_fact's non-empty-text check refuses EVERY whitespace-only value,
-- not only one made of spaces (MOTIR-11149).
--
-- 0006 tested each text column with `btrim(col) <> ''`. One-argument btrim
-- strips spaces and nothing else, so a value of tabs, newlines or a no-break
-- space passed a check that exists to refuse blank text. 0006 is applied, and
-- an applied file is never edited (docs/schema-contract.md §7), so this file
-- replaces the constraint under the same name.
--
-- "Blank" here is the set the producer side already uses: the extractor drops
-- a fact whose name is blank by `String.prototype.trim()`
-- (src/extract/buildFacts.ts), which strips ECMAScript WhiteSpace and
-- LineTerminator — tab, line feed, vertical tab, form feed, carriage return,
-- space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
-- U+3000 and U+FEFF. The database refuses exactly that set, so a row a second
-- producer writes cannot be blank by a rule the first producer would not
-- store, and the reverse.
--
-- The set is spelled out as a bracket expression of the regex engine's own
-- character-entry escapes rather than as `\s` or `[[:space:]]`, whose members
-- follow the database's ctype locale: a check whose meaning moves with the
-- cluster's locale is not one rule. The pattern also matches the empty string,
-- so '' stays refused. Adding the constraint validates every existing row, so
-- a blank row already stored fails this migration loudly rather than staying
-- behind a check that claims it cannot exist.

ALTER TABLE codegraph.blob_fact DROP CONSTRAINT blob_fact_text_nonempty_check;

ALTER TABLE codegraph.blob_fact ADD CONSTRAINT blob_fact_text_nonempty_check CHECK (
  language !~ '^[ \t\n\v\f\r   -     　﻿]*$'
  AND producer !~ '^[ \t\n\v\f\r   -     　﻿]*$'
  AND extractor_version !~ '^[ \t\n\v\f\r   -     　﻿]*$'
  AND (name IS NULL
       OR name !~ '^[ \t\n\v\f\r   -     　﻿]*$')
  AND (enclosing_name IS NULL
       OR enclosing_name !~ '^[ \t\n\v\f\r   -     　﻿]*$')
  AND (definition_kind IS NULL
       OR definition_kind !~ '^[ \t\n\v\f\r   -     　﻿]*$')
  AND (reference_kind IS NULL
       OR reference_kind !~ '^[ \t\n\v\f\r   -     　﻿]*$')
  AND (module_specifier IS NULL
       OR module_specifier !~ '^[ \t\n\v\f\r   -     　﻿]*$')
  AND (parent_name IS NULL
       OR parent_name !~ '^[ \t\n\v\f\r   -     　﻿]*$')
);
