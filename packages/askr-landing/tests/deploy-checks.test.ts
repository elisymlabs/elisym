import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deployProblems } from '../scripts/deploy-checks';
import { renderLlmsTxt } from '../src/llms-txt';

const PACKAGE = process.cwd();
const PAGES = ['index.html', 'privacy.html', 'terms-of-service.html'];
const STYLED =
  '<link rel="stylesheet" href="/assets/a.css"><script type="module" src="/assets/a.js"></script>';

let dist = '';
const vercel = () => JSON.parse(readFileSync(join(PACKAGE, 'vercel.json'), 'utf8'));
const problems = (config = vercel()) => deployProblems(dist, config, PAGES);

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'askr-deploy-'));
  writeFileSync(join(dist, 'index.html'), `${STYLED}<div id="root"></div>`);
  for (const page of ['privacy.html', 'terms-of-service.html']) {
    writeFileSync(join(dist, page), `${STYLED}<div id="root"><h1>Legal</h1></div>`);
  }
  writeFileSync(join(dist, 'llms.txt'), renderLlmsTxt());
});

afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe('the deploy checks', () => {
  it('pass a good dist served by the real vercel.json', () => {
    expect(problems()).toEqual([]);
  });

  it('fail each page problem', () => {
    unlinkSync(join(dist, 'privacy.html'));
    expect(problems()).toContain('privacy.html was not built');
    writeFileSync(join(dist, 'privacy.html'), `${STYLED}<h1>x</h1>`);
    writeFileSync(join(dist, 'terms-of-service.html'), `${STYLED}<h2>x</h2>`);
    expect(problems()).toContain('terms-of-service.html: is not prerendered');
    writeFileSync(join(dist, 'terms-of-service.html'), '<h1>x</h1>');
    expect(problems()).toContain('terms-of-service.html: no stylesheet');
    writeFileSync(join(dist, 'index.html'), `${STYLED}<script>1</script>`);
    expect(problems()).toContain('index.html: an inline <script>');
  });

  it('fail each vercel.json problem', () => {
    const swapped = (from: string, to: string) =>
      JSON.parse(JSON.stringify(vercel()).replace(from, to));
    expect(problems({ ...vercel(), cleanUrls: false }).length).toBeGreaterThan(0);
    expect(problems(swapped("default-src 'none'", "default-src 'self'")).length).toBeGreaterThan(0);
    expect(problems(swapped('"no-referrer"', '"origin"')).length).toBeGreaterThan(0);
    expect(problems(swapped('"nosniff"', '"sniff"')).length).toBeGreaterThan(0);
  });
});
