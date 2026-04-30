/**
 * Two-tier rate limiter for free LLM skills (mode='llm', price=0).
 * Provides Sybil-resistant global cap plus per-customer-per-skill cap
 * that respects an optional skill-level override.
 *
 * Both limiters are independent of the existing per-customer general
 * limiter; callers (CLI runtime, plugin handler) check all of them in
 * sequence and only `check()` after every tier passes `peek()` so a
 * single denial does not consume slots in earlier tiers.
 */

import { createSlidingWindowLimiter, type SlidingWindowLimiter } from '../primitives/rateLimiter';
import {
  DEFAULT_FREE_LLM_GLOBAL_MAX,
  DEFAULT_FREE_LLM_GLOBAL_WINDOW_MS,
  DEFAULT_FREE_LLM_MAX_TRACKED_KEYS,
  DEFAULT_FREE_LLM_PER_CUSTOMER_MAX,
  DEFAULT_FREE_LLM_PER_CUSTOMER_WINDOW_MS,
} from './constants';
import type { SkillRateLimit } from './types';

export const FREE_LLM_GLOBAL_KEY = '__free_llm_global__';

export interface FreeLlmLimiterOptions {
  /** Max tracked (customer, skill) keys. Default 1000 (LRU evicted past cap). */
  maxKeys?: number;
  /** Default per-customer cap when a free LLM skill omits `rate_limit`. */
  defaultPerCustomer?: SkillRateLimit;
  /** Global Sybil cap across all free LLM jobs. */
  global?: SkillRateLimit;
}

export interface FreeLlmLimiterSet {
  /** Sybil-protection limiter keyed on `FREE_LLM_GLOBAL_KEY`. */
  globalLimiter: SlidingWindowLimiter;
  /**
   * Return the per-customer limiter for a given skill. Skills that
   * declare a `rate_limit` get their own limiter sized to that
   * (window, cap); skills that don't share a default-window limiter.
   * Each call uses `peek/check` keyed on `customerId` alone since each
   * skill has a dedicated limiter store.
   */
  getPerCustomerLimiter(
    skillName: string,
    override: SkillRateLimit | undefined,
  ): SlidingWindowLimiter;
  /** Drop expired hits from every per-customer limiter (default + per-skill). */
  prunePerCustomer(): void;
  /** Default cap to apply when a skill omits `rate_limit`. */
  defaultPerCustomer: SkillRateLimit;
  /** Sybil-cap settings (echo of global option for diagnostics). */
  global: SkillRateLimit;
}

/**
 * Effective per-skill rate limit: the override if it's well-formed,
 * else `undefined` so callers can fall through to the default limiter.
 */
export function resolvePerSkillRateLimit(
  skillRateLimit: SkillRateLimit | undefined,
): SkillRateLimit | undefined {
  if (!skillRateLimit) {
    return undefined;
  }
  if (skillRateLimit.maxPerWindow <= 0 || skillRateLimit.perWindowMs <= 0) {
    return undefined;
  }
  return skillRateLimit;
}

export function createFreeLlmLimiterSet(options: FreeLlmLimiterOptions = {}): FreeLlmLimiterSet {
  const defaultPerCustomer: SkillRateLimit = options.defaultPerCustomer ?? {
    perWindowMs: DEFAULT_FREE_LLM_PER_CUSTOMER_WINDOW_MS,
    maxPerWindow: DEFAULT_FREE_LLM_PER_CUSTOMER_MAX,
  };
  const global: SkillRateLimit = options.global ?? {
    perWindowMs: DEFAULT_FREE_LLM_GLOBAL_WINDOW_MS,
    maxPerWindow: DEFAULT_FREE_LLM_GLOBAL_MAX,
  };
  const maxKeys = options.maxKeys ?? DEFAULT_FREE_LLM_MAX_TRACKED_KEYS;

  const globalLimiter = createSlidingWindowLimiter({
    windowMs: global.perWindowMs,
    maxPerWindow: global.maxPerWindow,
    maxKeys: 1,
  });

  const defaultLimiter = createSlidingWindowLimiter({
    windowMs: defaultPerCustomer.perWindowMs,
    maxPerWindow: defaultPerCustomer.maxPerWindow,
    maxKeys,
  });

  const perSkillLimiters = new Map<string, SlidingWindowLimiter>();

  function getPerCustomerLimiter(
    skillName: string,
    override: SkillRateLimit | undefined,
  ): SlidingWindowLimiter {
    const effective = resolvePerSkillRateLimit(override);
    if (!effective) {
      return defaultLimiter;
    }
    const cached = perSkillLimiters.get(skillName);
    if (cached) {
      return cached;
    }
    const limiter = createSlidingWindowLimiter({
      windowMs: effective.perWindowMs,
      maxPerWindow: effective.maxPerWindow,
      maxKeys,
    });
    perSkillLimiters.set(skillName, limiter);
    return limiter;
  }

  function prunePerCustomer(): void {
    defaultLimiter.prune();
    for (const limiter of perSkillLimiters.values()) {
      limiter.prune();
    }
  }

  return {
    globalLimiter,
    getPerCustomerLimiter,
    prunePerCustomer,
    defaultPerCustomer,
    global,
  };
}

/**
 * Compose a per-skill key for the per-customer limiter. The default
 * limiter is shared across skills without an override, so the skill
 * name is needed to keep each (customer, skill) pair counted
 * independently. Per-skill limiters use the same key for consistency
 * even though the skill component is redundant inside a dedicated
 * limiter store.
 */
export function freeLlmCustomerKey(customerId: string, skillName: string): string {
  return `${customerId}|${skillName}`;
}
