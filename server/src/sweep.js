/**
 * Expiry sweep.
 *
 * Expiry deletes *bytes*, never history: the transfer row survives with
 * state='expired' and its blob_key cleared (ARCHITECTURE.md §7 — "expiry only
 * ever deletes bytes, never the archive"). Runs once on boot and then on an
 * interval.
 */
import { nowIso } from './db.js';

/**
 * @param {{db:import('./db.js').Db, storage:any}} ctx
 * @returns {Promise<{expired:number, blobsDeleted:number}>}
 */
export async function runSweep(ctx, { asOf = nowIso(), quiet = false } = {}) {
  const { db, storage } = ctx;
  const due = db.findExpirable(asOf);
  let blobsDeleted = 0;

  for (const row of due) {
    if (row.blob_key) {
      try {
        await storage.delete(row.blob_key);
        blobsDeleted += 1;
      } catch (err) {
        console.warn(`[transmat] sweep: could not delete blob ${row.blob_key}: ${err.message}`);
      }
    }
    db.setTransferState(row.id, 'expired', row.blob_key);
  }

  if (due.length && !quiet) {
    console.log(
      `[transmat] sweep: expired ${due.length} transfer(s), deleted ${blobsDeleted} blob(s)`,
    );
  }
  return { expired: due.length, blobsDeleted };
}

/**
 * Run once immediately, then every `intervalMs`.
 * @returns {{stop:()=>void, firstRun:Promise<any>}}
 */
export function startSweep(ctx, { intervalMs = 60_000, quiet = false } = {}) {
  let stopped = false;
  const tick = () =>
    runSweep(ctx, { quiet }).catch((err) => console.error('[transmat] sweep failed:', err));

  const firstRun = tick();
  const timer = setInterval(() => {
    if (!stopped) tick();
  }, intervalMs);
  timer.unref?.(); // the sweep must never be the reason the process stays up

  return {
    firstRun,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export default startSweep;
