import { ValidationError } from '../errors.js';
import { STRUCTURES, isImplemented } from './structures.js';
import { DEFAULT_TAX_PROFILE, PROVINCES, PROVINCE_LABELS, componentsFor, DEFAULT_PROVINCE } from './rates.js';

// Validation for the business configuration a user can actually edit.
//
// Pure: takes raw input, returns a storable object or throws. Knows nothing
// about Firestore, Express, or where the settings came from.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// What the settings endpoint exposes so the UI builds its options from the
// registry rather than hardcoding a list that drifts out of sync.
export function structureOptions() {
  return Object.values(STRUCTURES).map(s => ({
    id: s.id,
    label: s.label,
    available: isImplemented(s.id),
    ownerPayLabel: s.ownerPayLabel
  }));
}

// Province drives which sales taxes apply. The table lives in rates.js so
// there is exactly one place to correct when a rate changes.
export function provinceOptions() {
  return PROVINCES.map(code => ({
    code,
    label: PROVINCE_LABELS[code],
    components: componentsFor(code).map(c => ({ code: c.code, rate: c.rate, recoverable: c.recoverable }))
  }));
}

export function defaultBusinessSettings() {
  return {
    businessName: '',
    province: DEFAULT_PROVINCE,
    businessStructure: 'soleProp',
    taxProfile: { ...DEFAULT_TAX_PROFILE }
  };
}

function validatePercent(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number`);
  if (n < 0 || n > 100) throw new ValidationError(`${field} must be between 0 and 100`);
  return Math.round(n * 100) / 100;
}

// Returns only the fields the caller actually sent, so a partial save cannot
// silently reset a field the form did not include.
export function normalizeBusinessSettings(input = {}, { today } = {}) {
  const patch = {};

  if (input.businessName !== undefined) {
    const name = String(input.businessName).trim();
    if (name.length > 120) throw new ValidationError('businessName must be 120 characters or fewer');
    patch.businessName = name;
  }

  if (input.province !== undefined) {
    if (!PROVINCES.includes(input.province)) {
      throw new ValidationError('province must be a valid two-letter code');
    }
    // Stored on the taxProfile, because it is what every tax calculation
    // reads and ctx already carries the resolved profile.
    patch.taxProfile = { ...(patch.taxProfile || {}), province: input.province };
  }

  if (input.businessStructure !== undefined) {
    const id = input.businessStructure;
    if (!STRUCTURES[id]) {
      throw new ValidationError(
        `businessStructure must be one of: ${Object.keys(STRUCTURES).join(', ')}`
      );
    }
    // Refuses rather than accepting a value the math cannot honour. Storing
    // 'corporation' would make every tax figure throw at read time, which is
    // a far worse failure than a clear 400 here.
    if (!isImplemented(id)) {
      throw new ValidationError(
        `${STRUCTURES[id].label} accounts are not supported yet. Corporate tax needs a ` +
        'corporate rate, a fiscal year end, and a salary/dividend split before it can be ' +
        'computed honestly.',
        { businessStructure: id, available: false }
      );
    }
    patch.businessStructure = id;
  }

  if (input.taxProfile !== undefined) {
    const tp = input.taxProfile || {};
    const taxProfile = {};

    if (tp.salesTaxRegistered !== undefined) {
      if (typeof tp.salesTaxRegistered !== 'boolean') {
        throw new ValidationError('salesTaxRegistered must be true or false');
      }
      taxProfile.salesTaxRegistered = tp.salesTaxRegistered;
    }

    if (tp.salesTaxRegisteredSince !== undefined) {
      const since = tp.salesTaxRegisteredSince;
      if (since === null || since === '') {
        taxProfile.salesTaxRegisteredSince = null;
      } else if (!ISO_DATE.test(since) || Number.isNaN(Date.parse(since))) {
        throw new ValidationError('salesTaxRegisteredSince must be a date in YYYY-MM-DD format');
      } else {
        taxProfile.salesTaxRegisteredSince = since;
      }
    }

    // Registering without saying when leaves every past invoice ambiguous, so
    // default to today rather than storing null and silently treating the
    // registration as retroactive to the beginning of time.
    if (taxProfile.salesTaxRegistered === true
        && taxProfile.salesTaxRegisteredSince === undefined
        && today) {
      taxProfile.salesTaxRegisteredSince = today;
    }

    if (tp.incomeTaxReservePercent !== undefined) {
      taxProfile.incomeTaxReservePercent =
        validatePercent(tp.incomeTaxReservePercent, 'incomeTaxReservePercent');
    }

    if (Object.keys(taxProfile).length > 0) patch.taxProfile = taxProfile;
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('No recognised settings were provided');
  }

  return patch;
}
