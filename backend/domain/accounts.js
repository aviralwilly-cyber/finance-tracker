// Account type → what that account can do.
//
// This is the file that stops `if (accountType === 'business')` from spreading
// through ninety route handlers. Features ask "does this account have the
// invoices capability", never "is this a business account". When a third type
// eventually appears, it declares a capability list here and nothing else in
// the codebase needs to know it exists.
//
// Same contract as lib.js and domain/business: pure input → output, no
// Firestore, no Express, no Groq.

export const ACCOUNT_TYPES = ['personal', 'business'];

export const DEFAULT_ACCOUNT_TYPE = 'personal';

// Present for both types. Note that sharing a capability does NOT mean
// sharing an implementation — 'overview' exists on both sides but resolves
// to completely different math, because a freelancer has no "monthly income
// in effect on a date". The capability says the feature is reachable; the
// policy decides what it computes.
const SHARED = [
  'overview',
  'transactions',
  'recurring',
  'import',
  'receipts',
  'chat',
  'analyze',
  'settings',
  'help'
];

export const CAPABILITIES = {
  personal: [
    ...SHARED,
    // A configured, repeating monthly income. Business revenue is a series of
    // discrete invoices instead, so this concept genuinely does not exist on
    // that side — it is not just a different view of the same thing.
    'income',
    'budgets',
    'savings',
    'household',
    'predict',
    'health-score'
  ],
  business: [
    ...SHARED,
    'invoices',
    // 'clients' deliberately absent until something implements it. A
    // capability the sidebar can render but no route can answer is worse
    // than a missing feature — it looks like a bug rather than a gap.
    'receivables',
    'tax-summary',
    'business-settings',
    'business-overview'
  ]
};

// Anything unrecognised — including undefined, which is every profile created
// before business accounts existed — resolves to personal. That default is
// what makes this shippable with no backfill and no migration.
export function normalizeAccountType(value) {
  return ACCOUNT_TYPES.includes(value) ? value : DEFAULT_ACCOUNT_TYPE;
}

// Returns a fresh array each call: this list gets serialized into an API
// response, and handing out the module's own array invites a caller to sort
// or push on it and silently change every subsequent request.
export function capabilitiesFor(accountType) {
  return [...CAPABILITIES[normalizeAccountType(accountType)]];
}

export function hasCapability(accountType, capability) {
  return CAPABILITIES[normalizeAccountType(accountType)].includes(capability);
}
