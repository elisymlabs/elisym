import type { Route } from '@elizaos/core';
import { renderPrometheus } from '../lib/metrics';

export const metricsRoute: Route = {
  type: 'GET',
  path: '/plugins/elisym/metrics',
  name: 'elisym-metrics',
  public: true,
  handler: async (_req, res): Promise<void> => {
    const body = renderPrometheus();
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    }
    res.status(200).send(body);
  },
};
