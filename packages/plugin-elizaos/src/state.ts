import type { IAgentRuntime } from '@elizaos/core';
import type { ElisymConfig } from './environment';
import type { ElisymState } from './types';

const states = new WeakMap<IAgentRuntime, ElisymState>();

export function initState(runtime: IAgentRuntime, config: ElisymConfig): ElisymState {
  const state: ElisymState = { config };
  states.set(runtime, state);
  return state;
}

export function getState(runtime: IAgentRuntime): ElisymState {
  const state = states.get(runtime);
  if (!state) {
    throw new Error('elisym plugin state not initialized; init() must run first');
  }
  return state;
}

export function hasState(runtime: IAgentRuntime): boolean {
  return states.has(runtime);
}
