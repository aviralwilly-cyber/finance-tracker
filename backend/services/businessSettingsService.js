import {
  normalizeBusinessSettings,
  structureOptions,
  provinceOptions,
  defaultBusinessSettings
} from '../domain/business/settings.js';
import { resolveTaxProfile } from '../domain/business/rates.js';

// Business settings use cases. Same shape as invoiceService: takes its
// repository as an argument, takes ctx rather than req, throws typed errors
// instead of setting status codes.

export function createBusinessSettingsService({ repo }) {
  const present = (profile) => {
    const defaults = defaultBusinessSettings();
    return {
      businessName: profile.businessName ?? defaults.businessName,
      businessStructure: profile.businessStructure ?? defaults.businessStructure,
      // Resolved rather than raw, so the UI always receives a complete object
      // and never has to reproduce the defaulting logic itself.
      taxProfile: resolveTaxProfile(profile.taxProfile || {}),
      // Sent alongside the values so the form builds its structure choices
      // from the registry, including the ones it must show as unavailable.
      structureOptions: structureOptions(),
      provinceOptions: provinceOptions()
    };
  };

  return {
    async get(ctx) {
      return present(await repo.get(ctx));
    },

    async update(ctx, input, today) {
      const patch = normalizeBusinessSettings(input, { today });
      return present(await repo.save(ctx, patch));
    }
  };
}
