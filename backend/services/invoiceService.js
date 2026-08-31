import { normalizeInvoice, withStatus } from '../domain/business/invoices.js';
import { receivablesAging } from '../domain/business/receivables.js';
import { resolveTaxProfile } from '../domain/business/rates.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';

// Invoice use cases.
//
// Takes its repository as an argument rather than importing one. That single
// choice is what makes every function here testable against a plain in-memory
// object — no Firestore, no emulator, no network — and it is the pattern
// every service after this one should copy.
//
// Note what is absent: `req`, `res`, `db`, and any status code. The service
// signals failure by throwing typed errors; translating those into HTTP is
// the route layer's job alone.

export function createInvoiceService({ repo }) {
  const profileOf = (ctx) => resolveTaxProfile(ctx.taxProfile || {});

  return {
    async list(ctx, { today, status } = {}) {
      if (!today) throw new ValidationError('today is required');
      const invoices = (await repo.list(ctx)).map(inv => withStatus(inv, today));
      if (!status) return invoices;
      return invoices.filter(inv => inv.status === status);
    },

    async get(ctx, id, today) {
      const invoice = await repo.get(ctx, id);
      if (!invoice) throw new NotFoundError('Invoice not found');
      return withStatus(invoice, today);
    },

    async create(ctx, input, today) {
      const invoice = normalizeInvoice(input, profileOf(ctx));
      const saved = await repo.create(ctx, invoice);
      return withStatus(saved, today);
    },

    // Recording payment is its own use case rather than a general update.
    // paidDate is what the cash-basis overview keys on, so letting it be set
    // through a generic PATCH alongside other fields makes the one field
    // that changes reported revenue easy to modify by accident.
    async markPaid(ctx, id, paidDate, today) {
      const existing = await repo.get(ctx, id);
      if (!existing) throw new NotFoundError('Invoice not found');

      const normalized = normalizeInvoice(
        { ...existing, paidDate: paidDate || today },
        profileOf(ctx)
      );
      const updated = await repo.update(ctx, id, { paidDate: normalized.paidDate });
      return withStatus(updated, today);
    },

    // A full re-validate rather than a field merge: an invoice's tax depends
    // on its subtotal AND its issue date, so changing either has to recompute
    // the rest. Patching one field in isolation would leave tax that no
    // longer matches the amount it was calculated from.
    async update(ctx, id, input, today) {
      const existing = await repo.get(ctx, id);
      if (!existing) throw new NotFoundError('Invoice not found');

      // Computed fields are stripped before merging. Carrying the stored
      // taxCollected forward would make normalizeInvoice treat it as an
      // explicit override and keep the OLD tax against the NEW subtotal —
      // an edit that silently produces an invoice whose tax doesn't match
      // its own amount. They come back only if the caller sends them.
      const { taxCollected, taxTotal, total, ...editable } = existing;
      const merged = { ...editable, ...input };
      const invoice = normalizeInvoice(merged, profileOf(ctx));
      const updated = await repo.update(ctx, id, invoice);
      return withStatus(updated, today);
    },

    // Undo for a payment recorded by mistake. Separate from update() for the
    // same reason markPaid is: paidDate decides which period the revenue
    // lands in, so clearing it should be a deliberate act.
    async unmarkPaid(ctx, id, today) {
      const existing = await repo.get(ctx, id);
      if (!existing) throw new NotFoundError('Invoice not found');
      const updated = await repo.update(ctx, id, { paidDate: null });
      return withStatus(updated, today);
    },

    async remove(ctx, id) {
      const existing = await repo.get(ctx, id);
      if (!existing) throw new NotFoundError('Invoice not found');
      await repo.remove(ctx, id);
    },

    // Feeds the receivables card. The aging math lives in the domain layer;
    // this only fetches and hands it over.
    async receivables(ctx, today) {
      if (!today) throw new ValidationError('today is required');
      return receivablesAging(await repo.list(ctx), today);
    },

    // What buildOverview() consumes. Exposed so the overview service can get
    // revenue records without reaching into the repository itself.
    async revenueRecords(ctx) {
      return repo.list(ctx);
    }
  };
}
