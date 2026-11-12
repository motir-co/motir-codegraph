import { resolveRepository } from '../binding.js';
import { notIndexedStatus, type RepositoryStatus } from '../status.js';
import type { V1Routes } from '../v1.js';

/**
 * `GET /v1/tenants/:tenantId/repositories/:repositoryId/status`. Its refusals
 * are the one path's: the hooks answer 401 and the ungranted-tenant 403, and
 * `resolveRepository` answers 404. Its only read is that resolver's.
 */
export const statusRoutes: V1Routes = (v1) => {
  v1.get(
    '/tenants/:tenantId/repositories/:repositoryId/status',
    async (request): Promise<RepositoryStatus> =>
      notIndexedStatus(await resolveRepository(request)),
  );
};
