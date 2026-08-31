import { db } from '../firestore.js';

// Read access to transactions for the layered code.
//
// The monolithic routes in server.js still use req.transactionsRef directly.
// This does not replace them — it exists so business services can read
// transactions without reaching for `req`, and it is the seam the personal
// routes migrate through whenever they are next touched.

function scope(ctx) {
  // Future multi-account form:
  //   .collection('accounts').doc(ctx.accountId).collection('transactions')
  return db.collection('users').doc(ctx.uid).collection('transactions');
}

const toModel = (doc) => ({ id: doc.id, ...doc.data() });

export const transactionRepo = {
  // Range query on the ISO date string. Single-field, so no composite index
  // is needed and nothing has to be deployed. '-32' is a safe upper bound:
  // it sorts after every real day in the month and before the next month.
  async listInPeriod(ctx, period) {
    const snapshot = await scope(ctx)
      .where('date', '>=', `${period}-01`)
      .where('date', '<', `${period}-32`)
      .get();
    return snapshot.docs.map(toModel);
  }
};
