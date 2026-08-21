/**
 * Expiry sweep.
 *
 * Expiry deletes *bytes*, never history: the transfer row survives with
 * state='expired' and its blob_key cleared (ARCHITECTURE.md §7 — "expiry only
 * ever deletes bytes, never the archive"). Runs once on boot and then on an
 * interval.
 */
import { nowIso } from './db.js';
import { UPLOAD_DEADLINE_MS } from './config.js';

/**
 * @param {{db:import('./db.js').Db, storage:any}} ctx
 * @returns {Promise<{expired:number, blobsDeleted:number}>}
 */
export async function runSweep(ctx, { asOf = nowIso(), quiet = false } = {}) {
  const { db, storage } = ctx;
  const due = db.findExpirable(asOf);
  let blobsDeleted = 0;

  let expired = 0;
  for (const row of due) {
    // Flip the row first. Deleting bytes and *then* recording the state is a
    // window in which a concurrent request sees a transfer that is still
    // 'complete' but whose blob has already gone.
    if (!db.transitionTransferState(row.id, 'complete', 'expired', row.blob_key)) continue;
    expired += 1;
    if (row.blob_key) {
      try {
        await storage.delete(row.blob_key);
        blobsDeleted += 1;
      } catch (err) {
        console.warn(`[transmat] sweep: could not delete blob ${row.blob_key}: ${err.message}`);
      }
    }
  }

  // Reclaim uploads nobody ever completed. A presigned PUT can land bytes in
  // storage and then the client vanishes — app killed, network died, user gave
  // up — and without this those bytes are billed forever and invisible to the
  // expiry sweep, which only looks at 'complete'.
  const uploadDeadline = new Date(new Date(asOf).getTime() - UPLOAD_DEADLINE_MS).toISOString();
  const stale = db.findStaleUploads(uploadDeadline);
  let uploadsReclaimed = 0;
  for (const row of stale) {
    // Claim the row before touching a single byte. findStaleUploads() ran an
    // await ago; in between, the client may have completed this upload and
    // been told so. Deleting first would destroy a delivered transfer's bytes
    // and then mark it 'cancelled' underneath the recipient who was just
    // pushed about it. If the conditional update finds no 'uploading' row, the
    // upload is somebody else's business now.
    if (!db.transitionTransferState(row.id, 'uploading', 'cancelled', null)) continue;
    uploadsReclaimed += 1;
    if (row.blob_key) {
      try {
        await storage.delete(row.blob_key);
        blobsDeleted += 1;
      } catch (err) {
        console.warn(`[transmat] sweep: could not delete orphaned blob ${row.blob_key}: ${err.message}`);
      }
    }
  }

  if (uploadsReclaimed && !quiet) {
    console.log(`[transmat] sweep: reclaimed ${uploadsReclaimed} abandoned upload(s)`);
  }

  if (expired && !quiet) {
    console.log(
      `[transmat] sweep: expired ${expired} transfer(s), deleted ${blobsDeleted} blob(s)`,
    );
  }
  return { expired, blobsDeleted, uploadsReclaimed };
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
