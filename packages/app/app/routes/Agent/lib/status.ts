import type { PingStatus } from '~/hooks/usePingAgent';

export const STATUS_DOT: Record<PingStatus, string> = {
  pinging: 'ping-pulse',
  online: 'bg-green',
  offline: 'bg-[#ccc]',
};
