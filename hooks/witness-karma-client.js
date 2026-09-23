/**
 * Witness inside the Karma browser. Served as a classic script after Jasmine
 * and before any spec, by the framework half of witness-karma.cjs.
 *
 * There is no disk here, and there is no loader. Both are already answered by
 * the runtime: an instrumented file carries its own maps and registers them on
 * the shared global as it evaluates (embedMaps), and `end()` returns the
 * record instead of appending it when it cannot see a filesystem. So this file
 * is only the boundary and the wire: begin before each spec, end after it, and
 * hand what comes back to the Karma server through `__karma__.info`, which the
 * reporter half writes out unchanged.
 *
 * Nothing is mapped or diffed here, which is the whole difference from the
 * Istanbul client this replaces. That one snapshotted `window.__coverage__`
 * around every spec, diffed the statement counters, shipped each file's
 * statementMap and inputSourceMap, and remapped compiled positions back to
 * source on the Node side. Witness instruments the source before Angular
 * builds it, so the lines in the record are already the lines in the person's
 * editor and there is nothing left to undo.
 *
 * Plain ES5 on purpose: it runs in whatever browser the project tests in, and
 * it must never throw into the code it is measuring.
 */
(function () {
  var karma = window.__karma__;
  if (!karma || typeof jasmine === 'undefined') {
    return;
  }

  function witness() {
    return window.__witness__;
  }

  function specFile(result) {
    // Jasmine 4+ reports the file a spec was defined in. Through Karma that is
    // a URL; through the Angular builder it is the bundle the spec was built
    // into. Either way the tail after /base/ is what the driver can recognise,
    // and a spec with no filename at all is still a test, so it is not dropped.
    var name = result && result.filename ? String(result.filename) : '';
    var m = /\/base\/(.*?)(\?.*)?$/.exec(name);
    return m ? m[1] : name || '?';
  }

  jasmine.getEnv().addReporter({
    specStarted: function (result) {
      try {
        var w = witness();
        if (w) {
          w.begin(specFile(result) + '::' + (result.fullName || '?'));
        }
      } catch (e) {
        // Never fail the user's tests over attribution.
      }
    },
    specDone: function () {
      try {
        var w = witness();
        var record = w && w.end();
        if (record) {
          karma.info({ witness: { record: record } });
        }
      } catch (e) {
        // Never fail the user's tests over attribution.
      }
      try {
        // A recorded run: the boundary runtime held its observations because
        // there is no disk in a page. They go back over the same wire, and
        // the reporter writes them where every other runner writes them.
        var b = window.__witnessBoundary__;
        var carried = b && b.drain ? b.drain() : [];
        if (carried.length) {
          karma.info({ witness: { boundary: carried } });
        }
      } catch (e) {
        // Never fail the user's tests over a recording.
      }
    },
    jasmineDone: function () {
      try {
        var w = witness();
        if (w) {
          karma.info({ witness: { coverage: w.snapshot() } });
        }
      } catch (e) {
        // Never fail the user's tests over attribution.
      }
    },
  });
})();
