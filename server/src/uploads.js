/**
 * In-flight presigned uploads.
 *
 * The signed PUT is the one place where bytes move without a bearer token, and
 * it is the one place where two requests can be inside the same blob key at the
 * same time. Two things go wrong without a registry:
 *
 *   1. `complete` stats the key, sees the previous upload's bytes, certifies
 *      them and pushes — while a second PUT is still streaming and eventually
 *      renames different bytes over the top. The declared-size check is then
 *      worth nothing: 5 bytes are verified and 21 arbitrary bytes are served.
 *   2. Two concurrent PUTs to the same key race each other's temp file and
 *      rename, and whatever lands is neither request's body in full.
 *
 * This process owns the SQLite file and the SSE hub outright — there is no
 * second node — so a process-local registry is exactly the right granularity.
 */

export function createUploadRegistry() {
  /** @type {Map<string, {startedAt:number}>} */
  const inflight = new Map();

  return {
    /** Is a PUT to this blob key streaming right now? */
    isBusy(key) {
      return inflight.has(key);
    },

    /**
     * Claim a key for the duration of one PUT.
     * @returns {(() => void)|null} a release function, or null if already held
     */
    begin(key) {
      if (inflight.has(key)) return null;
      inflight.set(key, { startedAt: Date.now() });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inflight.delete(key);
      };
    },

    get size() {
      return inflight.size;
    },
  };
}

export default createUploadRegistry;
