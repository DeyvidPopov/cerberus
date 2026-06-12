import {
  CreateVaultItemRequestSchema,
  UpdateVaultItemRequestSchema,
  UuidSchema,
  type CreateVaultItemRequest,
  type SessionInfo,
  type UpdateVaultItemRequest,
  type VaultKeyResponse,
  type VaultMutationResponse,
} from '@cerberus/shared-types';
import { Router, type RequestHandler, type Response } from 'express';

import { asyncHandler } from '../middleware/async-handler';
import { validateBody } from '../middleware/validate';
import type { VaultService } from '../services/vault';

export interface VaultRouterDeps {
  vaultService: VaultService;
  /** Session-auth middleware (M4) — applied to ALL sync routes. */
  authenticate: RequestHandler;
  /** Per-user rate limit (PROJECT.md §4.3). */
  rateLimit: RequestHandler;
}

function sessionUserId(res: Response): string {
  return (res.locals.session as SessionInfo).userId;
}

// An `:id` that isn't a UUID can't belong to the user (and would error the typed
// query); treat it as not-found — uniform with not-owned, so no existence leak.
function itemId(raw: string | undefined): string | null {
  return raw !== undefined && UuidSchema.safeParse(raw).success ? raw : null;
}

// Encrypted-blob sync (PROJECT.md §4.3; ADR-0005, ADR-0008). Thin HTTP surface:
// validate, call one service method scoped to the authenticated user, map result.
// Chain order: auth → rate-limit → [validation] → handler.
export function createVaultRouter(deps: VaultRouterDeps): Router {
  const router = Router();

  router.use(deps.authenticate);
  router.use(deps.rateLimit);

  // Fresh-client bootstrap: fetch the wrapped vault key.
  router.get(
    '/vault/key',
    asyncHandler(async (_req, res) => {
      const key = await deps.vaultService.getVaultKey(sessionUserId(res));
      if (!key) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const response: VaultKeyResponse = key;
      res.json(response);
    }),
  );

  router.get(
    '/vault/items',
    asyncHandler(async (_req, res) => {
      res.json(await deps.vaultService.listItems(sessionUserId(res)));
    }),
  );

  router.post(
    '/vault/items',
    validateBody(CreateVaultItemRequestSchema),
    asyncHandler(async (_req, res) => {
      const body = res.locals.body as CreateVaultItemRequest;
      const result = await deps.vaultService.createItem(sessionUserId(res), body);
      if (!result.ok) {
        res.status(409).json({ error: 'conflict' });
        return;
      }
      const response: VaultMutationResponse = {
        id: body.id,
        revision: result.revision,
        updatedAt: result.updatedAt,
      };
      res.status(201).json(response);
    }),
  );

  router.get(
    '/vault/items/:id',
    asyncHandler(async (req, res) => {
      const id = itemId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const item = await deps.vaultService.getItem(sessionUserId(res), id);
      if (!item) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(item);
    }),
  );

  router.put(
    '/vault/items/:id',
    validateBody(UpdateVaultItemRequestSchema),
    asyncHandler(async (req, res) => {
      const id = itemId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = res.locals.body as UpdateVaultItemRequest;
      const result = await deps.vaultService.updateItem(sessionUserId(res), id, body);
      if (!result.ok) {
        res.status(result.reason === 'conflict' ? 409 : 404).json({
          error: result.reason === 'conflict' ? 'revision_conflict' : 'not_found',
        });
        return;
      }
      const response: VaultMutationResponse = {
        id,
        revision: result.revision,
        updatedAt: result.updatedAt,
      };
      res.json(response);
    }),
  );

  router.delete(
    '/vault/items/:id',
    asyncHandler(async (req, res) => {
      const id = itemId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const deleted = await deps.vaultService.deleteItem(sessionUserId(res), id);
      if (!deleted) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.status(204).send();
    }),
  );

  return router;
}
