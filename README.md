# e2e-mutants

Mutation testing for Cypress suites. e2e-mutants changes the JSON responses your app renders, one value at a time, and reruns the test that showed that value. When the test still passes, it put the value on screen without checking it. The report lists those survivors with the endpoint, the JSON path, the old and new value, and the text on the page where the value appeared.

Status: v0.1, not yet published to npm. It works on the demo in this repository with Cypress 16.3.0 and Electron on Linux. Cypress 15.21.2 and 15.7.0 passed a small lab spec, not the full demo. Everything else is untested.

## The problem

A green end-to-end test proves that the page loaded and that the selectors exist. It does not prove that the numbers on the page are right. Smoke tests that check `be.visible`, `exist` or "more than 0 rows" pass just as well when the API sends a different revenue, a reversed customer name or an empty list. Suites written fast, and suites written by AI assistants, often look like this: many tests, few assertions about data.

Code coverage cannot see this, because the rendering code runs either way. Mutation testing can: change the data, and see whether any assertion notices.

## How it works

1. **Record.** The suite runs unchanged (`--baselines`, default 2 runs). For each test, the support file records every JSON response body and the text of the page when the page unloads and when the test ends: `document.body.innerText`, plus the text inside open shadow roots and the values of text inputs and textareas. A test counts as stable only when it passed in every baseline.
2. **Observe.** Every leaf of every recorded response is matched against the page text. A value that was on the page is *observed*, with the snippet where it appeared. Matching understands formatted numbers, currencies, percentages and dates (see [Locale-aware matching](#locale-aware-matching)). Only fields observed in every baseline are kept.
3. **Mutate.** For each stable test, up to `--budget` mutants (default 20) are planned over its observed fields, chosen with a seeded random generator: every observed field gets one mutant before any field gets a second, and operators rotate. Each round gives every test its next mutant and runs the specs that have one, with one `cypress.run` per round. When a test did not run in its round because an earlier test or hook failed (Cypress then skips the rest of the suite), its mutant is tried again in a later round, and on the third attempt with no other mutant in that spec.
4. **Confirm.** Every killed mutant runs once more, with the same retry rule. If the test passes this time, the verdict is `flaky` and the mutant leaves the score.

Operators:

| Field | Operators |
| --- | --- |
| number, numeric string (`"1450.00"`) | `num-shift` (integers move by at least 7 or 37%; decimals keep their precision; ratios between 0 and 1 move by 0.37), `set-null` |
| string | `str-reverse`, `str-empty`, `set-null` |
| ISO date or date-time | `date-shift` (+3 days, same format), `set-null` |
| array whose items hold an observed value | `array-drop-first`, `array-empty` |

Booleans, nulls, integers between -9 and 9, and strings shorter than 3 characters or without a letter or digit are *trivial* and never mutated.

When one test receives the same endpoint more than once (a refetch, polling, React StrictMode, two components asking for the same data) and a field has the same value every time, that field becomes one field for all those responses (shown as `#*`), and its mutant changes every one of them. Otherwise the second response would overwrite the mutation, or arrive after the assertions had passed.

### Sensitive keys

Keys matching `password|passwd|secret|token|authorization|cookie|api[_-]?key|session|credential|private[_-]?key|access[_-]?key|bearer|jwt|card[_-]?number`, or containing the word `ssn`, `otp`, `cvv`, `cvc` or `pin` (`userSSN`, `otp_code`; not `classname` or `pinned`), are *sensitive*, in any case and anywhere in the path. In the browser, before anything is recorded:

- their values in the response body are replaced with `"[redacted]"`;
- their string values of 4 or more characters, and numbers of 6 or more digits, found in the responses recorded during the same test, are replaced with `[redacted]` in that test's page text, in any case, so they cannot reach the report through the snippet of a neighbouring field. A non-sensitive field with the same value as a sensitive one is then not observed;
- the query string, which can carry tokens, is dropped from every recorded URL.

Sensitive fields are never mutated and never shown. A sensitive value that the app displays in another form (masked, split, reformatted) is not recognized and stays in the page text.

## Quickstart

Install it as a dev dependency next to Cypress (15 or 16). Until it is on npm, install it from a checkout:

```bash
cd /path/to/e2e-mutants
npm install
npm pack
cd /path/to/your-project
npm install --save-dev /path/to/e2e-mutants/e2e-mutants-0.1.0.tgz
```

In the Cypress config, call `setupE2eMutants` in `setupNodeEvents` and return what it returns:

```ts
import { defineConfig } from 'cypress';
import { setupE2eMutants } from 'e2e-mutants';

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000',
    setupNodeEvents(on, config) {
      on('task', { seedDatabase: () => null });
      return setupE2eMutants(on, config);
    }
  }
});
```

Your own `on('task', …)` registrations keep working before or after it: Cypress merges task objects (checked on 16.3.0). If another plugin also returns a changed config, chain them: `return setupE2eMutants(on, otherPlugin(on, config))`. That also works when the other plugin is async and returns a promise: `setupE2eMutants` then returns a promise of the config.

In the support file (`cypress/support/e2e.ts`):

```ts
import 'e2e-mutants/support';
```

Then run:

```bash
npx e2e-mutants run --spec cypress/e2e/orders.cy.ts
```

It prints progress and Cypress's own output to stderr, only the summary to stdout, and writes `e2e-mutants-report/e2e-mutants.html` and `e2e-mutants-report/e2e-mutants.json`. Scripts should read the JSON.

### Normal runs are not affected

`setupE2eMutants` always registers its three tasks, but it enables the support code only when the CLI started the run: it reads the `E2E_MUTANTS_SESSION` environment variable, and only then sets `expose.e2eMutants = true` in the config it returns (`env.e2eMutants` on Cypress versions without `expose`, before 15.10). The support file checks that flag once when it loads. Without the flag it registers no hooks, no intercept and no listener, so `cypress run` and `cypress open` behave as if the package were not there. It never calls `Cypress.env()` on a version that has `Cypress.expose()`, so it works with `allowCypressEnv: false`.

This was checked on Cypress 16.3.0: in a plain run the flag was undefined, `cy.state('routes')` was empty and no task or route entries appeared in the command log; in a session run the flag was `true` and one `**` middleware route was registered. Cypress 15.21.2 was checked with `allowCypressEnv: false`, and 15.7.0 (which has no `Cypress.expose`) through the `env` fallback.

During a session, every test registers that route, including tests without a mutant in the current round, so that all rounds see the network the same way (see [HTTP caching](#http-caching)).

## CLI

```
e2e-mutants run [options]
e2e-mutants report <e2e-mutants.json> [--out <file>]
e2e-mutants --help | --version
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--spec <path\|glob>` | all specs | Spec to include, relative to `--project`. Repeat it, or separate specs with commas as with the Cypress CLI (commas inside `{…}` globs are kept). |
| `--project <dir>` | current directory | Cypress project. `cypress` is loaded from here (it is a peer dependency, never bundled). |
| `--config-file <path>` | Cypress default | Config file, relative to `--project`. |
| `--budget <n>` | 20 | Maximum mutants per test. |
| `--seed <n>` | 1 | Seed for choosing mutants. Same seed and same observations give the same plan. |
| `--baselines <n>` | 2 | Unmutated recording runs. |
| `--browser <name>` | `electron` | Browser for `cypress.run`. |
| `--out <dir>` | `e2e-mutants-report` | Report directory, relative to the current directory. |
| `--min-score <0-1>` | none | Exit with code 1 when the score is lower, or when nothing could be scored. |
| `--time-zone <zone>` | none | Extra IANA time zone for matching date-times (see [Locale-aware matching](#locale-aware-matching)). Repeat for more. |
| `--keep-session` | off | Keep the session directory (see [Privacy](#privacy)). |

Exit codes: `0` finished, `1` score below `--min-score`, `2` usage error or runner error (Cypress not found, a baseline that could not run or ran no tests, no recordings, a spec that failed to load or threw outside a test, a round whose `cypress.run` failed). The report is still written when a round fails. Stopped by a signal: 128 plus the signal number (`130` for Ctrl+C, `143` for SIGTERM).

`e2e-mutants report` renders the HTML again from a saved JSON report. It refuses files that are not complete e2e-mutants reports.

Each round runs `cypress.run` in a child process, with `quiet: true`, `reporter: 'base'` (silent), and `video: false`, `screenshotOnRunFailure: false`, `retries: 0`. Your own reporter does not run during e2e-mutants runs. The child's environment has no `ELECTRON_RUN_AS_NODE`, because Cypress dies with exit code 132 and no output when that variable leaks in from a VS Code terminal. On Ctrl+C or SIGTERM (also when sent only to the CLI's process, as `timeout` and some CI systems do), the CLI passes the signal to that child's process group, waits for Cypress to exit (15 seconds at most, then it kills it; a second signal kills it at once), deletes the session directory and exits.

## Verdicts and the score

| Verdict | Meaning | In the score |
| --- | --- | --- |
| `killed` | The test failed with the mutation applied, and failed again on the confirm run. | yes |
| `survived` | The test passed with the mutation applied. | yes |
| `killed-crash` | The test failed and the app threw an uncaught exception during it: either Cypress failed the test with it ("The following error originated from your application code"), or the support file saw it although your own `uncaught:exception` handler swallowed it. Swallowed errors that also happened in the baselines, and `ResizeObserver loop` warnings, do not count. The app broke, not an assertion. | no, reported apart |
| `flaky` | Killed, then passed on the confirm run. | no |
| `not-applied` | The targeted response (endpoint and occurrence) did not arrive during the test, the value no longer fit the operator, another intercept replaced the mutated response or put the original value back before the page got it, or the mutated response had not reached the page when the test ended. | no |
| `error` | Cypress could not run the round, or the test did not run in three attempts (see [How it works](#how-it-works)). | no |

**Score = killed ÷ (killed + survived).** It is computed per run, per spec, per test, per endpoint and per field.

The score is **per test**: a mutant belongs to one test and is applied only in that test. A focused test on a dashboard (say, one that checks the greeting) also displays the KPIs and the order table, so mutants of those fields survive in it even when another test checks them. That is what "a green test that displays data without checking it" means, but it makes focused suites score lower than they deserve.

The **By field** table in the report gives the suite-level view. For each field (endpoint plus JSON path, with array indexes generalized) it shows in how many stable tests the field was shown, in how many it got a mutant, and in how many a mutant was killed. A field killed in at least one test is checked somewhere in the suite. A field mutated in every test that showed it and never killed is checked nowhere. A field shown in more tests than it was mutated in may be checked in the others: the budget is a sample, and when a test shows more observed fields than `--budget`, some fields get no mutant in that test, possibly the ones it asserts. Fields that were shown but never mutated are listed with no score. Raise `--budget` to at least the number of observed fields (the report shows it per test) to give each field one mutant in each test.

Tests that did not pass in every baseline are listed apart and not mutated: `unstable` (passed in some baselines), `failing` (failed in all of them), `not-run`, and `duplicate` (another test in the same spec has the same title path, so their results cannot be told apart; the CLI also prints a warning).

## Locale-aware matching

Text is normalized first (NBSP, narrow NBSP and thin spaces become spaces; whitespace collapses; strings compare case-insensitively with Unicode word boundaries, so `Ana` does not match inside `Banana`).

- **Numbers.** `1,450.5`, `1.450,5`, `1450.5` and `1450,5` are all read, with every plausible meaning when a separator is ambiguous. A value matches when it equals a reading of the token within the rounding of the decimals shown, so `128450.5` matches `R$ 128.450,50` and `1450` matches `1.450`, but not `14500` or `21450`. Currency marks (`R$`, `US$`, `$`, `€`, `BRL`, `USD`, `EUR`) and `%` are understood; `0.0425` matches `4,25%`. Numbers inside dates and times are ignored, and so are digits that follow a letter or are joined by a hyphen (`ORD-1001` is a string, not the number 1001).
- **Dates.** ISO strings in the JSON (`2026-11-10`, `2026-11-12T09:30:00Z`) match the calendar date shown as `10/11/2026` or `11/10/2026` (both orders), `2026-11-10`, `10 de novembro de 2026`, `10 de noviembre de 2026`, `Nov 10, 2026` or `10 Nov 2026`, with full and short month names in English, Portuguese and Spanish. Date-times match their literal date, their UTC date, their date in the browser's time zone, and their date in every `--time-zone` you pass. Pass the zone your app formats in when it is not the browser's: an app that shows `2026-11-12T01:30:00Z` as `11/11/2026` in `America/Sao_Paulo` is matched only with `--time-zone America/Sao_Paulo` when the browser runs in Europe.
- **Long strings** (over 200 characters) match on their first 60.

When a value appears in more than one place on the page, the snippet is the first place, and the report says how many places there were (up to 10). The first place can belong to another field: a survivor's snippet may show text that its test does check, next to the place that it does not.

Not matched, so never mutated:

- space-grouped thousands (`12 345,50` in fr-FR and pt-PT), apostrophe grouping (`128'450.50` in de-CH and fr-CH), Indian grouping (`1,28,450.50`), compact numbers (`128 mil`, `12K`) and non-ASCII digits;
- amounts stored in cents (`145000` shown as `R$ 1.450,00`) and timestamps stored as epoch numbers;
- dates shown without a year (`10/11`, `10 de nov.`);
- values the app transforms before display (an enum `"paid"` shown as `Pago`).

Coincidences count as observed: a number of 10 or more, or a string of 3 or more characters, that also appears elsewhere on the page. Short enum values are the usual case (`"open"` in an `Open orders` heading, `"all"` in a `Show all` button), and so are digits of yearless dates and times such as `12h30` (the `12`) or `10/11` (the `10` and the `11`). Their mutants then survive in every test that shows that page.

## Privacy

The session directory (`<os tmpdir>/e2e-mutants-XXXXXX`, created with mode 700) holds the recorded response bodies and the page text of every test. Sensitive keys are already redacted in the browser (see [Sensitive keys](#sensitive-keys)), but everything else is raw. The CLI deletes it when it finishes, on Ctrl+C and on SIGTERM, unless you pass `--keep-session`. The Cypress plugin never creates the session directory itself, so a test that finishes after the CLI deleted it cannot write it back.

The report contains response data too: the value of every observed field with the page text around it, the first 60 characters of every unobserved or trivial non-sensitive value, the failure messages of killed mutants, and test titles. Treat `e2e-mutants.json` and `e2e-mutants.html` like the session directory, not like a coverage summary. For a test with more than 1000 fields that were not observed, only the first 1000 are listed in the report.

## Cost

Number of `cypress.run` calls = baselines + mutation rounds + confirm rounds.

- Mutation rounds: the largest number of mutants planned for one test (at most `--budget`), plus extra rounds when skipped tests are retried (an isolated retry also holds back the other tests of its spec for one round). In a spec that turns `testIsolation` off, mutants run one at a time (see [Limitations](#limitations)), so that spec needs as many rounds as it has mutants in all its tests.
- Confirm rounds: the largest number of `killed` mutants in one test, plus retries. `killed-crash` mutants are not confirmed.

Each round runs every test in the specs that have a mutant in that round; tests without a mutant in that round run unchanged. A killed mutant usually costs a failed assertion, so it waits for `defaultCommandTimeout`.

On the demo below (6 tests per spec, local server, Electron, Linux), the weak spec took 23 runs in 1 min 39 s and the strong spec 36 runs in 7 min 5 s. Most of the difference is the 4-second assertion timeout on each kill.

## Demo

`demo/` holds a small pt-BR orders dashboard (a zero-dependency Node server with four JSON endpoints, formatted with `Intl`: `R$ 128.450,50`, `4,25%`, `10/11/2026`) and two Cypress specs for the same flows:

- `weak.cy.js`: a smoke suite (visible, exists, row count greater than 0, panel visible).
- `strong.cy.js`: a thorough suite (exact formatted values, names, dates, statuses, row order, detail items and notes).

```bash
npm install
npm run demo:weak
npm run demo:strong
```

`demo/run-demo.mjs` starts the server on `PORT` (default 4517), runs the CLI on the spec and stops the server; extra arguments go to `e2e-mutants run`. Reports go to `e2e-mutants-report/weak` and `e2e-mutants-report/strong`. `npm run demo:server` starts only the server, for a plain `npx cypress run` inside `demo/`; run `npm run build` first, because the demo config imports the built package.

Results with `--budget 20 --seed 1` on Cypress 16.3.0 (complete stdout; only the report paths are shortened):

```
e2e-mutants 0.1.0  score 3.8%  (2 killed / 53 scored)
  killed 2  survived 51  killed-crash 7  flaky 0  not-applied 0  error 0
  tests 6: 6 stable, 0 unstable, 3 without observed data
  survived:
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[3].customer  set-null  "Diego Ferreira" -> null
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[2].id  str-empty  "ORD-1003" -> ""
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/me $.plan  str-empty  "Business" -> ""
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[3].total  num-shift  74.5 -> 109.2
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[4].id  str-reverse  "ORD-1005" -> "5001-DRO"
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/summary $.updatedAt  set-null  "2026-11-12T09:30:00Z" -> null
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[2].customer  set-null  "Carla Mendes" -> null
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[0].total  set-null  1450 -> null
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/orders $[0].id  str-reverse  "ORD-1001" -> "1001-DRO"
    cypress/e2e/weak.cy.js :: orders dashboard (smoke) > lists recent orders
      GET /api/summary $.conversionRate  set-null  0.0425 -> null
    … 41 more in the report
  rounds: 2 baseline, 20 mutation, 1 confirm; 1m 39s
  report: /path/to/e2e-mutants/e2e-mutants-report/weak/e2e-mutants.html
          /path/to/e2e-mutants/e2e-mutants-report/weak/e2e-mutants.json
```

```
e2e-mutants 0.1.0  score 36.9%  (41 killed / 111 scored)
  killed 41  survived 70  killed-crash 9  flaky 0  not-applied 0  error 0
  tests 6: 6 stable, 0 unstable, 0 without observed data
  survived:
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/summary $.conversionRate  set-null  0.0425 -> null
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[1].createdAt  date-shift  "2026-11-11" -> "2026-11-14"
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[0].customer  set-null  "Ana Souza" -> null
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[2].createdAt  set-null  "2026-11-08" -> null
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/summary $.updatedAt  date-shift  "2026-11-12T09:30:00Z" -> "2026-11-15T09:30:00Z"
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[4].customer  set-null  "Elisa Rocha" -> null
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/summary $.orders  num-shift  312 -> 427
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[2].id  set-null  "ORD-1003" -> null
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[3].createdAt  date-shift  "2026-11-05" -> "2026-11-08"
    cypress/e2e/strong.cy.js :: orders dashboard > greets the signed-in user with their plan
      GET /api/orders $[2].total  set-null  12780.35 -> null
    … 60 more in the report
  rounds: 2 baseline, 20 mutation, 14 confirm; 7m 5s
  report: /path/to/e2e-mutants/e2e-mutants-report/strong/e2e-mutants.html
          /path/to/e2e-mutants/e2e-mutants-report/strong/e2e-mutants.json
```

Three weak tests finish before any data has rendered, so nothing is observed in them. In the strong spec every survivor is a field the test displays but does not assert (the greeting test shows the order table, for example). In the By field table, 2 of the 17 weak fields were killed in at least one test, against 19 of the 23 strong ones. Two strong fields, `$.revenue` and `$.conversionRate`, were never killed: they were mutated in 3 of the 6 tests that showed them, and the budget sample never gave the KPI test, the one that asserts them, a mutant on either. The strong tests observed 27 to 40 fields each, so `--budget 40` would give every field a mutant in every test. The exact counts depend on timing: a test that ends before a response renders observes less, and a mutation that crashes the app counts as `killed-crash` when the crash lands inside a test and as `survived` when it lands after it.

## Validation

Does the score tell a weak suite from a strong one? On 2026-11-17 (UTC) both demo specs were run at seeds 1, 2 and 3, one run after another, with Cypress 16.3.0, its bundled Electron browser, Linux (WSL2), `--budget 20` and the other options at their defaults (2 baselines):

```bash
node demo/run-demo.mjs cypress/e2e/weak.cy.js --budget 20 --seed 1
node demo/run-demo.mjs cypress/e2e/strong.cy.js --budget 20 --seed 1
```

The same commands were run with `--seed 2` and `--seed 3`, each run with its own `--out` directory. Every number below comes from that run's `e2e-mutants.json`, except the run counts, which come from the summary on stdout. Wall time is `finishedAt` minus `startedAt`.

| Spec | Seed | Score | Killed | Survived | Killed-crash | Flaky | Not-applied | Error | Unstable tests | Runs (baseline + mutation + confirm) | Wall time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak | 1 | 3.8% (2 / 53) | 2 | 51 | 7 | 0 | 0 | 0 | 0 | 2 + 20 + 1 | 1m 39s |
| strong | 1 | 42.7% (47 / 110) | 47 | 63 | 8 | 0 | 0 | 0 | 0 | 2 + 20 + 14 | 7m 53s |
| weak | 2 | 1.9% (1 / 54) | 1 | 53 | 6 | 0 | 0 | 0 | 0 | 2 + 20 + 1 | 1m 31s |
| strong | 2 | 34.5% (39 / 113) | 39 | 74 | 7 | 0 | 0 | 0 | 0 | 2 + 20 + 15 | 7m 8s |
| weak | 3 | 1.9% (1 / 53) | 1 | 52 | 7 | 0 | 0 | 0 | 0 | 2 + 20 + 1 | 1m 31s |
| strong | 3 | 32.4% (36 / 111) | 36 | 75 | 9 | 0 | 0 | 0 | 0 | 2 + 20 + 15 | 6m 52s |

**Criterion:** at every seed, the strong score is higher than the weak score by at least 0.3, and no run has an `error` verdict or a runner error. **Result: passed.** All six runs exited with code 0.

| Seed | Weak | Strong | Margin |
| --- | --- | --- | --- |
| 1 | 0.038 | 0.427 | 0.390 |
| 2 | 0.019 | 0.345 | 0.327 |
| 3 | 0.019 | 0.324 | 0.305 |

Checked by hand as well:

- In the three strong runs, every mutant of a field that its test asserts (taken from the assertions in `strong.cy.js`) was killed: 48, 40 and 38 such mutants, of which 4 were `killed-crash` and none survived. No mutant got the `killed` verdict in a test that does not assert its field. The strong score is therefore the share of sampled mutants that landed on a field the test asserts.
- Suite level (the By field table): mutated fields that were killed in at least one test, weak 2 of 16, 1 of 17 and 1 of 16; strong 21 of 21, 19 of 20 and 16 of 19. The strong fields that were never killed (`$.conversionRate` at seed 2; `$.plan`, `$.orders` and `$.updatedAt` at seed 3) never got a mutant in the test that asserts them.
- After the runs, no session directory and no Cypress process were left.

Caveats:

- The demo is a toy made for this tool: one page, four endpoints, six tests per spec, values in formats the matcher reads, and a weak spec written to be weak. The numbers show that the score separates these two specs. They say nothing about what a real suite will score, and they are not targets.
- The strong scores are low in absolute terms because scoring is per test: each strong test shows the whole dashboard and asserts only its own part (see [Verdicts and the score](#verdicts-and-the-score)). The margin depends on how this demo is laid out.
- At seed 3 the margin was 0.305, just over the threshold. The strong tests usually observe 27 to 40 fields each, so a budget of 20 is a sample, and the strong score moved by about 10 points between seeds.
- The same seed does not always give the same result. At seed 1 the strong spec scored 42.7% here and 36.9% in the run shown under [Demo](#demo), with the same code 15 minutes earlier. In at least one baseline of this run, the page text of the KPI test had no order table (a short test can end before that response renders), so the test observed 8 fields instead of 27 (the greeting and KPI fields, the order list, and one order date that matches the KPI date by coincidence). Its 18 mutants then included 8 on the four KPI fields it asserts, and all 8 were killed. Observed fields depend on timing, and the plan depends on the observed fields.
- One machine, one night, Electron only. These six runs were not repeated on Chrome or on Cypress 15.

## User intercepts, aliases and stubs

e2e-mutants registers one `cy.intercept({ url: '**', middleware: true }, …)` per test, in a root `beforeEach`, and reads or changes bodies in `req.on('before:response')`. Middleware routes run before your routes. Checked with experiment specs on Cypress 16.3.0 (the first five rows also on 15.21.2), with a mutation on one response:

| Your intercept | Alias with `cy.wait` | What happens |
| --- | --- | --- |
| `cy.intercept('GET', '/api/orders').as('orders')` | resolves | The page and `interception.response.body` both show the mutated value. |
| `req.continue((res) => …)` that edits `res.body` | resolves | Your callback runs after the mutation and sees the mutated body. Edits you make there are kept on top of it (a callback that upper-cases the mutated value still shows a mutated value). If your callback puts the original value back, the mutant is `not-applied`. |
| `req.continue()` without a callback | resolves | Mutated. |
| `req.reply({ body })` | resolves | The stubbed body is recorded and mutated like a real one. |
| `cy.intercept('GET', '/api/orders', { body })` or `{ fixture }` | resolves | Same: the static stub is recorded and mutated. |
| `res.send(…)` in a `req.continue` callback or a `before:response` handler | resolves | Your `res.send` replaces the mutated body, so the page never sees the mutation. The support file notices (Cypress then skips the `response` event) and reports the mutant as `not-applied`. |

So stubbed suites are measured too: a test that renders a fixture and asserts its values kills those mutants. Mutating a stub tests whether the test checks the data it fed in, not whether the backend is right.

A `res.send` in a `response` handler of your own runs after e2e-mutants has checked the body, so that one is not noticed.

Cypress merges handler changes into the original response with lodash `merge`, so assigning a new array to `res.body` cannot shrink it (`res.body = []` leaves all items in place, checked on 16.3.0). e2e-mutants therefore edits the parsed body in place.

### HTTP caching

During a session, the route removes `If-None-Match` and `If-Modified-Since` from requests, and on JSON responses it sets `Cache-Control: no-store` and removes `ETag` and `Last-Modified`. Without that, a test could get a `304 Not Modified` with a cached body, which has nothing to record, or a body that an earlier test mutated (the browser cache is not cleared between tests). So during e2e-mutants runs your app gets no HTTP caching of JSON responses.

## Limitations

- Only JSON over HTTP that `cy.intercept` sees: bodies with an `application/*json` content type, or bodies that parse as a JSON object or array. No WebSocket, SignalR, GraphQL subscriptions or server-sent events. Responses for documents, scripts, stylesheets, images, fonts, WebSocket upgrades and manifests are skipped, as are requests with `Accept: text/event-stream`. Every other response is buffered by Cypress while the session runs, which can slow down large downloads.
- Requests made before the root `beforeEach` (for example in a `before()` hook, or in an earlier test when `testIsolation` is off) are not recorded for the tests that use them.
- With `testIsolation: false`, the page stays from one test to the next, so a mutation in one test would still be on the page in the following ones. e2e-mutants detects this (`Cypress.config('testIsolation')` in each test) and runs the mutants of such a spec one at a time, which costs more rounds.
- Responses are told apart by endpoint (method plus path, with numeric, UUID and 24-hex segments generalized; the query string dropped) and by arrival order. Two concurrent calls to the same endpoint with different bodies can arrive in a different order in another run, and the mutation then hits the other one. A field whose value changes between repeated responses (a counter that polling updates) stays one field per response, and a mutation of an early response can be overwritten by a later one.
- The page text is read when the page unloads and when the test ends. Text that appears and disappears in between is not seen. Neither is text in hidden elements, closed shadow roots, canvas, attributes (`title`, `aria-label`, `placeholder`), iframes, or password inputs. `innerText` includes the text of every option of a `<select>`, selected or not. Cypress's `about:blank` page between tests is skipped.
- An application error that happens after the test body, while e2e-mutants sends its results, is ignored so it cannot fail the next tests. A mutation that crashes the app counts as `killed-crash` when the test fails, and as `survived` when the test passes anyway (for example because the crash lands after a short test has finished). An error that the app catches and shows as a message is not a crash.
- A failure in a `beforeEach` or `afterEach` hook makes Cypress skip the remaining tests of that suite. e2e-mutants retries the skipped tests' mutants in later rounds, which adds rounds.
- Tests are identified by spec path and title path. Tests with the same title path in one spec are listed as `duplicate` and not mutated.
- Untested: Windows and macOS, `cy.origin`, component testing, browsers other than Electron and one short Chrome run, and Cypress versions other than 15.7.0, 15.21.2 and 16.3.0. Cypress 16 deprecates Electron as a test browser; `--browser chrome` works when Chrome is installed.

## Related tools

- [apophasis](https://www.npmjs.com/package/apophasis) and the playwright-mutation-gate approach ([DEV post](https://dev.to/dubcrab/your-green-tests-are-lying-5h5m)) mutate the tests: they invert assertions in Playwright specs and check that the inverted assertion fails. That finds assertions that cannot fail; it does not find data that is shown but never asserted.
- [@chaos-maker/core](https://chaos-maker-dev.github.io/chaos-maker/) injects network, WebSocket, SSE and UI faults into end-to-end tests (it has a Cypress adapter) to check resilience. It changes what the app receives, but it does not score whether a test noticed.
- [Stryker](https://stryker-mutator.io/) mutates application source code, mostly against unit tests. It asks whether the tests notice a change in the code, not whether an end-to-end test checks the data it shows.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
```

Node 20 or later. No runtime dependencies. `cypress` is a peer dependency (`>=15 <17`).

## License

MIT © Marcelo Costa
