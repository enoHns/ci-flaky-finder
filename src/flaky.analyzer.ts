import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { FlakyReport, FlakyTest, JobRun } from './types'

export async function detectFlaky(
  octokit: Octokit,
  owner: string,
  repo: string,
  runs: any[],
): Promise<FlakyReport> {

  core.info('Analyzing flaky tests...')

  const recentRuns = runs.slice(0, 20)
  const jobHistories: Map<string, JobRun[]> = new Map()

  for (const run of recentRuns) {
    try {
      const { data } = await octokit.actions.listJobsForWorkflowRun({
        owner, repo, run_id: run.id,
      })
      for (const job of data.jobs) {
        if (!jobHistories.has(job.name)) jobHistories.set(job.name, [])
        jobHistories.get(job.name)!.push({
          runId:       run.id,
          conclusion:  job.conclusion ?? 'unknown',
          startedAt:   job.started_at,
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
        })
      }
    } catch {
      // run inaccessible
    }
  }

  const flaky: FlakyTest[] = []
  const stable: string[]   = []

  for (const [jobName, history] of jobHistories.entries()) {
    if (history.length < 3) continue

    const failures    = history.filter(r => r.conclusion === 'failure').length
    const failureRate = failures / history.length

    if (failureRate > 0.05 && failureRate < 0.85) {
      flaky.push({
        jobName,
        stepName:     'unknown',
        failureRate,
        occurrences:  history.length,
        avgDurationMs: 0,
        durationCV:   0,
        lastFailedAt: '',
        pattern:      'intermittent',
        suggestedFix: 'Add retry logic on this job.',
      })
    } else if (failureRate === 0) {
      stable.push(jobName)
    }
  }

  return { flaky, stable, newFlaky: [], improved: [], totalAnalyzed: jobHistories.size }
}
