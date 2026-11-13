// `pnpm reextract [--language <id>]…`: rebuild every stale blob, across every
// tenant, of each registered language the shipped staleness predicate reports
// stale, on the owner login (DATABASE_URL). The decision lives in
// src/indexing/reextractRun.ts; this entry parses, prints and sets the exit
// code, which is 1 unless every planned language is confirmed drained.
import { parseArgs } from 'node:util';

import { requireEnv } from '../config.js';
import { OWNER_LOGIN } from '../db/connection.js';
import { runReextraction, type ReextractionOutcome } from '../indexing/reextractRun.js';

const USAGE = `usage: pnpm reextract [--language <id>]…

  Re-extracts the stale blobs of every registered language, across every
  tenant, from their stored contents. Connects as ${OWNER_LOGIN} through
  DATABASE_URL and refuses any other login.

  --language <id>  sweep only this language (repeatable); an id
                   listLanguages() does not answer is refused.
  -h, --help       prints this text.`;

function outcomeLine(outcome: ReextractionOutcome): string {
  return (
    `language=${outcome.language} version=${outcome.extractorVersion} status=${outcome.status} ` +
    `blobs=${String(outcome.blobCount)} facts=${String(outcome.factCount)}`
  );
}

async function main(languages: readonly string[] | undefined): Promise<void> {
  const run = await runReextraction({
    connectionString: requireEnv('DATABASE_URL'),
    ...(languages === undefined ? {} : { languages }),
  });
  const planned = run.plan.map((entry) => entry.language);
  console.log(
    `plan: ${String(planned.length)} language(s) have stale blobs` +
      (planned.length > 0 ? `: ${planned.join(', ')}` : ''),
  );
  for (const outcome of run.outcomes) {
    for (const batch of outcome.batches) {
      console.log(
        `batch language=${outcome.language} ordinal=${String(batch.ordinal)} ` +
          `blobs=${String(batch.blobCount)} facts=${String(batch.factCount)}`,
      );
    }
    console.log(outcomeLine(outcome));
    if (outcome.reason !== null) {
      console.error(`reextract ${outcome.language} ${outcome.status}: ${outcome.reason}`);
    }
  }
  console.log(
    `reextract: languages=${String(run.outcomes.length)} swept=${String(run.counts.swept)} ` +
      `skipped=${String(run.counts.skipped)} failed=${String(run.counts.failed)} ` +
      `blobs=${String(run.blobCount)} facts=${String(run.factCount)}`,
  );
  if (!run.drained) process.exitCode = 1;
}

try {
  const { values } = parseArgs({
    options: {
      language: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
  } else {
    await main(values.language);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
