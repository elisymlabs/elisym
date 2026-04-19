import type { Action, ActionResult, IAgentRuntime } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import type { ElisymService } from '../services/ElisymService';
import { hasState } from '../state';

export const unpublishServiceAction: Action = {
  name: 'ELISYM_UNPUBLISH_SERVICE',
  similes: ['RETRACT_SERVICE', 'DELETE_CAPABILITY'],
  description: "Retract this agent's capability card from the elisym network.",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => hasState(runtime),
  handler: async (runtime, _message, _state, _options, callback): Promise<ActionResult> => {
    const elisym = runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    if (!elisym) {
      throw new Error('ElisymService is not running');
    }
    const name = runtime.character?.name;
    if (!name) {
      throw new Error('Character name is required to retract a capability card');
    }
    const eventId = await elisym.getClient().discovery.deleteCapability(elisym.getIdentity(), name);
    await callback?.({
      text: `Retracted capability card "${name}" (tombstone ${eventId.slice(0, 8)}).`,
      source: 'elisym',
    });
    return { success: true, data: { eventId } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Take my services offline' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Retracting capability card...',
          actions: ['ELISYM_UNPUBLISH_SERVICE'],
        },
      },
    ],
  ],
};
