/**
 * Plan usability.
 *
 * `active` is the historical "the project has a stack" flag. HNFlow mode
 * (`mode: "capability"`) also produces a usable plan without a project stack
 * because Core is always loaded there. Every host path checks both.
 */

/**
 * Whether a resolved plan contributes content to the session.
 * @param {Record<string, unknown> | null | undefined} plan - normalized plan.
 * @returns {boolean} true when the plan is usable.
 */
export function planUsable(plan) {
  if (plan === null || plan === undefined || typeof plan !== 'object') return false
  if (plan.active === true) return true
  if (plan.mode === 'capability') return true
  return plan.core !== null && plan.core !== undefined
}

/**
 * Human-readable reason a plan is not usable.
 * @param {Record<string, unknown> | null | undefined} plan - normalized plan.
 * @returns {string} short diagnostic.
 */
export function unusablePlanReason(plan) {
  if (plan === null || plan === undefined) return 'resolve returned no plan'
  return 'resolve returned an inactive plan (upgrade hnflow-stack or set resolveMode: project)'
}
