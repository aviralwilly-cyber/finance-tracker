// Typed errors so the layers can talk about failure without coupling.
//
// The domain and service layers know *what* went wrong; only the route layer
// knows that "wrong input" means HTTP 400. Throwing these lets a service stay
// free of Express while still letting a route map the failure precisely —
// the alternative is routes matching on error message strings, which breaks
// the moment someone rewords a message.

export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

// True for errors this app raised deliberately. Anything else is a bug or an
// infrastructure failure and must not have its message shown to the user —
// a Firestore stack trace in a 500 body is an information leak.
export function isDomainError(err) {
  return err instanceof ValidationError || err instanceof NotFoundError;
}
