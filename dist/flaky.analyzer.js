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
exports.isTimeDependentPattern = isTimeDependentPattern;
const core = __importStar(require("@actions/core"));
const math_1 = require("./math");
const MIN_RUNS = 5;
async function detectFlaky(octokit, owner, repo, runs, aiToken, aiModel = 'gpt-4o-mini', aiEndpoint = 'https://models.inference.ai.azure.com/chat/completions') {
    core.info(`Analyzing ${runs.length} workflow runs...`);
    const jobHistories = new Map();
    const fetchJobs = async (run) => {
        try {
            const { data } = await octokit.actions.listJobsForWorkflowRun({
                owner, repo, run_id: run.id,
            });
            for (const job of data.jobs) {
                if (!jobHistories.has(job.name))
                    jobHistories.set(job.name, []);
                jobHistories.get(job.name).push({
                    runId: run.id,
                    jobId: job.id,
                    conclusion: job.conclusion ?? 'unknown',
                    startedAt: job.started_at ?? '',
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
    };
    const batchSize = 5;
    for (let i = 0; i < runs.length; i += batchSize) {
        await Promise.all(runs.slice(i, i + batchSize).map(fetchJobs));
        if (i + batchSize < runs.length)
            await new Promise(r => setTimeout(r, 1000));
    }
    for (const [, history] of jobHistories.entries()) {
        history.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    }
    const stable = [];
    const improved = [];
    const newFlakyNames = new Set();
    const candidates = [];
    for (const [jobName, history] of jobHistories.entries()) {
        if (history.length < MIN_RUNS)
            continue;
        // Split into recent and older halves (history[0] = newest)
        const mid = Math.ceil(history.length / 2);
        const recent = history.slice(0, mid);
        const older = history.slice(mid);
        const recentFails = recent.filter(r => r.conclusion === 'failure').length;
        const olderFails = older.filter(r => r.conclusion === 'failure').length;
        const recentFailRate = recentFails / recent.length;
        const olderFailRate = olderFails / older.length;
        const durations = history.map(r => r.durationMs).filter(d => d > 0);
        const durationCV = durations.length > 1 ? (0, math_1.coefficientOfVariation)(durations) : 0;
        if (olderFailRate > 0.05 && recentFails === 0 && older.length >= 3) {
            improved.push(jobName);
            continue;
        }
        // Consistently failing in recent runs → broken, not flaky
        if (recentFailRate >= 0.85)
            continue;
        const isNondeterministic = recentFailRate > 0.05;
        const isTimingUnstable = durationCV > 0.40 && recentFailRate < 0.85;
        if (isNondeterministic || isTimingUnstable) {
            if (olderFails === 0 && older.length >= 3)
                newFlakyNames.add(jobName);
            const pattern = detectPattern(history, recentFailRate, durationCV);
            const stepName = findFlakyStep(history);
            const lastFailed = history
                .filter(r => r.conclusion === 'failure')
                .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
            candidates.push({
                jobName,
                stepName,
                failureRate: recentFailRate,
                occurrences: history.length,
                avgDurationMs: (0, math_1.average)(durations),
                durationCV,
                lastFailed,
                pattern,
                templateFix: buildSuggestedFix(pattern, history, recentFailRate, durationCV, stepName, recent.length),
            });
        }
        else if (recentFailRate === 0) {
            stable.push(jobName);
        }
    }
    const suggestedFixes = await Promise.all(candidates.map(c => aiToken && c.lastFailed
        ? getAiSuggestedFix(octokit, owner, repo, aiToken, c.lastFailed.jobId, c.templateFix, c.pattern, c.stepName, aiModel, aiEndpoint)
        : Promise.resolve(c.templateFix)));
    const flaky = candidates.map((c, i) => ({
        jobName: c.jobName,
        stepName: c.stepName,
        failureRate: c.failureRate,
        occurrences: c.occurrences,
        avgDurationMs: c.avgDurationMs,
        durationCV: c.durationCV,
        lastFailedAt: c.lastFailed?.startedAt ?? '',
        pattern: c.pattern,
        suggestedFix: suggestedFixes[i],
    }));
    flaky.sort((a, b) => b.failureRate - a.failureRate);
    core.info(`  ${flaky.length} flaky, ${improved.length} improved, ${stable.length} stable (${jobHistories.size} jobs total)`);
    return {
        flaky,
        stable,
        improved,
        newFlaky: flaky.filter(f => newFlakyNames.has(f.jobName)),
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
function isTimeDependentPattern(failTimestamps) {
    if (failTimestamps.length < 4)
        return false;
    const dates = new Set(failTimestamps.map(ts => ts.slice(0, 10)));
    if (dates.size < 2)
        return false;
    const failHours = failTimestamps.map(ts => new Date(ts).getUTCHours());
    const hourCounts = new Array(24).fill(0);
    for (const h of failHours)
        hourCounts[h]++;
    if (Math.max(...hourCounts) < 2)
        return false;
    // top 3 hours cover >= 60% of failures
    const top3 = [...hourCounts].sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    return top3 / failHours.length >= 0.6;
}
function detectPattern(history, // newest first
recentFailRate, durationCV) {
    const failTimestamps = history
        .filter(r => r.conclusion === 'failure')
        .map(r => r.startedAt);
    if (isTimeDependentPattern(failTimestamps))
        return 'time-dependent';
    const durationsChron = [...history].reverse().map(r => r.durationMs);
    const r = (0, math_1.pearsonCorrelation)(durationsChron);
    if (r > 0.8 && durationCV > 0.2)
        return 'slow-degrading';
    if (durationCV > 0.4)
        return 'resource-sensitive';
    return 'intermittent';
}
function buildSuggestedFix(pattern, history, recentFailRate, durationCV, stepName, recentCount) {
    switch (pattern) {
        case 'time-dependent': {
            const failHours = history
                .filter(r => r.conclusion === 'failure')
                .map(r => new Date(r.startedAt).getUTCHours());
            const counts = new Array(24).fill(0);
            for (const h of failHours)
                counts[h]++;
            const topHours = [...counts.entries()]
                .filter(([, c]) => c > 0)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([h]) => `${String(h).padStart(2, '0')}h UTC`)
                .join(', ');
            return `Failures cluster at ${topHours}. Shared resource under load at those hours — mock external calls or isolate the test environment.`;
        }
        case 'slow-degrading': {
            const durChron = [...history].reverse().map(r => r.durationMs).filter(d => d > 0);
            const oldestS = Math.round(durChron[0] / 1000);
            const newestS = Math.round(durChron[durChron.length - 1] / 1000);
            const growthPct = oldestS > 0 ? Math.round((newestS - oldestS) / oldestS * 100) : 0;
            return `Duration grew from ~${oldestS}s to ~${newestS}s (+${growthPct}% over ${history.length} runs). Profile step "${stepName}" for memory leaks or growing test fixtures.`;
        }
        case 'resource-sensitive': {
            const durs = history.map(r => r.durationMs).filter(d => d > 0);
            const minS = Math.round(Math.min(...durs) / 1000);
            const maxS = Math.round(Math.max(...durs) / 1000);
            const cvPct = Math.round(durationCV * 100);
            return `Duration swings between ${minS}s and ${maxS}s (CV ${cvPct}%). Runner contention — pin to a dedicated runner or split into parallel shards.`;
        }
        case 'intermittent': {
            const failCount = Math.round(recentFailRate * recentCount);
            return `Failed ${failCount}/${recentCount} recent runs (${Math.round(recentFailRate * 100)}%). Step "${stepName}" is the culprit. Add retry logic (max 2) and check for race conditions or shared state.`;
        }
    }
}
async function getAiSuggestedFix(octokit, owner, repo, token, jobId, templateFix, pattern, stepName, model, endpoint) {
    try {
        const logsResp = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { owner, repo, job_id: jobId });
        const raw = typeof logsResp.data === 'string' ? logsResp.data : '';
        const logs = raw.slice(-3000).trim();
        if (!logs)
            return templateFix;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a CI/CD expert. Given job failure logs and a detected flakiness pattern, provide a specific actionable fix in 1-2 sentences. Reference exact error messages, filenames, or tools visible in the logs. No markdown, no bullet points.',
                        },
                        {
                            role: 'user',
                            content: `Flakiness pattern: ${pattern}\nFlaky step: ${stepName}\n\nJob failure logs (last 3000 chars):\n${logs}\n\nProvide a specific fix:`,
                        },
                    ],
                    max_tokens: 200,
                    temperature: 0.2,
                }),
                signal: controller.signal,
            });
            if (!resp.ok)
                return templateFix;
            const data = await resp.json();
            return data.choices?.[0]?.message?.content?.trim() || templateFix;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    catch {
        return templateFix;
    }
}
