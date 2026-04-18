import { lamportsToSol } from './pricing';

export interface ApprovalRequest {
  jobId?: string;
  providerPubkey: string;
  capability: string;
  lamports: bigint;
  reason: string;
}

export interface ApprovalDecision {
  approved: boolean;
  note?: string;
}

export interface ApprovalBackend {
  request: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export class AutoApproveBackend implements ApprovalBackend {
  async request(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: true, note: 'auto-approved' };
  }
}

export class DenyBackend implements ApprovalBackend {
  async request(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: false, note: 'denied by policy' };
  }
}

export function describe(request: ApprovalRequest): string {
  const sol = lamportsToSol(request.lamports);
  return `Approval needed: hire ${request.providerPubkey.slice(0, 8)}… for ${request.capability} (~${sol} SOL) - ${request.reason}`;
}
