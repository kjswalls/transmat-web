/**
 * The contract's error envelope: always `{error: {code, message}}` with a
 * matching status. Throw an AppError anywhere; app.onError renders it.
 */

/** code -> HTTP status, exactly as frozen in docs/CONTRACT.md. */
export const ERROR_STATUS = {
  unauthorized: 401,
  not_found: 404,
  no_targets: 400,
  bad_request: 400,
  too_large: 413,
  expired: 410,
  revoked: 410,
  signature_invalid: 403,
  internal: 500,
};

export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_STATUS} code
   * @param {string} message
   * @param {number} [status] override (defaults to the code's status)
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code] ?? 500;
  }
}

export const badRequest = (msg) => new AppError('bad_request', msg);
export const notFound = (msg = 'not found') => new AppError('not_found', msg);
export const unauthorized = (msg = 'missing or invalid bearer token') =>
  new AppError('unauthorized', msg);
export const tooLarge = (msg) => new AppError('too_large', msg);
export const noTargets = (msg = 'no devices matched the requested targets') =>
  new AppError('no_targets', msg);

/** @param {import('hono').Context} c */
export function renderError(err, c) {
  const appErr =
    err instanceof AppError
      ? err
      : new AppError('internal', err?.message ? String(err.message) : 'internal error');
  if (appErr.code === 'internal') {
    console.error('[transmat] unhandled error:', err);
  }
  return c.json({ error: { code: appErr.code, message: appErr.message } }, appErr.status);
}
