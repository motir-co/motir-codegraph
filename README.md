# motir-codegraph

motir-codegraph is Motir's code graph service, built as a product of its own: a
multi-tenant index of source repositories that answers questions about code
(definitions, references, file contents) for the clients it has issued
credentials to. Motir is one such client. The service has its own repository,
its own Postgres database and its own logins, and it **runs with no Motir service
present**: nothing in it needs motir-core or motir-ai to start, migrate or test.

License: **GPL-3.0-only** (see [LICENSE](LICENSE)).

## Bring-up

The steps to bring the service up locally follow below.
