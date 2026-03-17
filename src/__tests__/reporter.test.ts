import { renderReport } from '../reporter'
import { FlakyReport } from '../types'

function makeMockOctokit() {
  const createComment = jest.fn().mockResolvedValue({})
  const updateComment = jest.fn().mockResolvedValue({})
  const listComments  = jest.fn().mockResolvedValue({ data: [] })
  return {
    issues: { createComment, updateComment, listComments },
    _mocks: { createComment, updateComment, listComments },
  } as any
}

function makeContext(prNumber: number) {
  return {
    repo: { owner: 'acme', repo: 'backend' },
    payload: { pull_request: { number: prNumber } },
  } as any
}

const emptyReport: FlakyReport = {
  flaky: [], stable: ['build', 'lint'], newFlaky: [], improved: [], totalAnalyzed: 2,
}

const flakyReport: FlakyReport = {
  flaky: [{
    jobName: 'integration-tests',
    stepName: 'Run tests',
    failureRate: 0.375,
    occurrences: 8,
    avgDurationMs: 45000,
    durationCV: 0.12,
    lastFailedAt: '2026-03-10T14:30:00Z',
    pattern: 'intermittent',
    suggestedFix: 'Add retry logic (max 2) on this job.',
  }],
  stable: ['build'],
  newFlaky: [],
  improved: [],
  totalAnalyzed: 2,
}

describe('renderReport', () => {
  it('does nothing when not on a PR', async () => {
    const octokit = makeMockOctokit()
    const ctx = { repo: { owner: 'a', repo: 'b' }, payload: {} } as any
    await renderReport(octokit, ctx, emptyReport)
    expect(octokit._mocks.createComment).not.toHaveBeenCalled()
  })

  it('creates a comment on first run', async () => {
    const octokit = makeMockOctokit()
    await renderReport(octokit, makeContext(42), flakyReport)
    expect(octokit._mocks.createComment).toHaveBeenCalledTimes(1)
    const body = octokit._mocks.createComment.mock.calls[0][0].body as string
    expect(body).toContain('flaky-finder')
    expect(body).toContain('integration-tests')
  })

  it('updates existing comment instead of creating new one', async () => {
    const octokit = makeMockOctokit()
    octokit.issues.listComments = jest.fn().mockResolvedValue({
      data: [{ id: 99, body: '<!-- flaky-finder -->\nold content' }],
    })
    await renderReport(octokit, makeContext(42), flakyReport)
    expect(octokit._mocks.createComment).not.toHaveBeenCalled()
    expect(octokit._mocks.updateComment).toHaveBeenCalledTimes(1)
    expect(octokit._mocks.updateComment.mock.calls[0][0].comment_id).toBe(99)
  })

  it('shows no-flaky message when report is clean', async () => {
    const octokit = makeMockOctokit()
    await renderReport(octokit, makeContext(7), emptyReport)
    const body = octokit._mocks.createComment.mock.calls[0][0].body as string
    expect(body).toContain('No flaky jobs detected')
  })
})
