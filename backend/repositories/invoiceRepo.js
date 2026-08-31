import { db } from '../firestore.js';

// The only place invoice data meets Firestore.
//
// Two rules make the layering hold:
//
// 1. Nothing above this file imports `db`. Services take a repo; routes take
//    a service. That is what lets invoiceService be tested against a plain
//    object with no emulator and no network.
//
// 2. The collection path is built from `ctx`, never from a raw uid. Today
//    ctx.accountId is always 'default' and the path ignores it. When one
//    login needs to hold both a personal and a business set of books, the
//    `scope` function below is the only thing that changes — every query in
//    the app goes through it.

function scope(ctx) {
  // Future multi-account form:
  //   .collection('accounts').doc(ctx.accountId).collection('invoices')
  return db.collection('users').doc(ctx.uid).collection('invoices');
}

const toModel = (doc) => ({ id: doc.id, ...doc.data() });

export const invoiceRepo = {
  async list(ctx) {
    // Ordered newest-first by issue date. Sorting on a single field within a
    // subcollection needs no composite index, so this stays deploy-free.
    const snapshot = await scope(ctx).orderBy('issuedDate', 'desc').get();
    return snapshot.docs.map(toModel);
  },

  async get(ctx, id) {
    const doc = await scope(ctx).doc(id).get();
    return doc.exists ? toModel(doc) : null;
  },

  async create(ctx, invoice) {
    const ref = await scope(ctx).add(invoice);
    return { id: ref.id, ...invoice };
  },

  async update(ctx, id, patch) {
    await scope(ctx).doc(id).update(patch);
    return this.get(ctx, id);
  },

  async remove(ctx, id) {
    await scope(ctx).doc(id).delete();
  }
};
