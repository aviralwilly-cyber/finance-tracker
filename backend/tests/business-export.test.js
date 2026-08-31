import { describe, it, expect, beforeEach } from 'vitest';
import { invoicesToCsv, expensesToCsv } from '../domain/business/exportCsv.js';
import { createInvoiceService } from '../services/invoiceService.js';
import { resolveTaxProfile } from '../domain/business/rates.js';
import { chatPersona, analystPersona } from '../domain/prompts.js';

const ON = resolveTaxProfile({ province: 'ON', salesTaxRegistered: true, incomeTaxReservePercent: 30 });
const TODAY = '2026-08-29';

describe('invoicesToCsv', () => {
  const invoices = [
    {
      issuedDate: '2026-08-01', dueDate: '2026-08-31', paidDate: null,
      clientName: 'Acme', notes: '', subtotal: 4000,
      taxCollected: { HST: 520 }, total: 4520
    },
    {
      issuedDate: '2026-07-01', dueDate: '2026-07-31', paidDate: '2026-07-15',
      clientName: 'Globex', notes: 'Retainer', subtotal: 1000,
      taxCollected: { HST: 130 }, total: 1130
    }
  ];

  it('builds one column per tax component present', () => {
    const [header] = invoicesToCsv(invoices, TODAY).split('\r\n');
    expect(header).toContain('HST collected');
    expect(header).not.toContain('GST collected');
  });

  it('includes derived status rather than making the reader work it out', () => {
    const rows = invoicesToCsv(invoices, TODAY).split('\r\n');
    expect(rows[1]).toContain('outstanding');
    expect(rows[2]).toContain('paid');
  });

  // A client called "Acme, Inc." would otherwise shift every later column by
  // one, silently corrupting the whole sheet.
  it('quotes fields containing commas', () => {
    const csv = invoicesToCsv(
      [{ ...invoices[0], clientName: 'Acme, Inc.' }], TODAY
    );
    expect(csv).toContain('"Acme, Inc."');
  });

  it('escapes embedded quotes by doubling them', () => {
    const csv = invoicesToCsv([{ ...invoices[0], notes: 'Re: "phase 2"' }], TODAY);
    expect(csv).toContain('"Re: ""phase 2"""');
  });

  it('handles an account with no invoices', () => {
    expect(invoicesToCsv([], TODAY).split('\r\n')).toHaveLength(1); // header only
  });
});

describe('expensesToCsv', () => {
  const expenses = [
    {
      date: '2026-08-10', description: 'Laptop', category: 'Equipment',
      amount: 2260, taxPaid: { HST: 260 }, deductiblePercent: 60
    },
    {
      date: '2026-08-12', description: 'Client lunch', category: 'Client Meals',
      amount: 113, taxPaid: { HST: 13 }, deductiblePercent: 100
    }
  ];

  it('reports the deductible amount, not just what was spent', () => {
    const rows = expensesToCsv(expenses, ON).split('\r\n');
    // $2,260 incl. $260 HST → $2,000 pre-tax, 60% business = $1,200
    expect(rows[1]).toContain('1200');
    // $113 incl. $13 HST → $100 pre-tax, meals capped at 50% = $50
    expect(rows[2]).toContain('50');
  });

  it('applies the meals cap to the recoverable tax too', () => {
    const rows = expensesToCsv(expenses, ON).split('\r\n');
    expect(rows[2]).toContain('6.5'); // half of $13
  });

  it('handles an account with no expenses', () => {
    expect(expensesToCsv([], ON).split('\r\n')).toHaveLength(1);
  });
});

describe('prompts', () => {
  it('frames a business account in business terms', () => {
    const persona = chatPersona('business');
    expect(persona).toMatch(/revenue/i);
    expect(persona).toMatch(/deductible/i);
  });

  // The failure mode this exists to prevent: telling a freelancer about their
  // savings rate and monthly budget.
  it('tells the business persona those personal concepts do not exist', () => {
    expect(chatPersona('business')).toMatch(/no salary/i);
    expect(analystPersona('business')).toMatch(/no salary|budgets/i);
  });

  it('falls back to the personal persona for an unknown type', () => {
    expect(chatPersona(undefined)).toBe(chatPersona('personal'));
    expect(analystPersona('nonsense')).toBe(analystPersona('personal'));
  });
});

function fakeRepo(seed = {}) {
  const rows = new Map(Object.entries(seed));
  let n = 1;
  return {
    async list() { return [...rows.entries()].map(([id, d]) => ({ id, ...d })); },
    async get(_c, id) { return rows.has(id) ? { id, ...rows.get(id) } : null; },
    async create(_c, inv) { const id = `i${n++}`; rows.set(id, { ...inv }); return { id, ...inv }; },
    async update(_c, id, patch) { rows.set(id, { ...rows.get(id), ...patch }); return { id, ...rows.get(id) }; },
    async remove(_c, id) { rows.delete(id); }
  };
}

const CTX = { uid: 'u1', accountId: 'default', accountType: 'business', taxProfile: ON };

describe('invoiceService.update', () => {
  let service;
  beforeEach(() => { service = createInvoiceService({ repo: fakeRepo() }); });

  it('recomputes tax when the subtotal changes', async () => {
    const created = await service.create(
      CTX, { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-01' }, TODAY
    );
    expect(created.total).toBe(1130);

    const updated = await service.update(CTX, created.id, { subtotal: 2000 }, TODAY);
    expect(updated.taxCollected.HST).toBe(260);
    expect(updated.total).toBe(2260);
  });

  it('keeps fields the caller did not send', async () => {
    const created = await service.create(
      CTX, { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-01', notes: 'Phase 1' }, TODAY
    );
    const updated = await service.update(CTX, created.id, { subtotal: 1500 }, TODAY);
    expect(updated.clientName).toBe('Acme');
    expect(updated.notes).toBe('Phase 1');
  });

  it('validates the merged result, not just the new fields', async () => {
    const created = await service.create(
      CTX, { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-10' }, TODAY
    );
    await expect(service.update(CTX, created.id, { dueDate: '2026-08-01' }, TODAY))
      .rejects.toThrow(/dueDate cannot be before issuedDate/);
  });

  it('throws NotFound for a missing invoice', async () => {
    await expect(service.update(CTX, 'nope', { subtotal: 1 }, TODAY)).rejects.toThrow(/not found/i);
  });
});

describe('invoiceService.unmarkPaid', () => {
  it('clears the payment and returns the invoice to outstanding', async () => {
    const service = createInvoiceService({ repo: fakeRepo() });
    const created = await service.create(
      CTX, { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-08-01', dueDate: '2026-09-30' }, TODAY
    );
    const paid = await service.markPaid(CTX, created.id, '2026-08-20', TODAY);
    expect(paid.status).toBe('paid');

    const reverted = await service.unmarkPaid(CTX, created.id, TODAY);
    expect(reverted.paidDate).toBeNull();
    expect(reverted.status).toBe('outstanding');
  });

  it('throws NotFound for a missing invoice', async () => {
    const service = createInvoiceService({ repo: fakeRepo() });
    await expect(service.unmarkPaid(CTX, 'nope', TODAY)).rejects.toThrow(/not found/i);
  });
});
