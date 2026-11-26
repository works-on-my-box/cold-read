// The feature flag one_click_run (developer console → the app → Manage → Feature flags): the one-click run is on
// unless a rule turns it off for a site (installContext equals the site ARI) or the flag is turned off for all; an
// environment the flag has no rule for leaves it on. It is read from the flag service at each step of a run; a service that does not answer within FLAG_WAIT_MS, or
// fails, leaves the button on, so the button does not depend on it. Nothing about a person is passed.
import { FeatureFlags } from '@forge/feature-flags';

export const ONE_CLICK_FLAG = 'one_click_run';
const FLAG_WAIT_MS = 1500;

// site: { installContext, environmentId, environmentType } from the platform's resolver context.
// Returns { on, reason, rule } (reason: the SDK's 'rule_match' | 'override' | 'default' | 'disabled', or
// 'absent' and 'unavailable' when there is no flag to read).
export async function checkOneClickFlag({ installContext, environmentId, environmentType }) {
  const t0 = Date.now();
  const flags = new FeatureFlags();
  let timer;
  let result = { on: true, reason: 'unavailable' };
  try {
    const ready = await Promise.race([
      flags.initialize({ environment: String(environmentType || 'development').toLowerCase() }).then(() => flags.isInitialized()),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), FLAG_WAIT_MS);
      }),
    ]);
    if (ready) {
      // environmentId lets a rule tell apart two environments of the app on one site.
      const details = flags.getFlag({ identifiers: { installContext }, attributes: { installContext, environmentId } }, ONE_CLICK_FLAG);
      result = details ? { on: details.value, reason: details.reason, rule: details.matchedRule } : { on: true, reason: 'absent' };
    }
  } catch {
    result = { on: true, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
    flags.shutdown();
  }
  console.log(`guard flag ${ONE_CLICK_FLAG} on=${result.on} reason=${result.reason} rule=${result.rule ?? '-'} ms=${Date.now() - t0}`);
  return result;
}
