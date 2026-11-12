// `pnpm operator:bootstrap [--name <name>]`: create the first operator and
// print its token once, on stdout and nowhere else. Run as codegraph_owner.
import { parseArgs } from 'node:util';

import { requireEnv } from '../config.js';
import { bootstrapOperator, OperatorExistsError } from '../db/operator.js';

const { values } = parseArgs({ options: { name: { type: 'string' } } });

try {
  const operator = await bootstrapOperator({
    ownerUrl: requireEnv('DATABASE_URL'),
    ...(values.name === undefined ? {} : { name: values.name }),
  });
  console.error(
    `created operator client ${operator.clientId} (credential ${operator.displayPrefix}…); ` +
      'its token is printed once, on stdout, and is not stored anywhere readable',
  );
  console.log(operator.token);
} catch (error) {
  console.error(error instanceof OperatorExistsError ? error.message : String(error));
  process.exitCode = 1;
}
