// Helpers for writing run summaries to disk.
//
// k6 calls `handleSummary(data)` at end-of-test if the scenario exports it.
// We forward the raw JSON (so external tooling can crunch percentiles) plus a
// human-readable HTML rendering via the official `k6-summary` template.

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { RUN_ID, SCENARIO } from './env.js';

// Honour the runner's REPORTS_DIR env so summary files land in the host's
// packages/perf/k6/reports/ when k6 is invoked from scripts/run.sh.
// Falls back to a relative path so a bare `k6 run` still produces output.
const REPORTS_DIR = __ENV.REPORTS_DIR || './k6/reports';

export function writeSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${REPORTS_DIR}/${SCENARIO}-${RUN_ID}.json`]: JSON.stringify(data, null, 2),
    [`${REPORTS_DIR}/${SCENARIO}-${RUN_ID}.html`]: renderHtml(data),
  };
}

function renderHtml(data) {
  const metrics = Object.entries(data.metrics ?? {})
    .map(([name, m]) => {
      const values = Object.entries(m.values ?? {})
        .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${formatValue(v)}</dd>`)
        .join('');
      return `<section><h2>${escape(name)} <small>(${escape(m.type)})</small></h2><dl>${values}</dl></section>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>k6 ${escape(SCENARIO)} ${escape(RUN_ID)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:24px;background:#0b0d10;color:#e6e6e6;}
h1{font-size:18px;border-bottom:1px solid #333;padding-bottom:8px;}
h2{font-size:14px;margin-top:24px;}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:13px;}
dt{color:#9ca3af;}
small{color:#9ca3af;font-weight:normal;}
section{padding:8px 12px;background:#11151a;border-radius:6px;margin-bottom:12px;}
</style></head>
<body>
<h1>k6 - ${escape(SCENARIO)} - ${escape(RUN_ID)}</h1>
${metrics}
</body></html>`;
}

function formatValue(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  return escape(String(v));
}

function escape(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}
