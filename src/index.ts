import { app } from './api/app.ts';
import { handleDeadLetter, handleMessage, RUN_MAX_AGE_MS, startRun } from './pipeline/run.ts';
import { failStaleRuns, listSites } from './pipeline/store.ts';

const FULL_CRON = '15 7 * * *';
const DLQ = 'feedsmith-crawl-dlq';

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const deadLetters = batch.queue === DLQ;
    for (const message of batch.messages) {
      try {
        if (deadLetters) await handleDeadLetter(env, message.body);
        else await handleMessage(env, message.body, message.id);
        message.ack();
      } catch (err) {
        console.error(JSON.stringify({ event: 'queue_message_failed', queue: batch.queue, attempt: message.attempts, message: err instanceof Error ? err.message : String(err) }));
        message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const stale = await failStaleRuns(env.DB, RUN_MAX_AGE_MS);
    const mode = controller.cron === FULL_CRON ? 'full' : 'sweep';
    // The 06:45 sweep could still be running at 07:15 and block the nightly full run.
    if (mode === 'sweep' && new Date(controller.scheduledTime).getUTCHours() === 6) {
      console.log(JSON.stringify({ event: 'cron', cron: controller.cron, skipped: 'sweep before full run', stale }));
      return;
    }
    const results: Record<string, string> = {};
    for (const site of await listSites(env.DB)) {
      try {
        const result = await startRun(env, site.id, mode);
        results[site.id] = result.kind === 'started' ? `${result.run.mode} ${result.run.id}` : result.kind;
      } catch (err) {
        // One site's failure doesn't stop the others.
        results[site.id] = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    console.log(JSON.stringify({ event: 'cron', cron: controller.cron, mode, stale, results }));
  },
} satisfies ExportedHandler<Env, unknown>;
