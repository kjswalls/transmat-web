/**
 * Exit codes and the one error type the whole CLI throws.
 *
 * Every failure path funnels through CliError so `main()` can print one clean
 * line (plus an optional hint) and exit with a code a shell script can branch
 * on. Nothing else is allowed to call process.exit().
 */

export const EXIT = {
  OK: 0,
  /** Something went wrong that doesn't fit a more specific bucket. */
  ERROR: 1,
  /** Bad command line: unknown flag, missing argument, unknown command. */
  USAGE: 2,
  /** Not logged in, or logged in but not registered as a device. */
  NO_CONFIG: 3,
  /** Server said 401 — the token is wrong or was rotated. */
  AUTH: 4,
  /** Could not reach the server at all. */
  NETWORK: 5,
  /** Server said 404 / 410 — the thing you named isn't there. */
  NOT_FOUND: 6,
};

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.exitCode]
   * @param {string} [options.hint] a second line telling the user what to do
   * @param {string} [options.code] machine-readable code (contract codes when from the API)
   * @param {unknown} [options.cause]
   */
  constructor(message, { exitCode = EXIT.ERROR, hint, code, cause } = {}) {
    super(message, { cause });
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
    this.code = code;
  }
}

/** HTTP-status → exit-code mapping, shared by every API call. */
export function exitCodeForStatus(status) {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404 || status === 410) return EXIT.NOT_FOUND;
  return EXIT.ERROR;
}

export function usage(message, hint) {
  return new CliError(message, { exitCode: EXIT.USAGE, hint });
}
