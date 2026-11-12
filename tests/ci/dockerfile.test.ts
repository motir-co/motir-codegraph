import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The image's shape (MOTIR-11102). The image is built, and its commands run, in
// CI's `Docker image` job; these checks name the lines whose loss would break
// the service or the deploy's release without failing a build.

const dockerfile = readFileSync(
  fileURLToPath(new URL('../../Dockerfile', import.meta.url)),
  'utf8',
);
const instructions = dockerfile
  .split('\n')
  .filter((line) => line !== '' && !line.startsWith('#'))
  .join('\n');

describe('the Dockerfile', () => {
  it('runs the compiled server with node itself, so SIGTERM reaches its drain', () => {
    expect(instructions).toMatch(/^CMD \["node", "dist\/server\/main\.js"\]$/m);
    expect(instructions).not.toMatch(/^(CMD|ENTRYPOINT) .*pnpm/m);
  });

  it('keeps what the release task runs: the CLIs, tsx and the migrations', () => {
    expect(instructions).toMatch(/^COPY src \.\/src$/m);
    expect(instructions).toMatch(/^COPY db \.\/db$/m);
    // The full dependency set: tsx, which `pnpm db:migrate` imports, is a devDependency.
    expect(instructions).toMatch(/^RUN pnpm install --frozen-lockfile$/m);
    expect(instructions).not.toMatch(/--prod\b/);
    expect(instructions).toMatch(/^RUN pnpm build$/m);
  });

  it('has the pinned pnpm in the image, so a release downloads nothing', () => {
    expect(instructions).toMatch(/corepack install/);
    expect(instructions).toMatch(/COREPACK_HOME=\/opt\/corepack/);
  });

  it('carries the RDS CA bundle where motir-infra points NODE_EXTRA_CA_CERTS', () => {
    expect(instructions).toMatch(/^WORKDIR \/app$/m);
    expect(instructions).toMatch(
      /^COPY certs\/rds-global-bundle\.pem \.\/certs\/rds-global-bundle\.pem$/m,
    );
  });

  it('runs as the unprivileged node user, on port 8080', () => {
    expect(instructions).toMatch(/^USER node$/m);
    expect(instructions).toMatch(/^EXPOSE 8080$/m);
  });
});
