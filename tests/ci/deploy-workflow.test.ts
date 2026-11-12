import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The deploy workflow (MOTIR-11102), read as TEXT: no suite here type-checks or
// lints workflow YAML, and the repository carries no YAML parser. Each check is
// on the lines that decide what the workflow does: when it runs, what token it
// may mint, which role it assumes, and that no AWS key or long-lived secret is
// written into it.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, 'utf8');
const deploy = read('.github/workflows/deploy.yml');
const ci = read('.github/workflows/ci.yml');

/** The workflow's top-level block `key:`, up to the next top-level key. */
function block(text: string, key: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start === -1) throw new Error(`no top-level ${key}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Za-z_-]+:/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** Lines without their comments, so a commented-out line never satisfies a check. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('the deploy workflow', () => {
  it('runs on a push to main and by hand, and on nothing else', () => {
    const on = code(block(deploy, 'on'));
    expect(on).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(triggers).toEqual(['push', 'workflow_dispatch']);
  });

  it('may mint an OIDC token, and only read the repository', () => {
    const permissions = code(block(deploy, 'permissions'));
    expect(permissions).toMatch(/^ {2}id-token: write$/m);
    expect(permissions).toMatch(/^ {2}contents: read$/m);
    expect(permissions.split('\n').filter((l) => l.includes(': write'))).toHaveLength(1);
  });

  it('assumes its roles through OIDC, from the repository variables', () => {
    const body = code(deploy);
    const assumptions = [...body.matchAll(/role-to-assume: (.+)$/gm)].map((m) => m[1]);
    expect(assumptions.length).toBeGreaterThan(0);
    expect(new Set(assumptions)).toEqual(
      new Set(['${{ vars.AWS_DEPLOY_ROLE_ARN }}', '${{ vars.AWS_ECR_PUSH_ROLE_ARN }}']),
    );
    expect(body).toContain('uses: aws-actions/configure-aws-credentials@v4');
  });

  it('writes in no AWS key and reads no long-lived AWS secret', () => {
    const body = code(deploy);
    expect(body).not.toMatch(/aws-access-key-id|aws-secret-access-key|aws-session-token/i);
    expect(body).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
    // An access key id's shape, anywhere in the file.
    expect(deploy).not.toMatch(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/);
    // The only secrets it reads are the App credentials that check out motir-infra.
    const secrets = new Set([...body.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect(secrets).toEqual(new Set(['INFRA_READER_APP_ID', 'INFRA_READER_APP_PRIVATE_KEY']));
  });

  it('pushes the image and deploys by its digest, with the codegraph-v2 deploy', () => {
    const body = code(deploy);
    expect(body).toContain('uses: docker/build-push-action@v6');
    expect(body).toMatch(/^ {10}push: true$/m);
    expect(body).toContain('/codegraph-v2/deploy-manifest');
    expect(body).toContain(
      'pnpm --silent deploy:services codegraph-v2 --digest "codegraph-v2=$DIGEST"',
    );
    expect(body).toContain('DIGEST: ${{ steps.digest.outputs.digest }}');
    expect(body).toMatch(/\^sha256:\[a-f0-9\]\{64\}\$/);
  });

  it('never cancels a running deploy', () => {
    const concurrency = code(block(deploy, 'concurrency'));
    expect(concurrency).toMatch(/^ {2}cancel-in-progress: false$/m);
  });
});

describe('CI', () => {
  it('builds the image on every pull request, and gates the merge on it', () => {
    expect(code(block(ci, 'on'))).toMatch(/^ {2}pull_request:$/m);
    const jobs = code(block(ci, 'jobs'));
    expect(jobs).toMatch(/^ {2}image:$/m);
    expect(jobs).toMatch(/^ {6}- name: Build the image$/m);
    expect(jobs).toMatch(/^ {4}needs: \[[^\]]*\bimage\b[^\]]*\]$/m);
  });
});
