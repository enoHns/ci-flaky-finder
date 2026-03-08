import { detectFlaky } from '../flaky.analyzer'

function makeRun(id: number, conclusion: string, startedAt: string, durationMs = 30000) {
  const completedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString()
  return {
    id,
    conclusion,
    startedAt,
    completedAt,
    durationMs,
    steps: [
      { name: 'Run tests', conclusion, durationMs },
    ],
  }
}

function makeMockOctokit(histories: Record<string, ReturnType<typeof makeRun>[]>) {
  return {
    actions: {
      listJobsForWorkflowRun: jest.fn().mockImplementation(({ run_id }: { run_id: number }) => {
        const jobs = Object.entries(histories).map(([name, runs]) => {
          const run = runs.find(r => r.id === run_id)
          if (!run) return null
          return {
            name,
            conclusion:   run.conclusion,
            started_at:   run.startedAt,
            completed_at: run.completedAt,
            steps: run.steps.map(s => ({
              name:         s.name,
              conclusion:   s.conclusion,
              started_at:   run.startedAt,
              completed_at: new Date(new Date(run.startedAt).getTime() + s.durationMs).toISOString(),
            })),
          }
        }).filter(Boolean)
        return Promise.resolve({ data: { jobs } })
      }),
    },
  } as any
}

describe('detectFlaky', () => {
  const base = '2026-03-01T10:00:00Z'
  const hour = 3600000

  it('returns empty report when all jobs are stable', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      conclusion: 'success',
      started_at: new Date(new Date(base).getTime() + i * hour).toISOString(),
      completed_at: new Date(new Date(base).getTime() + i * hour + 30000).toISOString(),
    }))
    const octokit = makeMockOctokit({
      'build': Array.from({ length: 5 }, (_, i) =>
        makeRun(i + 1, 'success', new Date(new Date(base).getTime() + i * hour).toISOString())
      ),
    })
    const report = await detectFlaky(octokit, 'owner', 'repo', runs)
    expect(report.flaky).toHaveLength(0)
    expect(report.stable).toContain('build')
  })

  it('detects intermittent job', async () => {
    const runs = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      conclusion: i % 3 === 0 ? 'failure' : 'success',
      started_at: new Date(new Date(base).getTime() + i * hour).toISOString(),
      completed_at: new Date(new Date(base).getTime() + i * hour + 30000).toISOString(),
    }))
    const octokit = makeMockOctokit({
      'test': Array.from({ length: 8 }, (_, i) =>
        makeRun(i + 1, i % 3 === 0 ? 'failure' : 'success',
          new Date(new Date(base).getTime() + i * hour).toISOString())
      ),
    })
    const report = await detectFlaky(octokit, 'owner', 'repo', runs)
    expect(report.flaky.length).toBeGreaterThan(0)
    expect(report.flaky[0].jobName).toBe('test')
    expect(report.flaky[0].pattern).toBe('intermittent')
  })

  it('skips jobs with fewer than 3 data points', async () => {
    const runs = Array.from({ length: 2 }, (_, i) => ({
      id: i + 1,
      conclusion: 'failure',
      started_at: new Date(new Date(base).getTime() + i * hour).toISOString(),
      completed_at: new Date(new Date(base).getTime() + i * hour + 1000).toISOString(),
    }))
    const octokit = makeMockOctokit({
      'lint': Array.from({ length: 2 }, (_, i) =>
        makeRun(i + 1, 'failure', new Date(new Date(base).getTime() + i * hour).toISOString())
      ),
    })
    const report = await detectFlaky(octokit, 'owner', 'repo', runs)
    expect(report.flaky).toHaveLength(0)
  })
})
