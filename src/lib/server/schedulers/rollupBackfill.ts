import db from "../db/db.js";
import { rebuildAllBucketsForTag } from "../db/repositories/monitoringBuckets.js";

/**
 * One-time backfill of monitoring_data_bucket from the existing raw history.
 *
 * Kept out of the Knex migration on purpose. Migrations run while the app is
 * starting, and on a large install this walks millions of rows, so doing it in
 * a migration would hold up the boot and, on Postgres, hold a lock while it
 * did. Here it runs after startup, one monitor at a time, and records progress
 * so a restart continues instead of beginning again.
 *
 * Nothing reads the rollup yet. This only fills it so it can be checked against
 * the raw data before any read path is switched over.
 */
const STATE_KEY = "monitoringRollupBackfill";

interface BackfillState {
  done: boolean;
  completedTags: string[];
}

const readState = async (): Promise<BackfillState> => {
  const row = await db.getSiteDataByKey(STATE_KEY);
  if (!row?.value) return { done: false, completedTags: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<BackfillState>;
    return { done: parsed.done === true, completedTags: parsed.completedTags ?? [] };
  } catch {
    return { done: false, completedTags: [] };
  }
};

const writeState = async (state: BackfillState): Promise<void> => {
  await db.insertOrUpdateSiteData(STATE_KEY, JSON.stringify(state), "object");
};

export async function runRollupBackfill(): Promise<{ built: number; skipped: number }> {
  const state = await readState();
  if (state.done) return { built: 0, skipped: 0 };

  const monitors = await db.getMonitors({});
  const completed = new Set(state.completedTags);
  let built = 0;
  let skipped = 0;

  for (const monitor of monitors) {
    if (completed.has(monitor.tag)) {
      skipped++;
      continue;
    }
    try {
      // One transaction per monitor, so a failure part way through leaves the
      // finished monitors intact and only retries the one that failed.
      const count = await db.rebuildAllBucketsForTag(monitor.tag);
      built += count;
      completed.add(monitor.tag);
      await writeState({ done: false, completedTags: [...completed] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Rollup backfill failed for ${monitor.tag}: ${message}`);
    }
  }

  const allDone = monitors.every((m) => completed.has(m.tag));
  await writeState({ done: allDone, completedTags: [...completed] });
  if (allDone) {
    console.log(`Rollup backfill complete: ${built} buckets built, ${skipped} monitors already done.`);
  }

  return { built, skipped };
}

export default { runRollupBackfill };
