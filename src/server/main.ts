// `pnpm serve` / `pnpm start`: the HTTP server, as codegraph_app.
import { runServer } from './run.js';

const server = await runServer();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.app.log.info({ signal }, 'closing the listener, then the pool');
    server.shutdown().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        server.app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
