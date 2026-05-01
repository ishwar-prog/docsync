'use strict';

const core = require('@actions/core');

/**
 * ACTIONS SUMMARY REPORTER
 *
 * GitHub Actions has a "Job Summary" feature — a rich Markdown page
 * that appears in the Actions run UI after the job completes.
 * It is separate from the log output and persists permanently.
 *
 * This is significantly better UX than log-only output:
 * - Rendered as a formatted page, not raw text
 * - Accessible from the Actions tab without digging through logs
 * - Can include tables, badges, and links
 * - Linked directly from PR checks
 *
 * We write the drift report here so developers can see a beautiful
 * summary of what DocSync found, directly in the GitHub UI.
 */

const reporter = {
  /**
   * Writes the job summary to the GitHub Actions summary page.
   *
   * @param {object} params
   * @param {'in_sync'|'drift_detected'} params.status
   * @param {DriftReport} params.driftReport
   * @param {number} params.pullNumber
   * @param {PullRequest|null} params.companionPR
   * @param {GenerationSummary|null} params.generationSummary
   */
  async writeSummary({ status, driftReport, pullNumber, companionPR, generationSummary }) {
    const summary = core.summary;

    if (status === 'in_sync') {
      summary
        .addHeading('✅ DocSync — Documentation In Sync', 2)
        .addRaw(`No documentation drift detected in PR #${pullNumber}.\n\n`)
        .addTable([
          [{ data: 'Metric', header: true }, { data: 'Value', header: true }],
          ['Drift Score', '0/100'],
          ['Status', '✅ Docs In Sync'],
        ]);
    } else {
      const scoreBar = '█'.repeat(Math.round(driftReport.driftScore / 10)) +
                       '░'.repeat(10 - Math.round(driftReport.driftScore / 10));

      summary.addHeading('⚠️ DocSync — Documentation Drift Detected', 2);

      summary.addTable([
        [{ data: 'Metric', header: true }, { data: 'Value', header: true }],
        ['Drift Score', `${scoreBar} ${driftReport.driftScore}/100`],
        ['Files Affected', String(driftReport.summary.filesAffected)],
        ['Total Changes', String(driftReport.summary.totalChanges)],
        ['Companion PR', companionPR ? `#${companionPR.number}` : 'Not created'],
      ]);

      if (driftReport.files.length > 0) {
        summary.addHeading('Affected Files', 3);

        const tableData = [
          [
            { data: 'File', header: true },
            { data: 'Drift Score', header: true },
            { data: 'Changes', header: true },
          ],
          ...driftReport.files.map(f => [
            f.fileKey.split('/').slice(-2).join('/'),
            `${f.driftScore}/100`,
            String(f.changes.length),
          ]),
        ];

        summary.addTable(tableData);
      }

      if (generationSummary) {
        summary.addHeading('AI Documentation Generation', 3);
        summary.addTable([
          [{ data: 'Metric', header: true }, { data: 'Value', header: true }],
          ['Files Documented', String(generationSummary.filesProcessed)],
          ['Input Tokens', String(generationSummary.totalInputTokens)],
          ['Output Tokens', String(generationSummary.totalOutputTokens)],
          ['Cost', `$${generationSummary.estimatedCostUSD}`],
        ]);
      }

      if (companionPR) {
        summary.addLink(
          `📄 View Companion PR #${companionPR.number}`,
          companionPR.html_url
        );
      }
    }

    summary.addSeparator();
    summary.addRaw('*Powered by [DocSync](https://github.com/ishwar-prog/docsync)*');

    try {
      await summary.write();
    } catch (error) {
      core.warning(`Failed to write summary: ${error.message}`);
    }
  },
};

module.exports = { reporter };