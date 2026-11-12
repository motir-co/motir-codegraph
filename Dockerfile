# syntax=docker/dockerfile:1
#
# motir-codegraph: the code graph API, on ECS Fargate behind motir-infra's
# internal load balancer (MOTIR-10993). One image runs two things:
#
#   - the service: `node dist/server/main.js`, the compiled server (`pnpm start`);
#   - the deploy's release task, from the same image and before any task rolls:
#     `pnpm db:migrate && pnpm operator:bootstrap` (motir-infra's
#     CODEGRAPH_V2_RELEASE_COMMAND), which run the TypeScript CLIs through tsx.
#
# So the image keeps the full dependency set (tsx is a devDependency), src/
# with its CLIs, and db/migrations/ beside the compiled dist/.

FROM node:22-slim

# pnpm through corepack, at the version package.json pins, fetched NOW: the task
# runs in private subnets, and a release that first had to download pnpm would
# depend on a network call it may not have. COREPACK_HOME outside root's home,
# so the unprivileged user below finds the prepared copy.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
 && corepack install \
 && chmod -R a+rX /opt/corepack

# Dependencies against the frozen lockfile, in a layer of their own so a source
# change does not reinstall them. The FULL set: the release runs tsx.
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY db ./db
RUN pnpm build

# Amazon's RDS CA bundle. node-postgres verifies the server certificate
# (`sslmode=verify-full`) and Node does not ship the RDS roots; motir-infra
# points NODE_EXTRA_CA_CERTS at this path (RDS_CA_BUNDLE_PATH). Vendored, so the
# build never depends on a network call; refresh it from
# https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem when AWS
# adds a CA.
COPY certs/rds-global-bundle.pem ./certs/rds-global-bundle.pem

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

# The node image's unprivileged user: nothing in /app needs writing at run time.
USER node

# node directly, not `pnpm serve`/`pnpm start`: a package manager and its script
# shell sit between the container's SIGTERM and the server, neither forwards it,
# and the server's drain (src/server/main.ts) would never run. `pnpm serve` still
# works in the image for a person who wants the tsx path.
CMD ["node", "dist/server/main.js"]
