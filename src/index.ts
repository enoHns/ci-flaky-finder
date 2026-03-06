import * as core   from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'
import { detectFlaky } from './flaky.analyzer'
import { renderReport } from './reporter'

async function run(): Promise<void> {
  try {
    const token       = core.getInput('github-token', { required: true })
    const lookback    = parseInt(core.getInput('lookback-runs') || '30')
    const postComment = core.getBooleanInput('post-comment')

    const octokit = new Octokit({ auth: token })
    const ctx     = github.context
    const { owner, repo } = ctx.repo

    core.info(`flaky-finder — ${owner}/${repo}, lookback: ${lookback} runs`)

    const { data: runsData } = await octokit.actions.listWorkflowRunsForRepo({
      owner, repo,
      per_page: Math.min(lookback, 100),
      status: 'completed',
    })

    const report = await detectFlaky(octokit, owner, repo, runsData.workflow_runs)

    core.setOutput('flaky-count', report.flaky.length)

    if (postComment && ctx.payload.pull_request) {
      await renderReport(octokit, ctx, report)
      core.info('PR comment posted')
    }

    core.info(`Done — ${report.flaky.length} flaky job(s) found`)

  } catch (err) {
    core.setFailed(`flaky-finder failed: ${(err as Error).message}`)
  }
}

run()
