import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { FlakyReport, FlakyTest, JobRun } from './types'
import { average, coefficientOfVariation, pearsonCorrelation } from './math'

const MIN_RUNS = 5

export async function detectFlaky(
  octokit: Octokit,
  owner: string,
  repo: string,
  runs: any[],
  aiToken?: string,
  aiModel = 'gpt-4o-mini',
  aiEndpoint = 'https://models.inference.ai.azure.com/chat/completions',
): Promise<FlakyReport> {

  core.info(`Analyzing ${runs.length} workflow runs...`)

  const jobHistories: Map<string, JobRun[]> = new Map()

  const fetchJobs = async (run: any) => {
    try {
      const { data } = await octokit.actions.listJobsForWorkflowRun({
        owner, repo, run_id: run.id,
      })
      for (const job of data.jobs) {
        if (!jobHistories.has(job.name)) jobHistories.set(job.name, [])
        jobHistories.get(job.name)!.push({
          runId:       run.id,
          jobId:       job.id,
          conclusion:  job.conclusion ?? 'unknown',
          startedAt:   job.started_at ?? '',
          completedAt: job.completed_at,
          durationMs:  job.completed_at && job.started_at
            ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
            : 0,
          steps: job.steps?.map((s: any) => ({
            name:       s.name,
            conclusion: s.conclusion ?? 'unknown',
            durationMs: s.completed_at && s.started_at
              ? new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()
              : 0,
          })) ?? [],
          runnerName: job.runner_name ?? undefined,
        })
      }
    } catch {
      // run inaccessible — skip
    }
  }

  const batchSize = 5
  for (let i = 0; i < runs.length; i += batchSize) {
    await Promise.all(runs.slice(i, i + batchSize).map(fetchJobs))
    if (i + batchSize < runs.length) await new Promise(r => setTimeout(r, 1000))
  }

  for (const [, history] of jobHistories.entries()) {
    history.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
  }

  const stable: string[]   = []
  const improved: string[] = []
  const newFlakyNames      = new Set<string>()
  const candidates: Array<{
    jobName:       string
    stepName:      string
    failureRate:   number
    occurrences:   number
    avgDurationMs: number
    durationCV:    number
    lastFailed:    JobRun | undefined
    pattern:       FlakyTest['pattern']
    templateFix:   string
  }> = []

  for (const [jobName, history] of jobHistories.entries()) {
    if (history.length < MIN_RUNS) continue

    // Split into recent and older halves (history[0] = newest)
    const mid    = Math.ceil(history.length / 2)
    const recent = history.slice(0, mid)
    const older  = history.slice(mid)

    const recentFails    = recent.filter(r => r.conclusion === 'failure').length
    const olderFails     = older.filter(r => r.conclusion === 'failure').length
    const recentFailRate = recentFails / recent.length
    const olderFailRate  = olderFails  / older.length

    const durations  = history.map(r => r.durationMs).filter(d => d > 0)
    const durationCV = durations.length > 1 ? coefficientOfVariation(durations) : 0

    if (olderFailRate > 0.05 && recentFails === 0 && older.length >= 3) {
      improved.push(jobName)
      continue
    }

    // Consistently failing in recent runs → broken, not flaky
    if (recentFailRate >= 0.85) continue

    const isNondeterministic = recentFailRate > 0.05
    const isTimingUnstable   = durationCV > 0.40 && recentFailRate < 0.85

    if (isNondeterministic || isTimingUnstable) {
      if (olderFails === 0 && older.length >= 3) newFlakyNames.add(jobName)

      const pattern    = detectPattern(history, recentFailRate, durationCV)
      const stepName   = findFlakyStep(history)
      const lastFailed = history
        .filter(r => r.conclusion === 'failure')
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0]

      candidates.push({
        jobName,
        stepName,
        failureRate:   recentFailRate,
        occurrences:   history.length,
        avgDurationMs: average(durations),
        durationCV,
        lastFailed,
        pattern,
        templateFix: buildSuggestedFix(pattern, history, recentFailRate, durationCV, stepName, recent.length),
      })
    } else if (recentFailRate === 0) {
      stable.push(jobName)
    }
  }

  const suggestedFixes = await Promise.all(
    candidates.map(c =>
      aiToken && c.lastFailed
        ? getAiSuggestedFix(octokit, owner, repo, aiToken, c.lastFailed.jobId, c.templateFix, c.pattern, c.stepName, aiModel, aiEndpoint)
        : Promise.resolve(c.templateFix)
    )
  )

  const flaky: FlakyTest[] = candidates.map((c, i) => ({
    jobName:       c.jobName,
    stepName:      c.stepName,
    failureRate:   c.failureRate,
    occurrences:   c.occurrences,
    avgDurationMs: c.avgDurationMs,
    durationCV:    c.durationCV,
    lastFailedAt:  c.lastFailed?.startedAt ?? '',
    pattern:       c.pattern,
    suggestedFix:  suggestedFixes[i],
  }))

  flaky.sort((a, b) => b.failureRate - a.failureRate)
  core.info(`  ${flaky.length} flaky, ${improved.length} improved, ${stable.length} stable (${jobHistories.size} jobs total)`)

  return {
    flaky,
    stable,
    improved,
    newFlaky: flaky.filter(f => newFlakyNames.has(f.jobName)),
    totalAnalyzed: jobHistories.size,
  }
}

function findFlakyStep(history: JobRun[]): string {
  const stepFailures: Map<string, number> = new Map()
  const stepTotal:    Map<string, number> = new Map()

  for (const run of history) {
    for (const step of run.steps) {
      stepTotal.set(step.name, (stepTotal.get(step.name) ?? 0) + 1)
      if (step.conclusion === 'failure') {
        stepFailures.set(step.name, (stepFailures.get(step.name) ?? 0) + 1)
      }
    }
  }

  let worstStep = 'unknown'
  let worstRate = 0

  for (const [name, total] of stepTotal.entries()) {
    const fails = stepFailures.get(name) ?? 0
    const rate  = fails / total
    if (rate > 0.05 && rate < 0.85 && rate > worstRate) {
      worstRate = rate
      worstStep = name
    }
  }

  return worstStep
}

export function isRunnerDependentPattern(history: JobRun[]): boolean {
  const runsWithRunner = history.filter(r => r.runnerName)
  if (runsWithRunner.length < MIN_RUNS) return false

  const failsByRunner = new Map<string, number>()
  const totalByRunner = new Map<string, number>()
  for (const run of runsWithRunner) {
    const name = run.runnerName!
    totalByRunner.set(name, (totalByRunner.get(name) ?? 0) + 1)
    if (run.conclusion === 'failure') {
      failsByRunner.set(name, (failsByRunner.get(name) ?? 0) + 1)
    }
  }

  if (totalByRunner.size < 2) return false

  for (const [runner, fails] of failsByRunner.entries()) {
    const total = totalByRunner.get(runner)!
    if (total >= 3 && fails / total > 0.6) return true
  }
  return false
}

export function isTimeDependentPattern(failTimestamps: string[]): boolean {
  if (failTimestamps.length < 4) return false
  const dates = new Set(failTimestamps.map(ts => ts.slice(0, 10)))
  if (dates.size < 2) return false
  const failHours = failTimestamps.map(ts => new Date(ts).getUTCHours())
  const hourCounts = new Array(24).fill(0)
  for (const h of failHours) hourCounts[h]++
  if (Math.max(...hourCounts) < 2) return false
  // top 3 hours cover >= 60% of failures
  const top3 = [...hourCounts].sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0)
  return top3 / failHours.length >= 0.6
}

function detectPattern(
  history: JobRun[],  // newest first
  recentFailRate: number,
  durationCV: number,
): FlakyTest['pattern'] {
  if (isRunnerDependentPattern(history)) return 'runner-dependent'

  const failTimestamps = history
    .filter(r => r.conclusion === 'failure')
    .map(r => r.startedAt)

  if (isTimeDependentPattern(failTimestamps)) return 'time-dependent'

  const durationsChron = [...history].reverse().map(r => r.durationMs)
  const r = pearsonCorrelation(durationsChron)
  if (r > 0.8 && durationCV > 0.2) return 'slow-degrading'

  if (durationCV > 0.4) return 'resource-sensitive'
  return 'intermittent'
}

function buildSuggestedFix(
  pattern:        FlakyTest['pattern'],
  history:        JobRun[],
  recentFailRate: number,
  durationCV:     number,
  stepName:       string,
  recentCount:    number,
): string {
  switch (pattern) {
    case 'runner-dependent': {
      const failsByRunner = new Map<string, number>()
      const totalByRunner = new Map<string, number>()
      for (const run of history) {
        if (!run.runnerName) continue
        totalByRunner.set(run.runnerName, (totalByRunner.get(run.runnerName) ?? 0) + 1)
        if (run.conclusion === 'failure') {
          failsByRunner.set(run.runnerName, (failsByRunner.get(run.runnerName) ?? 0) + 1)
        }
      }
      let worstRunner = 'unknown'
      let worstRate = 0
      for (const [runner, fails] of failsByRunner.entries()) {
        const rate = fails / totalByRunner.get(runner)!
        if (rate > worstRate) { worstRate = rate; worstRunner = runner }
      }
      const worstPct = Math.round(worstRate * 100)
      return `${worstPct}% failures on runner "${worstRunner}". Failures are tied to this specific runner (missing tools, no registry/Nexus access, wrong environment). Pin the job with \`runs-on: [self-hosted, <required-tag>]\` or fix the runner configuration.`
    }
    case 'time-dependent': {
      const failHours = history
        .filter(r => r.conclusion === 'failure')
        .map(r => new Date(r.startedAt).getUTCHours())
      const counts = new Array(24).fill(0)
      for (const h of failHours) counts[h]++
      const topHours = [...counts.entries()]
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([h]) => `${String(h).padStart(2, '0')}h UTC`)
        .join(', ')
      return `Failures cluster at ${topHours}. Shared resource under load at those hours — mock external calls or isolate the test environment.`
    }
    case 'slow-degrading': {
      const durChron = [...history].reverse().map(r => r.durationMs).filter(d => d > 0)
      const oldestS  = Math.round(durChron[0] / 1000)
      const newestS  = Math.round(durChron[durChron.length - 1] / 1000)
      const growthPct = oldestS > 0 ? Math.round((newestS - oldestS) / oldestS * 100) : 0
      return `Duration grew from ~${oldestS}s to ~${newestS}s (+${growthPct}% over ${history.length} runs). Profile step "${stepName}" for memory leaks or growing test fixtures.`
    }
    case 'resource-sensitive': {
      const durs = history.map(r => r.durationMs).filter(d => d > 0)
      const minS  = Math.round(Math.min(...durs) / 1000)
      const maxS  = Math.round(Math.max(...durs) / 1000)
      const cvPct = Math.round(durationCV * 100)
      return `Duration swings between ${minS}s and ${maxS}s (CV ${cvPct}%). Runner contention — pin to a dedicated runner or split into parallel shards.`
    }
    case 'intermittent': {
      const failCount = Math.round(recentFailRate * recentCount)
      return `Failed ${failCount}/${recentCount} recent runs (${Math.round(recentFailRate * 100)}%). Step "${stepName}" is the culprit. Add retry logic (max 2) and check for race conditions or shared state.`
    }
  }
}
async function getAiSuggestedFix(
  octokit: Octokit,
  owner: string,
  repo: string,
  token: string,
  jobId: number,
  templateFix: string,
  pattern: string,
  stepName: string,
  model: string,
  endpoint: string,
): Promise<string> {
  try {
    const logsResp = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      { owner, repo, job_id: jobId },
    )
    const raw  = typeof logsResp.data === 'string' ? logsResp.data : ''
    const logs = raw.slice(-3000).trim()
    if (!logs) return templateFix

    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), 10_000)
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
      })
      if (!resp.ok) return templateFix
      const data = await resp.json() as { choices: { message: { content: string } }[] }
      return data.choices?.[0]?.message?.content?.trim() || templateFix
    } finally {
      clearTimeout(timeoutId)
    }
  } catch {
    return templateFix
  }
}