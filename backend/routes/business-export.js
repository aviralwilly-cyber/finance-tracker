import express from 'express';
import { isDomainError } from '../domain/errors.js';
import { invoicesToCsv, expensesToCsv } from '../domain/business/exportCsv.js';

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function createBusinessExportRouter({ requireAuth, requireCapability, invoiceRepo, transactionRepo }) {
  const router = express.Router();
  router.use(requireAuth, requireCapability('business-overview'));

  // Two separate files rather than one merged sheet: invoices and expenses
  // have genuinely different columns, and cramming both into one table means
  // half the cells are blank in every row.
  router.get('/invoices.csv', asyncRoute(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const csv = invoicesToCsv(await invoiceRepo.list(req.ctx), today);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.send(csv);
  }));

  router.get('/expenses.csv', asyncRoute(async (req, res) => {
    // Defaults to the current year, since that is the span an accountant
    // asks for. A period narrows it to one month.
    const period = req.query.period || null;
    const months = period
      ? [period]
      : Array.from({ length: 12 }, (_, i) => `${new Date().getFullYear()}-${String(i + 1).padStart(2, '0')}`);

    const batches = await Promise.all(months.map(m => transactionRepo.listInPeriod(req.ctx, m)));
    const expenses = batches.flat().sort((a, b) => (a.date < b.date ? -1 : 1));

    const csv = expensesToCsv(expenses, req.ctx.taxProfile);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(csv);
  }));

  router.use((err, req, res, next) => {
    if (isDomainError(err)) return res.status(err.status).json({ error: err.message });
    console.error('Business export route error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}
