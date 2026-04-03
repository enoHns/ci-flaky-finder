"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectFlaky = detectFlaky;
const core = __importStar(require("@actions/core"));
const math_1 = require("./math");
async function detectFlaky(octokit, owner, repo, runs) {
    core.info('Analyzing flaky tests...');
    const recentRuns = runs.slice(0, 20);
    const jobHistories = new Map();
    await Promise.all(recentRuns.map(async (run) => {
        try {
            const { data } = await octokit.actions.listJobsForWorkflowRun({
                owner, repo, run_id: run.id,
            });
            for (const job of data.jobs) {
                if (!jobHistories.has(job.name))
                    jobHistories.set(job.name, []);
                jobHistories.get(job.name).push({
                    runId: run.id,
                    conclusion: job.conclusion ?? 'unknown',
                    startedAt: job.started_at,
                    completedAt: job.completed_at,
                    durationMs: job.completed_at && job.started_at
                        ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
                        : 0,
                    steps: job.steps?.map((s) => ({
                        name: s.name,
                        conclusion: s.conclusion ?? 'unknown',
                        durationMs: s.completed_at && s.started_at
                            ? new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()
                            : 0,
                    })) ?? [],
                });
            }
        }
        catch {
            // run inaccessible — skip
        }
    }));
    const flaky = [];
    const stable = [];
    for (const [jobName, history] of jobHistories.entries()) {
        if (history.length < 3)
            continue;
        const failures = history.filter(r => r.conclusion === 'failure').length;
        const failureRate = failures / history.length;
        const durations = history.map(r => r.durationMs).filter(d => d > 0);
        const durationCV = durations.length > 1 ? (0, math_1.coefficientOfVariation)(durations) : 0;
        // A job that always fails is broken, not flaky — don't report as flaky
        const isNondeterministic = failureRate > 0.05 && failureRate < 0.85;
        const isTimingUnstable = durationCV > 0.40 && failureRate < 0.85;
        if (isNondeterministic || isTimingUnstable) {
            const pattern = detectPattern(history, failureRate, durationCV);
            const lastFailed = history
                .filter(r => r.conclusion === 'failure')
                .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
            flaky.push({
                jobName,
                stepName: findFlakyStep(history),
                failureRate,
                occurrences: history.length,
                avgDurationMs: (0, math_1.average)(durations),
                durationCV,
                lastFailedAt: lastFailed?.startedAt ?? '',
                pattern,
                suggestedFix: getSuggestedFix(pattern),
            });
        }
        else if (failureRate === 0) {
            stable.push(jobName);
        }
    }
    flaky.sort((a, b) => b.failureRate - a.failureRate);
    core.info(`  Found ${flaky.length} flaky jobs out of ${jobHistories.size} analyzed`);
    return {
        flaky,
        stable,
        newFlaky: flaky.filter(f => f.occurrences <= 3),
        improved: [],
        totalAnalyzed: jobHistories.size,
    };
}
function findFlakyStep(history) {
    const stepFailures = new Map();
    const stepTotal = new Map();
    for (const run of history) {
        for (const step of run.steps) {
            stepTotal.set(step.name, (stepTotal.get(step.name) ?? 0) + 1);
            if (step.conclusion === 'failure') {
                stepFailures.set(step.name, (stepFailures.get(step.name) ?? 0) + 1);
            }
        }
    }
    let worstStep = 'unknown';
    let worstRate = 0;
    for (const [name, total] of stepTotal.entries()) {
        const fails = stepFailures.get(name) ?? 0;
        const rate = fails / total;
        if (rate > 0.05 && rate < 0.85 && rate > worstRate) {
            worstRate = rate;
            worstStep = name;
        }
    }
    return worstStep;
}
function detectPattern(history, failureRate, durationCV) {
    const failHours = history
        .filter(r => r.conclusion === 'failure')
        .map(r => new Date(r.startedAt).getUTCHours());
    if (failHours.length >= 3 && new Set(failHours).size <= 3)
        return 'time-dependent';
    const durations = history.map(r => r.durationMs);
    const trend = (0, math_1.linearTrend)(durations);
    if (trend > 0.3 && durationCV > 0.2)
        return 'slow-degrading';
    if (durationCV > 0.4)
        return 'resource-sensitive';
    return 'intermittent';
}
function getSuggestedFix(pattern) {
    const fixes = {
        'intermittent': 'Add retry logic (max 2) on this job. Check for race conditions, network calls without timeouts, or shared state between tests.',
        'slow-degrading': 'Job is getting slower over time. Likely a memory leak, growing test fixtures, or missing cache invalidation. Profile the slowest test suite.',
        'time-dependent': 'Failures cluster at specific hours — likely a shared resource (DB, external API) under load. Consider mocking external calls or adding test isolation.',
        'resource-sensitive': 'Execution time is highly variable — suggests resource contention on the runner. Consider pinning to a larger runner or parallelizing test suites.',
    };
    return fixes[pattern];
}
