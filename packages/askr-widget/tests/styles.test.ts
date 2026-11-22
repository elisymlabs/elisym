import { describe, expect, it } from 'vitest';
import { WIDGET_CSS } from '../src/ui/styles';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'u').exec(WIDGET_CSS);
  return match?.[1] ?? '';
}

describe('the launcher stylesheet', () => {
  it('keeps a long store text inside the screen, ending in an ellipsis', () => {
    expect(ruleBody('.launcher')).toContain('max-width: calc(100vw - 32px);');
    expect(ruleBody('.launcher-label')).toContain('text-overflow: ellipsis;');
    expect(ruleBody('.launcher-label')).toContain('overflow: hidden;');
    expect(ruleBody('.launcher-text')).toContain('min-width: 0;');
  });
});
