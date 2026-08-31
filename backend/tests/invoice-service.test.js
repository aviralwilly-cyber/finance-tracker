import { describe, it, expect, beforeEach } from 'vitest';
import { createInvoiceService } from '../services/invoiceService.js';
import { normalizeInvoice, statusOf } from '../domain/business/invoices.js';
import { resolveTaxProfile } from '../domain/business/rates.js';

// The point of this file: a full service test suite with no Firestore, no
// emulator, and no network. The fake below is the entire test infrastructure.
// That is only possible because invoiceService takes its repository as an
// argument instead of importing one.

function fakeRepo(seed = []) {
  let nextId = 1;
  const rows = new Map(seed.map(r => [r.id || `seed${nextId++}`, { ...r }]));
  return {
    // Exposed so assertions can inspect stored state directly.
    _rows: rows,
    async list() {
      return [...rows.entries()]
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => (a.issuedDate < b.issuedDate ? 1 : -1));
    },
    async get(_ctx, id) {
      return rows.has(id) ? { id, ...rows.get(id) } : null;
    },
    async create(_ctx, invoice) {
      const id = `inv${nextId++}`;
      rows.set(id, { ...invoice });
      return { id, ...invoice };
    },
    async update(_ctx, id, patch) {
      rows.set(id, { ...rows.get(id), ...patch });
      return { id, ...rows.get(id) };
    },
    async remove(_ctx, id) {
      rows.delete(id);
    }
  };
}

const REGISTERED_CTX = {
  uid: 'u1',
  accountId: 'default',
  accountType: 'business',
  capabilities: ['invoices'],
  taxProfile: resolveTaxProfile({ province: 'QC', salesTaxRegistered: true })
};

const TODAY = '2026-08-29';

describe('normalizeInvoice', () => {
  const profile = resolveTaxProfile({ province: 'QC', salesTaxRegistered: true });

  it('computes sales tax from the subtotal rather than trusting the client', () => {
    const inv = normalizeInvoice(
      { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-01' },
      profile
    );
    expect(inv.taxCollected.GST || 0).toBe(50);
    expect(inv.taxCollected.QST || 0).toBe(99.75);
    expect(inv.total).toBe(1149.75);
  });

  it('charges no tax for an unregistered business', () => {
    const inv = normalizeInvoice(
      { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-01' },
      resolveTaxProfile({ province: 'QC', salesTaxRegistered: false })
    );
    expect(inv.taxCollected.GST || 0).toBe(0);
    expect(inv.total).toBe(1000);
  });

  it('allows explicit tax amounts for imported historical invoices', () => {
    const inv = normalizeInvoice(
      { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-01', gstCollected: 47, qstCollected: 90 },
      profile
    );
    expect(inv.taxCollected.GST || 0).toBe(47);
    expect(inv.total).toBe(1137);
  });

  it('rejects a missing client name', () => {
    expect(() => normalizeInvoice({ subtotal: 100, issuedDate: '2026-08-01' }, profile))
      .toThrow(/clientName is required/);
  });

  it('rejects a non-positive subtotal', () => {
    expect(() => normalizeInvoice({ clientName: 'A', subtotal: 0, issuedDate: '2026-08-01' }, profile))
      .toThrow(/subtotal must be a positive number/);
  });

  it('rejects a malformed date', () => {
    expect(() => normalizeInvoice({ clientName: 'A', subtotal: 10, issuedDate: '01/08/2026' }, profile))
      .toThrow(/YYYY-MM-DD/);
  });

  it('rejects a due date before the issue date', () => {
    expect(() => normalizeInvoice(
      { clientName: 'A', subtotal: 10, issuedDate: '2026-08-10', dueDate: '2026-08-01' }, profile
    )).toThrow(/dueDate cannot be before issuedDate/);
  });
});

describe('statusOf', () => {
  it('is paid whenever a payment date exists, even past due', () => {
    expect(statusOf({ paidDate: '2026-08-20', dueDate: '2026-07-01' }, TODAY)).toBe('paid');
  });

  it('is overdue past the due date with no payment', () => {
    expect(statusOf({ paidDate: null, dueDate: '2026-08-01' }, TODAY)).toBe('overdue');
  });

  it('is outstanding before the due date', () => {
    expect(statusOf({ paidDate: null, dueDate: '2026-09-30' }, TODAY)).toBe('outstanding');
  });

  it('is outstanding, not overdue, when no due date was set', () => {
    expect(statusOf({ paidDate: null, dueDate: null }, TODAY)).toBe('outstanding');
  });
});

describe('invoiceService', () => {
  let repo;
  let service;

  beforeEach(() => {
    repo = fakeRepo();
    service = createInvoiceService({ repo });
  });

  it('creates an invoice with derived status and computed tax', async () => {
    const created = await service.create(
      REGISTERED_CTX,
      { clientName: 'Acme', subtotal: 4000, issuedDate: '2026-08-01', dueDate: '2026-08-31' },
      TODAY
    );
    expect(created.id).toBeDefined();
    expect(created.status).toBe('outstanding');
    expect(created.total).toBe(4599); // 4000 + 200 GST + 399 QST
  });

  it('rejects invalid input before it reaches the repository', async () => {
    await expect(
      service.create(REGISTERED_CTX, { subtotal: 100, issuedDate: '2026-08-01' }, TODAY)
    ).rejects.toThrow(/clientName is required/);
    expect(repo._rows.size).toBe(0);
  });

  it('filters by derived status', async () => {
    await service.create(REGISTERED_CTX, { clientName: 'A', subtotal: 100, issuedDate: '2026-06-01', dueDate: '2026-06-30' }, TODAY);
    await service.create(REGISTERED_CTX, { clientName: 'B', subtotal: 200, issuedDate: '2026-08-01', dueDate: '2026-09-30' }, TODAY);

    expect(await service.list(REGISTERED_CTX, { today: TODAY })).toHaveLength(2);
    expect(await service.list(REGISTERED_CTX, { today: TODAY, status: 'overdue' })).toHaveLength(1);
    expect(await service.list(REGISTERED_CTX, { today: TODAY, status: 'outstanding' })).toHaveLength(1);
  });

  it('records payment and flips the status', async () => {
    const created = await service.create(
      REGISTERED_CTX,
      { clientName: 'A', subtotal: 100, issuedDate: '2026-06-01', dueDate: '2026-06-30' },
      TODAY
    );
    expect(created.status).toBe('overdue');

    const paid = await service.markPaid(REGISTERED_CTX, created.id, '2026-08-15', TODAY);
    expect(paid.status).toBe('paid');
    expect(paid.paidDate).toBe('2026-08-15');
  });

  it('defaults the payment date to today when none is given', async () => {
    const created = await service.create(REGISTERED_CTX, { clientName: 'A', subtotal: 100, issuedDate: '2026-08-01' }, TODAY);
    const paid = await service.markPaid(REGISTERED_CTX, created.id, undefined, TODAY);
    expect(paid.paidDate).toBe(TODAY);
  });

  it('refuses a payment date before the invoice was issued', async () => {
    const created = await service.create(REGISTERED_CTX, { clientName: 'A', subtotal: 100, issuedDate: '2026-08-01' }, TODAY);
    await expect(service.markPaid(REGISTERED_CTX, created.id, '2026-07-01', TODAY))
      .rejects.toThrow(/paidDate cannot be before issuedDate/);
  });

  it('throws NotFound for a missing invoice', async () => {
    await expect(service.get(REGISTERED_CTX, 'nope', TODAY)).rejects.toThrow(/not found/i);
    await expect(service.markPaid(REGISTERED_CTX, 'nope', TODAY, TODAY)).rejects.toThrow(/not found/i);
    await expect(service.remove(REGISTERED_CTX, 'nope')).rejects.toThrow(/not found/i);
  });

  it('deletes an invoice', async () => {
    const created = await service.create(REGISTERED_CTX, { clientName: 'A', subtotal: 100, issuedDate: '2026-08-01' }, TODAY);
    await service.remove(REGISTERED_CTX, created.id);
    expect(repo._rows.size).toBe(0);
  });

  it('reports receivables excluding paid invoices', async () => {
    const a = await service.create(REGISTERED_CTX, { clientName: 'A', subtotal: 1000, issuedDate: '2026-05-01', dueDate: '2026-05-31' }, TODAY);
    await service.create(REGISTERED_CTX, { clientName: 'B', subtotal: 2000, issuedDate: '2026-08-01', dueDate: '2026-09-30' }, TODAY);
    await service.markPaid(REGISTERED_CTX, a.id, '2026-06-01', TODAY);

    const aging = await service.receivables(REGISTERED_CTX, TODAY);
    expect(aging.count).toBe(1);
    expect(aging.overdue).toBe(0);
    expect(aging.buckets.current.count).toBe(1);
  });

  // Nothing in the service reads a clock. If this ever fails, someone has
  // reached for Date.now() and made the tests time-dependent.
  it('derives status purely from the date it is given', async () => {
    await service.create(REGISTERED_CTX, { clientName: 'A', subtotal: 100, issuedDate: '2026-08-01', dueDate: '2026-08-15' }, TODAY);
    const before = await service.list(REGISTERED_CTX, { today: '2026-08-10' });
    const after = await service.list(REGISTERED_CTX, { today: '2026-08-20' });
    expect(before[0].status).toBe('outstanding');
    expect(after[0].status).toBe('overdue');
  });
});
