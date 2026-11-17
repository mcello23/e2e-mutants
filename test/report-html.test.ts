import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, REPORT_CSP, renderHtmlReport } from '../src/core/report-html';
import { buildReport } from '../src/core/score';
import { HOSTILE, observed, reportInput, reportTest, result } from './fixtures';

const hostileTest = `cypress/e2e/weak.cy.js :: orders > ${HOSTILE}`;

const report = buildReport(
  reportInput({
    tests: [
      reportTest(hostileTest, {
        fields: [
          observed('$[0].customer', HOSTILE),
          {
            id: 'GET /api/me #0 $.token',
            requestKey: 'GET /api/me',
            occurrence: 0,
            path: ['token'],
            pathText: '$.token',
            kind: 'string',
            status: 'sensitive'
          },
          {
            id: 'GET /api/orders #0 $[0].note',
            requestKey: 'GET /api/orders',
            occurrence: 0,
            path: [0, 'note'],
            pathText: '$[0].note',
            kind: 'string',
            status: 'unobserved',
            value: `"><script>alert(2)</script>`
          }
        ]
      }),
      reportTest('cypress/e2e/weak.cy.js :: orders > unstable one', { baseline: 'unstable', note: 'failed in baseline 1 of 2' })
    ],
    results: [
      result(
        'survived',
        {
          testId: hostileTest,
          requestKey: 'GET /api/orders',
          path: [0, 'customer'],
          pathText: '$[0].customer',
          operator: 'str-reverse',
          kind: 'string',
          before: JSON.stringify(HOSTILE),
          after: JSON.stringify('>)1(trela=rorreno x=crs gmi<'),
          evidence: { before: 'Cliente ', match: HOSTILE, after: ' & cia' }
        },
        {}
      ),
      result('killed', { testId: hostileTest }, { error: `AssertionError: expected '${HOSTILE}' to equal 'x'` })
    ],
    errors: ['spawn <cypress> failed & exited']
  })
);

const html = renderHtmlReport(report);

describe('renderHtmlReport', () => {
  test('is a self-contained document with the CSP meta and no script', () => {
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`));
    assert.equal(REPORT_CSP, "default-src 'none'; style-src 'unsafe-inline'");
    assert.equal(/<script/i.test(html), false);
    assert.equal(/<link\b/i.test(html), false);
    assert.equal(/\bsrc=["']?https?:/i.test(html), false);
  });

  test('escapes hostile strings everywhere', () => {
    assert.equal(html.includes(HOSTILE), false);
    assert.equal(html.includes('<img'), false);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.equal(html.includes('"><script>'), false);
    assert.ok(html.includes('spawn &lt;cypress&gt; failed &amp; exited'));
    assert.ok(html.includes('<mark>&lt;img src=x onerror=alert(1)&gt;</mark>'));
  });

  test('supports light and dark mode', () => {
    assert.ok(html.includes('@media (prefers-color-scheme:dark)'));
    assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
  });

  test('shows the score, survived mutants first, and the per-test table', () => {
    assert.ok(html.includes('50.0%'));
    const survived = html.indexOf('id="survived"');
    const tests = html.indexOf('id="tests"');
    const other = html.indexOf('id="other"');
    assert.ok(survived > 0 && survived < tests && tests < other);
    assert.ok(html.includes('str-reverse'));
    assert.ok(html.includes('$[0].customer'));
  });

  test('collapses non-observed fields and hides sensitive values', () => {
    const fields = html.slice(html.indexOf('id="fields"'));
    assert.ok(fields.includes('<details class="group">'));
    assert.ok(fields.includes('hidden (sensitive key)'));
    assert.ok(fields.includes('$[0].note'));
  });

  test('lists unstable tests', () => {
    const section = html.slice(html.indexOf('id="unstable"'), html.indexOf('id="no-data"'));
    assert.ok(section.includes('unstable one'));
    assert.ok(section.includes('failed in baseline 1 of 2'));
  });

  test('crafted report values cannot inject markup', () => {
    const crafted = JSON.parse(JSON.stringify(report));
    crafted.tests[0].fields[2].status = 'x"><meta http-equiv=refresh content="0;url=file:///tmp/landed.html"><span class="';
    crafted.tests[0].fields[2].occurrence = '0"><b>';
    crafted.summary.survived = '<h1>INJECTED</h1>';
    crafted.summary.score = '1;background:url(x)';
    crafted.breakdown.byField[0].killed = '<i>x</i>';
    const out = renderHtmlReport(crafted);
    assert.equal(out.includes('<meta http-equiv=refresh'), false);
    assert.equal(out.includes('<h1>'), false);
    assert.equal(out.includes('<i>x</i>'), false);
    assert.equal(out.includes('"><b>'), false);
  });

  test('says when a value appeared in more than one place', () => {
    const many = buildReport(
      reportInput({
        results: [result('survived', { evidence: { before: 'Atualizado em ', match: '12/11/2026', after: ' às 06:30', matches: 2 } })]
      })
    );
    assert.ok(renderHtmlReport(many).includes('first of 2 places with this value'));
  });

  test('the field table shows in how many tests each field was shown, mutated and killed', () => {
    const section = html.slice(html.indexOf('id="fields-score"'), html.indexOf('id="unstable"'));
    assert.ok(section.includes('Shown in tests'));
    assert.ok(section.includes('Killed in'));
  });

  test('renders an empty report', () => {
    const empty = renderHtmlReport(buildReport(reportInput()));
    assert.ok(empty.includes('n/a'));
    assert.ok(empty.includes('No survived mutants.'));
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
