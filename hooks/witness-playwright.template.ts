/**
 * The Witness fixture for Playwright. Generated into the tool's hooks folder on
 * every check and never imported by a spec: the worker hook
 * (witness-playwright-loader.mjs) answers each spec's import of
 * __PACKAGE__ with this file, which re-exports the package whole and
 * replaces `test` with one that reports, per test, the lines it reached,
 * the decisions it took, and the functions it entered. A spec keeps its
 * ordinary import and the tool never edits a test.
 *
 * Each test runs in its own page, so the page's counters at the end of the
 * test are that test's attribution, and the page is reset afterwards in case
 * a project shares one. Only the page is measured: a function a test calls
 * in Node rather than in the page is not counted.
 *
 * A recorded run carries the boundary recorder's observations out of the
 * page the same way, because a page has no disk either. It reads the test
 * identity from here rather than from the counter runtime, which a recorded
 * run does not load.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as base } from '__PACKAGE__';

export * from '__PACKAGE__';

export const test = base.extend<{ witness: void }>({
  witness: [
    async ({ page }, use, testInfo) => {
      const id = `${path.relative(process.cwd(), testInfo.file).split(path.sep).join('/')}::${testInfo.titlePath.slice(1).join(' > ')}`;
      const boundaryDir = process.env.WITNESS_BOUNDARY_DIR;
      await use();
      if (boundaryDir) {
        const carried = await page
          .evaluate(() => {
            const b = (window as unknown as { __witnessBoundary__?: { drain(): unknown[] } }).__witnessBoundary__;
            return b && b.drain ? b.drain() : [];
          })
          .catch(() => []);
        if (carried.length > 0) {
          // The identity is stamped here rather than inside the page.
          //
          // There is no per-test hook in a component-testing page: the runner
          // navigates it while its own fixtures are setting up, which is
          // before anything this fixture could add would take effect, so an
          // init script arrives too late and every record comes back with no
          // test on it. Draining is the moment the identity is known for
          // certain, because Playwright gives each test its own page and the
          // test that is draining is the test that made these records.
          const stamped = carried.map((r) => (r && typeof r === 'object' && 'target' in r ? { ...(r as Record<string, unknown>), test: id } : r));
          fs.appendFileSync(path.join(boundaryDir, `boundary-pw-${process.pid}.jsonl`), `${stamped.map((r) => JSON.stringify(r)).join('\n')}\n`);
        }
      }
      const dir = process.env.WITNESS_ATTRIBUTION_DIR;
      if (!dir) {
        return;
      }
      const out = await page
        .evaluate((testId) => {
          const w = (window as unknown as { __witness__?: { begin(id: string): void; end(): unknown; snapshot(): unknown; reset(): void } }).__witness__;
          if (!w) {
            return null;
          }
          const coverage = w.snapshot();
          w.reset();
          return { coverage, testId };
        }, id)
        .catch(() => null);
      // A test whose page never loaded the runtime (it mounted nothing, or the
      // page was gone) still leaves a record, with no coverage in it. The
      // driver counts records against tests; a missing record reads as
      // attribution that was cut off, and this test's was not.
      const record = out ?? { testId: id, coverage: {} };
      fs.appendFileSync(path.join(dir, `coverage-pw-${process.pid}.pwcov`), `${JSON.stringify({ test: record.testId, coverage: record.coverage })}\n`);
    },
    { auto: true },
  ],
});
