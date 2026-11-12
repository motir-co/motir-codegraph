import pg from 'pg';

import { mintToken } from '../server/tokens.js';
import { OWNER_LOGIN, parseConnectionUrl } from './connection.js';

export interface BootstrapOperatorOptions {
  /** codegraph_owner's URL: DATABASE_URL. */
  ownerUrl: string;
  name?: string;
}

export interface BootstrappedOperator {
  clientId: string;
  /** Shown once: the caller prints it and keeps no copy. */
  token: string;
  displayPrefix: string;
}

export const DEFAULT_OPERATOR_NAME = 'bootstrap operator';

/** Refused because an operator already exists: the bootstrap is a one-off. */
export class OperatorExistsError extends Error {
  readonly operators: number;

  constructor(operators: number) {
    super(
      `${String(operators)} operator client${operators === 1 ? '' : 's'} already exist${
        operators === 1 ? 's' : ''
      }; the bootstrap creates only the first. Create another through POST /v1/operator/clients.`,
    );
    this.name = 'OperatorExistsError';
    this.operators = operators;
  }
}

/**
 * Creates the first operator client and its credential, as codegraph_owner,
 * and returns its token once. Refuses when any operator exists, so this one
 * door that needs no credential can never mint a second operator. An advisory
 * lock held for the transaction makes two concurrent runs create one operator.
 */
export async function bootstrapOperator(
  options: BootstrapOperatorOptions,
): Promise<BootstrappedOperator> {
  const owner = parseConnectionUrl('DATABASE_URL', options.ownerUrl);
  if (owner.user !== OWNER_LOGIN) {
    throw new Error(`DATABASE_URL must connect as ${OWNER_LOGIN}, not ${owner.user}.`);
  }
  const client = new pg.Client({ connectionString: options.ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('codegraph_bootstrap_operator'))");
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM codegraph.clients WHERE kind = 'operator'",
      );
      // count(*) always answers exactly one row.
      const existing = (rows[0] as { n: number }).n;
      if (existing > 0) {
        throw new OperatorExistsError(existing);
      }
      const minted = mintToken();
      const created = await client.query<{ id: string }>(
        'SELECT codegraph.codegraph_bootstrap_operator($1, $2, $3) AS id',
        [options.name ?? DEFAULT_OPERATOR_NAME, minted.hash, minted.displayPrefix],
      );
      await client.query('COMMIT');
      return {
        clientId: (created.rows[0] as { id: string }).id,
        token: minted.token,
        displayPrefix: minted.displayPrefix,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}
