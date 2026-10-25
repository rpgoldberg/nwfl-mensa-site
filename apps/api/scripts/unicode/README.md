# scripts/unicode/

`confusables-18.0.0.txt.gz` is Unicode `confusables.txt` (UTS #39), version
18.0.0, from https://www.unicode.org/Public/18.0.0/security/confusables.txt,
compressed with `gzip -9 -n`. The uncompressed file's sha256 is
`6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92`;
`scripts/confusables-gen.ts` refuses any other input.

It is the input of `src/redaction/confusables.ts`, kept here so the table can be
regenerated, and checked, with no network (`node scripts/confusables-gen.ts
--check`; `test/tooling/confusables-gen.test.ts` runs it).

© Unicode, Inc. Used under the Unicode License v3, in `LICENSE` beside it
(https://www.unicode.org/license.txt).
