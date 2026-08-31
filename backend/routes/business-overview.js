import express from 'express';
import { isDomainError } from '../domain/errors.js';

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export function createBusinessOverviewRouter({ requireAuth, requireCapability, service }) {
  const router = express.Router();

  router.use(requireAuth, requireCapability('business-overview'));

  router.get('/', asyncRoute(async (req, res) => {
    const today = todayIso();
    res.json(await service.get(req.ctx, {
      // Defaults to the current month, and to cash basis — what is actually
      // in the bank, which is the question a freelancer is asking.
      period: req.query.period || today.slice(0, 7),
      basis: req.query.basis || 'cash',
      today
    }));
  }));

  router.use((err, req, res, next) => {
    if (isDomainError(err)) {
      return res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    }
    console.error('Business overview route error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}
