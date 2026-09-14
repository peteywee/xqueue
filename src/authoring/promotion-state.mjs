import { AuthoringContractError, digestText } from './contracts.mjs';
import { applyPostPromotionToMarkdown, planPostPromotion } from './promotion.mjs';

export function planStateBoundPostPromotion({
  candidate,
  approval,
  existingPosts,
  targetMarkdown,
  priorPromotions = [],
  promotedAt,
}) {
  if (typeof targetMarkdown !== 'string') {
    throw new AuthoringContractError('target_markdown_required', 'state-bound post promotion requires the exact current target markdown');
  }
  const core = planPostPromotion({
    candidate,
    approval,
    existingPosts,
    priorPromotions,
    promotedAt,
  });
  if (core.status === 'already_promoted') {
    return Object.freeze({ ...core, targetBaseDigest: null });
  }
  return Object.freeze({
    ...core,
    targetBaseDigest: digestText(targetMarkdown),
  });
}

export function applyStateBoundPostPromotion(existingMarkdown, plan) {
  if (typeof existingMarkdown !== 'string') {
    throw new AuthoringContractError('invalid_target_markdown', 'existingMarkdown must be a string');
  }
  if (plan?.status === 'already_promoted') return existingMarkdown;
  if (plan?.status !== 'ready' || typeof plan.targetBaseDigest !== 'string') {
    throw new AuthoringContractError('state_bound_plan_required', 'a ready state-bound promotion plan is required');
  }
  if (digestText(existingMarkdown) !== plan.targetBaseDigest) {
    throw new AuthoringContractError('stale_promotion_target', 'target content changed after the promotion plan was created');
  }
  return applyPostPromotionToMarkdown(existingMarkdown, plan);
}
