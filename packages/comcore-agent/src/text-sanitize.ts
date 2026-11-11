import { stripInvisible } from './fence';

/**
 * The 4.3 markdown subset for model-written text: no raw HTML, no links, no
 * images. URLs stay as plain text; the only clickable links are cards.
 */

const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]*)\)/g;
const AUTOLINK_RE = /<((?:https?|mailto|tel):[^>\s]+)>/gi;
const REFERENCE_DEFINITION_RE = /^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm;

export function sanitizeAnswerText(text: string): string {
  return (
    stripInvisible(text)
      .replace(IMAGE_RE, '$1')
      .replace(LINK_RE, '$1 ($2)')
      .replace(AUTOLINK_RE, '$1')
      .replace(REFERENCE_DEFINITION_RE, '')
      // No tag stripping by regex (nested tags survive one pass): angle brackets
      // never reach the widget at all, so no HTML can be formed from model text.
      .replace(/</g, '‹')
      .replace(/>/g, '›')
      .trim()
  );
}
