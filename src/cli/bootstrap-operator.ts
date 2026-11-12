// `pnpm operator:bootstrap [--name <name>]`: create the first operator, as
// codegraph_owner.
//
// Without OPERATOR_TOKEN it mints the token and prints it once, on stdout and
// nowhere else, and exits 1 when an operator already exists.
//
// With OPERATOR_TOKEN (a `cgk_` token a deploy generated and keeps in its secret
// store) it registers that token's hash instead, prints nothing on stdout, and
// exits 0 when an operator already exists, so every release can run it.
import { parseArgs } from 'node:util';

import { requireEnv } from '../config.js';
import { bootstrapOperator, OperatorExistsError } from '../db/operator.js';

const { values } = parseArgs({ options: { name: { type: 'string' } } });
const token = process.env.OPERATOR_TOKEN;
const fromEnvironment = token !== undefined && token !== '';

try {
  const operator = await bootstrapOperator({
    ownerUrl: requireEnv('DATABASE_URL'),
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(fromEnvironment ? { token } : {}),
  });
  if (fromEnvironment) {
    console.error(
      `created operator client ${operator.clientId} (credential ${operator.displayPrefix}…) ` +
        'from OPERATOR_TOKEN',
    );
  } else {
    console.error(
      `created operator client ${operator.clientId} (credential ${operator.displayPrefix}…); ` +
        'its token is printed once, on stdout, and is not stored anywhere readable',
    );
    console.log(operator.token);
  }
} catch (error) {
  if (fromEnvironment && error instanceof OperatorExistsError) {
    console.error(`${error.message} OPERATOR_TOKEN left unregistered; nothing changed.`);
  } else {
    console.error(error instanceof OperatorExistsError ? error.message : String(error));
    process.exitCode = 1;
  }
}
