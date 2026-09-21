import { publicationAuthorityEnabled } from './authority-config.mjs';
import { runScheduledPublication } from './production-publisher.mjs';
import { recordScheduledInvocation } from './scheduler-liveness.mjs';

export default {
  async scheduled(controller, env) {
    const scheduledTime = controller?.scheduledTime;
    let heartbeatRecorded = false;

    try {
      await recordScheduledInvocation(env.DB, {
        scheduledTime,
        observedAt: new Date(),
      });
      heartbeatRecorded = true;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'scheduler_heartbeat_failed',
          workerRole: 'publisher-only',
          scheduledTime,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    if (!publicationAuthorityEnabled(env)) {
      const result = {
        status: 'idle',
        reason: 'authority_disabled',
        dispatched: false,
        automaticRetryAllowed: false,
      };

      console.log(
        JSON.stringify({
          event: 'scheduled',
          workerRole: 'publisher-only',
          scheduledTime,
          heartbeatRecorded,
          livePublication: false,
          schedulerAuthority: false,
          result,
        }),
      );

      return result;
    }

    const now = new Date(scheduledTime);

    try {
      const result = await runScheduledPublication(env, { now });

      console.log(
        JSON.stringify({
          event: 'scheduled',
          workerRole: 'publisher-only',
          scheduledTime,
          heartbeatRecorded,
          livePublication: true,
          schedulerAuthority: true,
          result,
        }),
      );

      return result;
    } catch {
      const result = {
        status: 'failed_closed',
        reason: 'scheduled_publication_unhandled_error',
        dispatched: false,
        automaticRetryAllowed: false,
      };

      console.error(
        JSON.stringify({
          event: 'scheduled',
          workerRole: 'publisher-only',
          scheduledTime,
          heartbeatRecorded,
          livePublication: true,
          schedulerAuthority: true,
          result,
        }),
      );

      return result;
    }
  },
};
