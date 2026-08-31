import express from 'express';
import { isDomainError } from '../domain/errors.js';

// HTTP only. Every handler here does the same four things: read input off the
// request, call one service method, send a status code, and nothing else.
// If a calculation or a Firestore query ever appears in this file, the
// layering has failed.
//
// Middleware is injected rather than imported so this file has no dependency
// on server.js — which is what keeps the direction of imports one-way.

// Express 4 does not catch rejected promises from async handlers: an
// unhandled rejection there hangs the request until the client times out.
// Several routes in the existing server.js have this bug. Everything new
// goes through this wrapper.
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// Today comes from the server rather than the client, so a wrong device clock
// (or a client that sends whatever it likes) cannot make overdue invoices
// look current.
const today = () => new Date().toISOString().slice(0, 10);

export function createInvoiceRouter({ requireAuth, requireCapability, service }) {
  const router = express.Router();

  router.use(requireAuth, requireCapability('invoices'));

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await service.list(req.ctx, { today: today(), status: req.query.status }));
  }));

  router.get('/receivables', asyncRoute(async (req, res) => {
    res.json(await service.receivables(req.ctx, today()));
  }));

  // Registered after /receivables so that literal path is not swallowed by
  // the :id parameter.
  router.get('/:id', asyncRoute(async (req, res) => {
    res.json(await service.get(req.ctx, req.params.id, today()));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    res.status(201).json(await service.create(req.ctx, req.body, today()));
  }));

  router.patch('/:id', asyncRoute(async (req, res) => {
    res.json(await service.update(req.ctx, req.params.id, req.body, today()));
  }));

  router.post('/:id/paid', asyncRoute(async (req, res) => {
    res.json(await service.markPaid(req.ctx, req.params.id, req.body?.paidDate, today()));
  }));

  router.delete('/:id/paid', asyncRoute(async (req, res) => {
    res.json(await service.unmarkPaid(req.ctx, req.params.id, today()));
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    await service.remove(req.ctx, req.params.id);
    res.status(204).end();
  }));

  // Router-scoped error handling. Deliberate failures carry their own status
  // and a message meant for the user; anything else is a bug or an outage and
  // gets a generic 500, because a raw Firestore error in a response body
  // leaks internals.
  router.use((err, req, res, next) => {
    if (isDomainError(err)) {
      return res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    }
    console.error('Invoice route error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}
