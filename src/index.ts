import * as core   from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'
import { detectFlaky } from './flaky.analyzer'
import { renderReport } from './reporter'

async function run(): Promise<void> {
  try {
    const token      = core.getInput('github-token', { required: true })
    const lookback   = parseInt(core.getInput('lookback-runs') || '30')
    const postComment = core.getBooleanInput('post-comment')
    const failOnFlaky = core.getBooleanInput('fail-on-flaky')
    const aiEnabled   = core.getBooleanInput('ai-suggestions')
    const aiToken     = aiEnabled ? (core.getInput('ai-token') || token) : undefined
    const aiModel     = core.getInput('ai-model') || 'gpt-4o-mini'
    const aiEndpoint  = core.getInput('ai-endpoint') || 'https://models.inference.ai.azure.com/chat/completions'

    const octokit = new Octokit({ auth: token })
    const ctx     = github.context
    const { owner, repo } = ctx.repo

    // GITHUB_WORKFLOW_REF = "owner/repo/.github/workflows/ci.yml@refs/heads/main"
    const workflowRef     = process.env.GITHUB_WORKFLOW_REF ?? ''
    const detectedWorkflow = workflowRef.split('@')[0].split('/').pop() ?? ''
    const workflow         = core.getInput('workflow') || detectedWorkflow

    core.info(`flaky-finder — ${owner}/${repo}, workflow: ${workflow || 'all'}, lookback: ${lookback}`)

    let runs: any[] = []
    let page = 1
    while (runs.length < lookback) {
      const perPage = Math.min(lookback - runs.length, 100)
      let batch: any[]
      if (workflow) {
        const { data } = await octokit.actions.listWorkflowRuns({
          owner, repo, workflow_id: workflow, per_page: perPage, page, status: 'completed',
        })
        batch = data.workflow_runs
      } else {
        const { data } = await octokit.actions.listWorkflowRunsForRepo({
          owner, repo, per_page: perPage, page, status: 'completed',
        })
        batch = data.workflow_runs
      }
      runs = runs.concat(batch)
      if (batch.length < perPage) break
      page++
    }

    const report = await detectFlaky(octokit, owner, repo, runs, aiToken, aiModel, aiEndpoint)

    core.setOutput('flaky-count', report.flaky.length)

    if (postComment && ctx.payload.pull_request) {
      await renderReport(octokit, ctx, report)
      core.info('PR comment posted')
    }

    if (failOnFlaky && report.flaky.length > 0) {
      core.setFailed(`${report.flaky.length} flaky job(s) detected: ${report.flaky.map(f => f.jobName).join(', ')}`)
      return
    }

    core.info(`Done — ${report.flaky.length} flaky job(s) found`)

  } catch (err) {
    core.setFailed(`flaky-finder failed: ${(err as Error).message}`)
  }
}

run()
