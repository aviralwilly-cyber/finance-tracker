import express from 'express';
import { isDomainError } from '../domain/errors.js';

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const today = () => new Date().toISOString().slice(0, 10);

export function createBusinessSettingsRouter({ requireAuth, requireCapability, service }) {
  const router = express.Router();

  router.use(requireAuth, requireCapability('business-settings'));

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await service.get(req.ctx));
  }));

  // PATCH rather than PUT: the form sends only what changed, and the domain
  // layer returns a patch containing only recognised fields.
  router.patch('/', asyncRoute(async (req, res) => {
    res.json(await service.update(req.ctx, req.body, today()));
  }));

  router.use((err, req, res, next) => {
    if (isDomainError(err)) {
      return res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    }
    console.error('Business settings route error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}
