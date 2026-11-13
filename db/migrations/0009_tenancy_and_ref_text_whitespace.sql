-- 0009: the remaining non-blank checks refuse EVERY whitespace-only value,
-- not only one made of spaces (MOTIR-11186).
--
-- 0001 and 0007 tested five text columns with `btrim(col) <> ''`, the form 0008
-- (MOTIR-11149) already replaced on blob_fact. One-argument btrim strips spaces
-- and nothing else, so a value of tabs, newlines or a no-break space passed a
-- check that exists to refuse blank text:
--
--   tenants.display_name             tenants_display_name_check             (0001)
--   repositories.display_name        repositories_display_name_check        (0001)
--   clients.name                     clients_name_check                     (0001)
--   content_access_log.content_ref   content_access_log_content_ref_check   (0001)
--   ref_heads.ref_name               ref_heads_ref_name_check               (0007)
--
-- 0001 and 0007 are applied, and an applied file is never edited
-- (docs/schema-contract.md §7), so this file replaces each constraint under
-- the name it already has. After it, no check in the schema uses btrim.
--
-- "Blank" is the set 0008 uses, and it is also the server's: the operator
-- routes require a display name to match the JSON-schema pattern `\S`
-- (src/server/operator.ts), and the ECMAScript `\s` class is exactly the set
-- `String.prototype.trim()` strips — ECMAScript WhiteSpace and
-- LineTerminator: tab, line feed, vertical tab, form feed, carriage return,
-- space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
-- U+3000 and U+FEFF. The database refuses exactly that set, so a row written
-- directly, or by a second writer, cannot be blank by a rule the server would
-- refuse, and a name the server accepts is never refused here.
--
-- The set is spelled as the regex engine's own character-entry escapes (and
-- the literal non-ASCII spaces) rather than as `\s` or `[[:space:]]`, whose
-- members follow the database's ctype locale, and NOT as
-- `btrim(col, E' \t\n\r\f\v')`: in a Postgres escape string `\v` is a literal
-- `v`, so that set would refuse a name like 'v'. The pattern also matches the
-- empty string, so '' stays refused. Adding a constraint validates every
-- existing row, so a blank row already stored fails this migration loudly
-- rather than staying behind a check that claims it cannot exist.

ALTER TABLE codegraph.tenants DROP CONSTRAINT tenants_display_name_check;
ALTER TABLE codegraph.tenants ADD CONSTRAINT tenants_display_name_check
  CHECK (display_name !~ '^[ \t\n\v\f\r   -     　﻿]*$');

ALTER TABLE codegraph.repositories DROP CONSTRAINT repositories_display_name_check;
ALTER TABLE codegraph.repositories ADD CONSTRAINT repositories_display_name_check
  CHECK (display_name !~ '^[ \t\n\v\f\r   -     　﻿]*$');

ALTER TABLE codegraph.clients DROP CONSTRAINT clients_name_check;
ALTER TABLE codegraph.clients ADD CONSTRAINT clients_name_check
  CHECK (name !~ '^[ \t\n\v\f\r   -     　﻿]*$');

ALTER TABLE codegraph.content_access_log DROP CONSTRAINT content_access_log_content_ref_check;
ALTER TABLE codegraph.content_access_log ADD CONSTRAINT content_access_log_content_ref_check
  CHECK (content_ref !~ '^[ \t\n\v\f\r   -     　﻿]*$');

ALTER TABLE codegraph.ref_heads DROP CONSTRAINT ref_heads_ref_name_check;
ALTER TABLE codegraph.ref_heads ADD CONSTRAINT ref_heads_ref_name_check
  CHECK (ref_name !~ '^[ \t\n\v\f\r   -     　﻿]*$');
