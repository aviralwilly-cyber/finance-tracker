// Sales tax as a per-province list of components, not a pair of hardcoded
// rates.
//
// The shape differs by province, not just the number:
//   - HST provinces have ONE tax, filed with CRA.
//   - Quebec has TWO, filed with two different agencies.
//   - BC/SK/MB have GST plus a provincial tax that is NOT recoverable
//     through input credits at all.
//
// That last one is why `recoverable` is a field rather than an assumption.
// PST is a hard cost to a business: it cannot be claimed back, so it stays
// inside the deductible base. A two-field GST/QST model had nowhere to put
// that fact and would have silently overstated credits the first time a BC
// purchase appeared.
//
// Rates verified against CRA/provincial references, August 2026. They change
// by legislation — Nova Scotia moved 15% → 14% in April 2025 — so treat this
// table as something to re-check, not as settled truth.

const GST = { code: 'GST', label: 'GST', rate: 0.05, recoverable: true };

export const PROVINCE_TAXES = {
  AB: [GST],
  BC: [GST, { code: 'PST', label: 'PST', rate: 0.07, recoverable: false }],
  MB: [GST, { code: 'PST', label: 'RST', rate: 0.07, recoverable: false }],
  NB: [{ code: 'HST', label: 'HST', rate: 0.15, recoverable: true }],
  NL: [{ code: 'HST', label: 'HST', rate: 0.15, recoverable: true }],
  NS: [{ code: 'HST', label: 'HST', rate: 0.14, recoverable: true }],
  NT: [GST],
  NU: [GST],
  ON: [{ code: 'HST', label: 'HST', rate: 0.13, recoverable: true }],
  PE: [{ code: 'HST', label: 'HST', rate: 0.15, recoverable: true }],
  // QST is levied on the price EXCLUDING GST — Quebec stopped compounding the
  // two in 2013. Every rate here is applied to the same pre-tax base, which
  // makes that rule the default rather than a special case.
  QC: [GST, { code: 'QST', label: 'QST', rate: 0.09975, recoverable: true }],
  SK: [GST, { code: 'PST', label: 'PST', rate: 0.06, recoverable: false }],
  YT: [GST]
};

export const DEFAULT_PROVINCE = 'ON';

export const PROVINCE_LABELS = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon'
};

export const PROVINCES = Object.keys(PROVINCE_TAXES).sort();

export function componentsFor(province) {
  return (PROVINCE_TAXES[province] || PROVINCE_TAXES[DEFAULT_PROVINCE]).map(c => ({ ...c }));
}

export function isKnownProvince(code) {
  return Object.prototype.hasOwnProperty.call(PROVINCE_TAXES, code);
}

// Rule of thumb only — a freelancer setting aside ~30% of net profit for
// income tax is common advice, not a computed figure. It depends on total
// personal income, which this app does not know.
export const DEFAULT_INCOME_TAX_RESERVE_PERCENT = 30;

export const DEFAULT_TAX_PROFILE = {
  province: DEFAULT_PROVINCE,
  // Registration is threshold-based ($30,000 of taxable sales over four
  // consecutive quarters) and identical for a sole prop and a corporation.
  salesTaxRegistered: false,
  salesTaxRegisteredSince: null,
  incomeTaxReservePercent: DEFAULT_INCOME_TAX_RESERVE_PERCENT
};

export function resolveTaxProfile(partial = {}) {
  const merged = { ...DEFAULT_TAX_PROFILE, ...partial };
  const province = isKnownProvince(merged.province) ? merged.province : DEFAULT_PROVINCE;
  return { ...merged, province, components: componentsFor(province) };
}

// Sales tax registration is a fact with a start date, not a permanent truth.
// An invoice issued before registering must not pick up tax because the flag
// is on today; without this, historical correctness depends on the order
// operations happened to be performed in.
export function taxProfileOn(taxProfile, date) {
  const profile = resolveTaxProfile(taxProfile);
  if (!profile.salesTaxRegistered) return profile;
  if (!profile.salesTaxRegisteredSince) return profile;
  if (date && date < profile.salesTaxRegisteredSince) {
    return { ...profile, salesTaxRegistered: false };
  }
  return profile;
}

// Legacy read path. Invoices and expenses written before this table existed
// carry gstCollected/qstCollected (or gstPaid/qstPaid) instead of a map.
// Reading them through here means old documents keep working with no
// migration and no backfill.
export function taxMapOf(record, mapField, legacyFields) {
  if (record?.[mapField] && typeof record[mapField] === 'object') {
    return record[mapField];
  }
  const map = {};
  for (const [code, field] of Object.entries(legacyFields)) {
    const value = Number(record?.[field]) || 0;
    if (value !== 0) map[code] = value;
  }
  return map;
}

export const COLLECTED_LEGACY = { GST: 'gstCollected', QST: 'qstCollected' };
export const PAID_LEGACY = { GST: 'gstPaid', QST: 'qstPaid' };
