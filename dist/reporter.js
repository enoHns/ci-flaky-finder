"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderReport = renderReport;
const COMMENT_TAG = '<!-- flaky-finder -->';
async function renderReport(octokit, ctx, report) {
    if (!ctx.payload.pull_request)
        return;
    const body = buildComment(report);
    const { owner, repo } = ctx.repo;
    const prNumber = ctx.payload.pull_request.number;
    // Update existing comment or create new one
    const { data: comments } = await octokit.issues.listComments({
        owner, repo, issue_number: prNumber,
    });
    const existing = comments.find(c => c.body?.includes(COMMENT_TAG));
    if (existing) {
        await octokit.issues.updateComment({
            owner, repo, comment_id: existing.id, body,
        });
    }
    else {
        await octokit.issues.createComment({
            owner, repo, issue_number: prNumber, body,
        });
    }
}
function buildComment(report) {
    const lines = [COMMENT_TAG];
    lines.push('## 🎲 flaky-finder report\n');
    if (report.flaky.length === 0) {
        lines.push('✅ **No flaky jobs detected** across the last analyzed runs.\n');
    }
    else {
        lines.push(`⚠️ **${report.flaky.length} flaky job(s) detected** — ${report.totalAnalyzed} jobs analyzed\n`);
        if (report.newFlaky.length > 0) {
            lines.push(`> 🆕 ${report.newFlaky.length} newly appeared this run\n`);
        }
        lines.push('| Job | Pattern | Failure rate | CV | Hint |');
        lines.push('|-----|---------|-------------|-----|------|');
        const shortHint = {
            'intermittent': 'Add retries, check race conditions',
            'slow-degrading': 'Memory leak or growing fixtures',
            'time-dependent': 'Mock shared resources',
            'resource-sensitive': 'Upsize runner or parallelize',
        };
        for (const t of report.flaky) {
            const rate = `${(t.failureRate * 100).toFixed(0)}%`;
            const cv = t.durationCV > 0 ? `${(t.durationCV * 100).toFixed(0)}%` : '—';
            lines.push(`| \`${t.jobName}\` | ${t.pattern} | ${rate} | ${cv} | ${shortHint[t.pattern] ?? t.pattern} |`);
        }
        lines.push('');
        lines.push('<details><summary>Details per job</summary>\n');
        for (const t of report.flaky) {
            lines.push(formatJobDetail(t));
        }
        lines.push('</details>');
    }
    if (report.improved.length > 0) {
        lines.push(`\n<details><summary>📈 Improved — no longer flaky (${report.improved.length})</summary>\n`);
        lines.push(report.improved.map(s => `- \`${s}\``).join('\n'));
        lines.push('</details>');
    }
    if (report.stable.length > 0) {
        lines.push(`\n<details><summary>✅ Stable jobs (${report.stable.length})</summary>\n`);
        lines.push(report.stable.map(s => `- \`${s}\``).join('\n'));
        lines.push('</details>');
    }
    return lines.join('\n');
}
function formatJobDetail(t) {
    const lines = [
        `### \`${t.jobName}\``,
        `- **Step**: \`${t.stepName}\``,
        `- **Failure rate**: ${(t.failureRate * 100).toFixed(1)}% over ${t.occurrences} runs`,
        `- **Duration CV**: ${(t.durationCV * 100).toFixed(1)}%`,
        `- **Last failed**: ${t.lastFailedAt || 'unknown'}`,
        `- **Pattern**: \`${t.pattern}\``,
        `- **Fix**: ${t.suggestedFix}`,
        '',
    ];
    return lines.join('\n');
}
