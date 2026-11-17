import type { FieldObservation } from './observe';
import { occurrenceLabel } from './ids';
import { describeArrayLength, describeValue } from './leaves';
import { formatScore, summarize, type E2eMutantsReport, type FieldGroupScore, type GroupScore, type MutantResult, type ReportTest } from './score';
import type { Evidence, Verdict } from './types';

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'";

const VERDICT_LABELS: Record<Verdict, string> = {
  survived: 'Survived',
  killed: 'Killed',
  'killed-crash': 'Killed by crash',
  flaky: 'Flaky',
  'not-applied': 'Not applied',
  error: 'Error'
};

const VERDICT_HELP: Record<Verdict, string> = {
  survived: 'The test passed while the page rendered the changed value.',
  killed: 'The test failed with the mutation applied, and failed again on the confirm rerun.',
  'killed-crash': 'The application threw an uncaught exception. Excluded from the score.',
  flaky: 'Failed once, then passed on the confirm rerun. Excluded from the score.',
  'not-applied': 'The targeted response never arrived in that run. Excluded from the score.',
  error: 'The runner failed. Excluded from the score.'
};

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '?';
}

function validScore(score: unknown): number | null {
  return typeof score === 'number' && Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null;
}

function scoreTone(score: number | null): string {
  if (score === null) return 'none';
  if (score >= 0.8) return 'good';
  if (score >= 0.5) return 'warn';
  return 'bad';
}

function evidenceHtml(evidence: Evidence | undefined): string {
  if (evidence === undefined) return '<span class="muted">no snippet</span>';
  const quote = `<q class="evidence">${escapeHtml(evidence.before)}<mark>${escapeHtml(evidence.match)}</mark>${escapeHtml(evidence.after)}</q>`;
  const matches = Number(evidence.matches);
  if (!Number.isFinite(matches) || matches < 2) return quote;
  const count = matches >= 10 ? '10 or more' : String(matches);
  return `${quote} <span class="muted">(first of ${count} places with this value; the test may check another one)</span>`;
}

function mutantCard(result: MutantResult): string {
  const m = result.mutant;
  return `<article class="mutant">
<div class="mutant-head"><span class="op">${escapeHtml(m.operator)}</span><code>${escapeHtml(m.requestKey)}</code><code class="path">${escapeHtml(m.pathText)}</code></div>
<div class="change"><code>${escapeHtml(m.before)}</code><span aria-hidden="true">→</span><span class="sr">changed to</span><code>${escapeHtml(m.after)}</code></div>
<div class="test-id">${escapeHtml(m.testId)}</div>
<div class="seen"><span class="muted">Seen on the page:</span> ${evidenceHtml(m.evidence)}</div>
</article>`;
}

function table(headers: string[], rows: string[][], className = ''): string {
  if (rows.length === 0) return '<p class="muted">Nothing to show.</p>';
  const head = headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('');
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `<div class="table-wrap"><table${className ? ` class="${className}"` : ''}><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function scoreCell(value: unknown): string {
  const score = validScore(value);
  return `<span class="pill tone-${scoreTone(score)}">${escapeHtml(formatScore(score))}</span>`;
}

function testsTable(report: E2eMutantsReport): string {
  const rows = report.tests.map((test) => {
    const results = report.results.filter((r) => r.mutant.testId === test.testId);
    const s = summarize(results);
    const observed = test.fields.filter((f) => f.status === 'observed').length;
    return [
      `<span class="test-id">${escapeHtml(test.testId)}</span>`,
      `<span class="pill baseline-${escapeHtml(test.baseline)}">${escapeHtml(test.baseline)}</span>`,
      String(observed),
      String(s.total),
      String(s.killed),
      String(s.survived),
      String(s.killedCrash),
      String(s.flaky),
      String(s.notApplied),
      String(s.error),
      scoreCell(s.score)
    ];
  });
  return table(['Test', 'Baseline', 'Observed fields', 'Mutants', 'Killed', 'Survived', 'Crash', 'Flaky', 'Not applied', 'Error', 'Score'], rows, 'numeric');
}

function groupTable(groups: GroupScore[], label: string): string {
  return table(
    [label, 'Mutants', 'Killed', 'Survived', 'Excluded', 'Score'],
    groups.map((g) => [
      `<code>${escapeHtml(g.key)}</code>`,
      num(g.total),
      num(g.killed),
      num(g.survived),
      num(Number(g.killedCrash) + Number(g.flaky) + Number(g.notApplied) + Number(g.error)),
      scoreCell(g.score)
    ]),
    'numeric'
  );
}

function fieldTable(groups: Array<GroupScore & Partial<FieldGroupScore>>): string {
  return table(
    ['Field', 'Shown in tests', 'Mutated in', 'Killed in', 'Mutants', 'Killed', 'Survived', 'Excluded', 'Score'],
    groups.map((g) => [
      `<code>${escapeHtml(g.key)}</code>`,
      g.shownIn === undefined ? '' : num(g.shownIn),
      g.mutatedIn === undefined ? '' : num(g.mutatedIn),
      g.killedIn === undefined ? '' : num(g.killedIn),
      num(g.total),
      num(g.killed),
      num(g.survived),
      num(Number(g.killedCrash) + Number(g.flaky) + Number(g.notApplied) + Number(g.error)),
      scoreCell(g.score)
    ]),
    'numeric'
  );
}

function otherMutants(report: E2eMutantsReport): string {
  const verdicts: Verdict[] = ['killed', 'killed-crash', 'flaky', 'not-applied', 'error'];
  return verdicts
    .map((verdict) => {
      const results = report.results.filter((r) => r.verdict === verdict);
      if (results.length === 0) return '';
      const rows = results.map((r) => [
        `<span class="test-id">${escapeHtml(r.mutant.testId)}</span>`,
        `<code>${escapeHtml(r.mutant.requestKey)}</code>`,
        `<code class="path">${escapeHtml(r.mutant.pathText)}</code>`,
        `<span class="op">${escapeHtml(r.mutant.operator)}</span>`,
        `<code>${escapeHtml(r.mutant.before)}</code> → <code>${escapeHtml(r.mutant.after)}</code>`,
        r.error ? `<span class="error-text">${escapeHtml(r.error)}</span>` : ''
      ]);
      return `<details class="group verdict-${escapeHtml(verdict)}"><summary><span class="pill tone-${escapeHtml(verdict)}">${escapeHtml(VERDICT_LABELS[verdict])}</span> ${results.length} <span class="muted">${escapeHtml(VERDICT_HELP[verdict])}</span></summary>
${table(['Test', 'Endpoint', 'Path', 'Operator', 'Change', 'Failure'], rows)}
</details>`;
    })
    .join('\n');
}

function fieldValue(field: FieldObservation): string {
  if (field.status === 'sensitive') return '<span class="muted">hidden (sensitive key)</span>';
  if (field.kind === 'array') return `<code>${escapeHtml(describeArrayLength(field.length ?? 0))}</code>`;
  return `<code>${escapeHtml(describeValue(field.value))}</code>`;
}

function fieldsSection(tests: ReportTest[]): string {
  if (tests.length === 0) return '<p class="muted">No tests recorded.</p>';
  return tests
    .map((test) => {
      const count = (status: FieldObservation['status']): number =>
        Number(test.fieldCounts?.[status] ?? test.fields.filter((f) => f.status === status).length) || 0;
      const hidden = test.fields.filter((f) => f.status !== 'observed');
      const rows = hidden.map((f) => [
        `<code>${escapeHtml(f.requestKey)} #${escapeHtml(occurrenceLabel(Number(f.occurrence)))}</code>`,
        `<code class="path">${escapeHtml(f.pathText)}</code>`,
        escapeHtml(f.kind),
        `<span class="pill status-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span>`,
        fieldValue(f)
      ]);
      return `<details class="group"><summary><span class="test-id">${escapeHtml(test.testId)}</span> <span class="muted">${count('observed')} observed · ${count('unobserved')} unobserved · ${count('trivial')} trivial · ${count('sensitive')} sensitive</span></summary>
${table(['Response', 'Path', 'Kind', 'Status', 'Value'], rows)}
${test.omittedFields ? `<p class="muted">${num(test.omittedFields)} more fields are not listed.</p>` : ''}
</details>`;
    })
    .join('\n');
}

function listSection(items: string[]): string {
  if (items.length === 0) return '<p class="muted">None.</p>';
  return `<ul class="plain">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

const STYLE = `
:root{--bg:#f6f5f1;--surface:#fff;--ink:#1c1b19;--muted:#6a675f;--line:#e4e1d8;--code:#f1efe9;--mark:#ffe98a;
--bad:#b4321f;--bad-bg:#fbe9e5;--good:#1f7a4d;--good-bg:#e4f3ea;--warn:#8a5d00;--warn-bg:#f8eed6;--none-bg:#ecebe6;
color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--surface:#1d1c1a;--ink:#ecebe6;--muted:#a3a097;--line:#34322e;--code:#27261f;--mark:#6b5a12;
--bad:#f39581;--bad-bg:#3b1f19;--good:#74d3a0;--good-bg:#16301f;--warn:#e6ba5c;--warn-bg:#33290f;--none-bg:#2a2924}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main,header.top,footer{max-width:1120px;margin:0 auto;padding:0 16px}
header.top{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;justify-content:space-between;padding-top:24px}
.brand{font-weight:700;letter-spacing:-.01em;font-size:18px}
.brand span,.muted{color:var(--muted);font-weight:400}
.meta{color:var(--muted);font-size:13px}
section{margin:28px 0}
h2{font-size:17px;margin:0 0 10px;display:flex;gap:8px;align-items:center}
.count{font-size:13px;color:var(--muted);font-weight:500}
.hero{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px 22px 18px;margin-top:16px}
.score{font-size:56px;line-height:1;font-weight:750;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.score-bad{color:var(--bad)}.score-warn{color:var(--warn)}.score-good{color:var(--good)}.score-none{color:var(--muted)}
.score-label{color:var(--muted);margin-top:6px}
.bar{height:8px;border-radius:99px;background:var(--bad-bg);overflow:hidden;margin:16px 0 14px}
.bar span{display:block;height:100%;background:var(--good)}
.counts{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0;padding:0}
.counts li{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:4px 10px;font-variant-numeric:tabular-nums}
.counts b{font-weight:650}
.mutants{display:grid;gap:10px}
.mutant{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:10px;padding:12px 14px;min-width:0}
.mutant-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.change{margin:8px 0 6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:15px}
.test-id{overflow-wrap:anywhere}
.mutant .test-id{color:var(--muted);font-size:13px}
.seen{margin-top:6px;font-size:13px;overflow-wrap:anywhere}
.evidence{quotes:none;background:var(--code);border-radius:6px;padding:2px 6px}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere}
.op{font:600 12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.pill{display:inline-block;border-radius:99px;padding:1px 9px;font-size:12px;font-weight:600;background:var(--none-bg);white-space:nowrap}
.tone-good,.tone-killed,.baseline-stable,.status-observed{background:var(--good-bg);color:var(--good)}
.tone-bad,.tone-survived,.baseline-unstable,.baseline-failing{background:var(--bad-bg);color:var(--bad)}
.tone-warn,.tone-killed-crash,.tone-flaky,.baseline-not-run,.baseline-duplicate{background:var(--warn-bg);color:var(--warn)}
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}
tr:last-child td{border-bottom:0}
table.numeric td:not(:first-child){font-variant-numeric:tabular-nums}
details.group{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}
details.group[open] summary{margin-bottom:8px}
details.group .table-wrap{border:0;background:none}
summary{cursor:pointer;overflow-wrap:anywhere}
.error-text{color:var(--bad);overflow-wrap:anywhere}
ul.plain{margin:0;padding-left:18px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
footer{color:var(--muted);font-size:12px;padding-bottom:32px}
td:first-child{min-width:200px}
@media (max-width:600px){.score{font-size:44px}.hero{padding:16px}}
`;

export function renderHtmlReport(report: E2eMutantsReport): string {
  const s = report.summary;
  const score = validScore(s.score);
  const tone = scoreTone(score);
  const width = score === null ? 0 : Math.round(score * 100);
  const survivors = report.results.filter((r) => r.verdict === 'survived');
  const o = report.options;
  const counts: Array<[string, number]> = [
    ['survived', s.survived],
    ['killed', s.killed],
    ['killed-crash', s.killedCrash],
    ['flaky', s.flaky],
    ['not applied', s.notApplied],
    ['error', s.error]
  ];
  const unstable = report.unstableTests.map(
    (t) =>
      `<span class="test-id">${escapeHtml(t.testId)}</span> <span class="pill baseline-${escapeHtml(t.baseline)}">${escapeHtml(t.baseline)}</span> <span class="muted">${escapeHtml(t.reason)}</span>`
  );
  const noData = report.noObservedData.map((id) => `<span class="test-id">${escapeHtml(id)}</span>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>e2e-mutants report</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
<div class="brand">e2e-mutants <span>${escapeHtml(report.version)}</span></div>
<div class="meta">${escapeHtml(report.finishedAt)} · seed ${escapeHtml(o.seed)} · budget ${escapeHtml(o.budget)} · ${escapeHtml(o.baselines)} baselines · ${escapeHtml(o.browser)}</div>
</header>
<main>
<section class="hero" aria-label="Summary">
<div class="score score-${tone}">${escapeHtml(formatScore(score))}</div>
<div class="score-label">Mutation score: killed ÷ (killed + survived), over response fields the page showed during the test.</div>
<div class="bar" role="presentation"><span style="width:${width}%"></span></div>
<ul class="counts">${counts.map(([label, n]) => `<li><b>${num(n)}</b> ${escapeHtml(label)}</li>`).join('')}<li><b>${report.tests.length}</b> tests</li></ul>
</section>
<section id="survived">
<h2>Survived mutants <span class="count">${survivors.length}</span></h2>
<p class="muted">${escapeHtml(VERDICT_HELP.survived)} Each one is a value the test displays without checking.</p>
${survivors.length === 0 ? '<p class="muted">No survived mutants.</p>' : `<div class="mutants">${survivors.map(mutantCard).join('\n')}</div>`}
</section>
<section id="tests">
<h2>Tests <span class="count">${report.tests.length}</span></h2>
${testsTable(report)}
</section>
<section id="other">
<h2>Other mutants <span class="count">${report.results.length - survivors.length}</span></h2>
${otherMutants(report) || '<p class="muted">None.</p>'}
</section>
<section id="endpoints">
<h2>By endpoint</h2>
${groupTable(report.breakdown.byEndpoint, 'Endpoint')}
</section>
<section id="fields-score">
<h2>By field</h2>
<p class="muted">Per field across tests: how many stable tests showed it, how many got a mutant on it, and how many killed one. A field killed in at least one test is checked by the suite. A field shown in more tests than it was mutated in may be checked in the others: raise --budget to find out.</p>
${fieldTable(report.breakdown.byField)}
</section>
<section id="unstable">
<h2>Tests not mutated <span class="count">${report.unstableTests.length}</span></h2>
<p class="muted">Tests that did not pass in every baseline, or that share their title path with another test.</p>
${listSection(unstable)}
</section>
<section id="no-data">
<h2>Tests with no observed data <span class="count">${report.noObservedData.length}</span></h2>
${listSection(noData)}
</section>
<section id="fields">
<h2>Fields not mutated</h2>
<p class="muted">Response fields that were not observed on the page, trivial, or sensitive. Values of sensitive keys are never shown, and the browser removes them from the recorded page text. Other values are cut at 60 characters.</p>
${fieldsSection(report.tests)}
</section>
${report.errors.length > 0 ? `<section id="errors"><h2>Errors <span class="count">${report.errors.length}</span></h2>${listSection(report.errors.map((e) => `<span class="error-text">${escapeHtml(e)}</span>`))}</section>` : ''}
</main>
<footer>Generated by e2e-mutants ${escapeHtml(report.version)} · started ${escapeHtml(report.startedAt)} · specs: ${escapeHtml(o.specs.join(', ') || 'all')}</footer>
</body>
</html>
`;
}
