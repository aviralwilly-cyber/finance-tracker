import { round2 } from './deductions.js';

// The only place legal structure changes the math.
//
// Everything else in this module — rollups, deductions, GST/QST — is
// identical for a sole proprietor and a corporation. Two things are not:
// how income tax is reserved, and whether money taken by the owner is a
// deductible expense. Isolating exactly those two here is what keeps
// "support corporations later" from meaning "rewrite the module".

const soleProp = {
  id: 'soleProp',
  label: 'Sole proprietor',

  // Business profit flows onto the owner's personal return, so the reserve
  // is a share of net profit at the owner's own marginal rate. That rate
  // depends on their total personal income — which this app does not know
  // and should not guess — so it comes from the tax profile as a setting.
  incomeTaxReserve(netProfit, taxProfile) {
    if (netProfit <= 0) return 0;
    return round2((netProfit * taxProfile.incomeTaxReservePercent) / 100);
  },

  // A draw is a transfer of already-taxed profit, not a business cost.
  // Counting it as an expense would understate profit and under-reserve tax
  // — the single most common bookkeeping error freelancers make.
  ownerPayIsDeductible: false,
  ownerPayLabel: 'Owner draw'
};

const corporation = {
  id: 'corporation',
  label: 'Incorporated',
  incomeTaxReserve() {
    throw new Error(
      'Corporate tax reserve is not implemented. It needs a corporate rate, ' +
      'a fiscal year end that is not necessarily December, and a split ' +
      'between salary and dividends before it can be computed honestly.'
    );
  },
  // Salary is deductible to the company (dividends are not) — which is why
  // this cannot share the sole-prop path even once the reserve exists.
  ownerPayIsDeductible: true,
  ownerPayLabel: 'Owner salary'
};

export const STRUCTURES = { soleProp, corporation };

export const IMPLEMENTED_STRUCTURES = ['soleProp'];

export function structureFor(id) {
  const structure = STRUCTURES[id];
  if (!structure) throw new Error(`Unknown business structure: ${id}`);
  return structure;
}

export function isImplemented(id) {
  return IMPLEMENTED_STRUCTURES.includes(id);
}
