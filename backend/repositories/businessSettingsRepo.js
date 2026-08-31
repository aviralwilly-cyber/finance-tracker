import { db } from '../firestore.js';

// Business settings live as fields on the user document rather than in a
// separate doc, because requireAuth already reads that document on every
// request and puts taxProfile into req.ctx. Splitting them out would mean a
// second read per request for data that is needed on every request.
//
// Consequence worth knowing: this repository and the monolithic
// POST /api/profile route write to the same document. Both use merge/field
// writes rather than set(), so neither clobbers the other's fields.

function userDoc(ctx) {
  // Future multi-account form:
  //   .collection('accounts').doc(ctx.accountId)
  return db.collection('users').doc(ctx.uid);
}

export const businessSettingsRepo = {
  async get(ctx) {
    const doc = await userDoc(ctx).get();
    return doc.exists ? (doc.data() || {}) : {};
  },

  async save(ctx, patch) {
    // Dotted paths so a partial taxProfile update merges into the existing
    // map instead of replacing it. update({ taxProfile: {...} }) would drop
    // any key the form did not send.
    const flat = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'taxProfile' && value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) flat[`taxProfile.${k}`] = v;
      } else {
        flat[key] = value;
      }
    }
    await userDoc(ctx).set({}, { merge: true });
    await userDoc(ctx).update(flat);
    return this.get(ctx);
  }
};
