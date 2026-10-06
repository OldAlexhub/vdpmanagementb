import { isCompassRosterAuthority } from './compassClient.js';
import { compassRosterSettings, syncCompassRoster } from './compassRosterService.js';

let checking = false;
let timer = null;

export async function runCompassSyncIfDue({ force = false } = {}) {
  if (checking || !isCompassRosterAuthority()) return null;
  checking = true;
  try {
    const settings = await compassRosterSettings();
    if (!force && !settings.automaticSyncEnabled) return null;
    const intervalMs = settings.syncIntervalMinutes * 60 * 1000;
    const lastAttempt = settings.lastAttemptAt ? new Date(settings.lastAttemptAt).getTime() : 0;
    if (!force && lastAttempt && Date.now() - lastAttempt < intervalMs) return null;
    return await syncCompassRoster();
  } finally {
    checking = false;
  }
}

export function startCompassSyncScheduler() {
  if (timer || !isCompassRosterAuthority()) return timer;
  const check = () => runCompassSyncIfDue()
    .then((result) => result && console.log(`Compass roster synchronized (${result.summary.providers.created} providers created, ${result.summary.providers.deactivated} deactivated)`))
    .catch((error) => console.error('Compass roster sync failed:', error.message));
  check();
  // The stored interval is read on every check, so Settings changes need no restart.
  timer = setInterval(check, 30 * 1000);
  timer.unref?.();
  return timer;
}
