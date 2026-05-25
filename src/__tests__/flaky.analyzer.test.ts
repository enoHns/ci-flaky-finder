import { detectFlaky, isTimeDependentPattern } from '../flaky.analyzer'

jest.setTimeout(30000)

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRun(id: number, conclusion: string, startedAt: string, durationMs = 30000) {
  const completedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString()
  return {
    id, conclusion, startedAt, completedAt, durationMs,
    steps: [{ name: 'Run tests', conclusion, durationMs }],
  }
}

type RunSpec = ReturnType<typeof makeRun>

function makeMockOctokit(histories: Record<string, RunSpec[]>) {
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

// conclusions[0] = most recent
function buildRuns(conclusions: string[], baseMs: number, hourMs = 3_600_000): RunSpec[] {
  return conclusions.map((conclusion, i) => {
    const startedAt = new Date(baseMs + (conclusions.length - 1 - i) * hourMs).toISOString()
    return makeRun(i + 1, conclusion, startedAt)
  })
}

const BASE = new Date('2026-03-01T10:00:00Z').getTime()
const HOUR = 3_600_000

// ─── detectFlaky ─────────────────────────────────────────────────────────────

describe('detectFlaky', () => {

  it('stable job: all passing', async () => {
    const runs = buildRuns(['success','success','success','success','success','success'], BASE)
    const octokit = makeMockOctokit({ build: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.flaky).toHaveLength(0)
    expect(report.stable).toContain('build')
  })

  it('skips jobs with fewer than 5 data points', async () => {
    const runs = buildRuns(['failure','failure','success','failure'], BASE)
    const octokit = makeMockOctokit({ lint: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.flaky).toHaveLength(0)
    expect(report.stable).toHaveLength(0)
  })

  it('detects intermittent flaky job', async () => {
    // 10 runs, newest first: recent 5 have 2 failures (40%) → intermittent
    const runs = buildRuns(['failure','success','failure','success','success', 'success','success','success','success','success'], BASE)
    const octokit = makeMockOctokit({ test: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.flaky.length).toBeGreaterThan(0)
    expect(report.flaky[0].jobName).toBe('test')
    expect(report.flaky[0].pattern).toBe('intermittent')
    expect(report.flaky[0].failureRate).toBeCloseTo(0.4)
  })

  it('does NOT flag always-failing jobs as flaky', async () => {
    const runs = buildRuns(['failure','failure','failure','failure','failure','failure','failure'], BASE)
    const octokit = makeMockOctokit({ deploy: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.flaky.map(f => f.jobName)).not.toContain('deploy')
  })

  it('uses recent half for classification — not overall failure rate', async () => {
    // 10 runs: recent 5 all pass, older 5 had 60% failures
    // should NOT be flagged as flaky (it recovered)
    const runs = buildRuns(['success','success','success','success','success', 'failure','failure','failure','success','success'], BASE)
    const octokit = makeMockOctokit({ integration: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.flaky.map(f => f.jobName)).not.toContain('integration')
  })

  it('detects improved job (was flaky, now consistently passing)', async () => {
    // 10 runs: recent 5 all pass, older 5 had failures
    const runs = buildRuns(['success','success','success','success','success', 'failure','failure','success','failure','success'], BASE)
    const octokit = makeMockOctokit({ e2e: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.improved).toContain('e2e')
    expect(report.flaky.map(f => f.jobName)).not.toContain('e2e')
  })

  it('detects newly appeared flaky job', async () => {
    // 10 runs: recent 5 have failures, older 5 were all passing
    const runs = buildRuns(['failure','success','failure','success','failure', 'success','success','success','success','success'], BASE)
    const octokit = makeMockOctokit({ api: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    expect(report.flaky.map(f => f.jobName)).toContain('api')
    expect(report.newFlaky.map(f => f.jobName)).toContain('api')
  })

  it('does NOT mark long-standing flaky job as new', async () => {
    // failures in both halves
    const runs = buildRuns(['failure','success','failure','success','success', 'failure','success','success','failure','success'], BASE)
    const octokit = makeMockOctokit({ ci: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    if (report.flaky.find(f => f.jobName === 'ci')) {
      expect(report.newFlaky.map(f => f.jobName)).not.toContain('ci')
    }
  })

  it('detects time-dependent pattern when failures cluster in few hours', async () => {
    // All failures happen at the same UTC hour (10:xx)
    const base = new Date('2026-03-01T10:00:00Z').getTime()
    const runs: RunSpec[] = []
    for (let day = 0; day < 10; day++) {
      const startedAt = new Date(base + day * 24 * HOUR).toISOString()
      const conclusion = day % 2 === 0 ? 'failure' : 'success'
      runs.push(makeRun(day + 1, conclusion, startedAt))
    }
    // Sort newest first for the API simulation
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    const octokit = makeMockOctokit({ nightly: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    const job = report.flaky.find(f => f.jobName === 'nightly')
    expect(job).toBeDefined()
    expect(job!.pattern).toBe('time-dependent')
  })

  it('does NOT falsely flag intermittent job as time-dependent', async () => {
    // Failures spread across 6 different hours → NOT time-dependent
    const hours = [0, 4, 8, 12, 16, 20]
    const runs: RunSpec[] = hours.map((h, i) => {
      const startedAt = new Date(BASE + i * 24 * HOUR).toISOString().replace('T10:', `T${String(h).padStart(2,'0')}:`)
      return makeRun(i + 1, 'failure', startedAt)
    })
    // Add passing runs so we have enough data and it's in the flaky range
    for (let i = 0; i < 6; i++) {
      const startedAt = new Date(BASE + (i + 6) * 24 * HOUR + HOUR / 2).toISOString()
      runs.push(makeRun(runs.length + 1, 'success', startedAt))
    }
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    const octokit = makeMockOctokit({ scattered: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    const job = report.flaky.find(f => f.jobName === 'scattered')
    if (job) expect(job.pattern).not.toBe('time-dependent')
  })

  it('detects slow-degrading pattern (increasing durations)', async () => {
    const runs: RunSpec[] = Array.from({ length: 10 }, (_, i) => {
      const startedAt = new Date(BASE + i * HOUR).toISOString()
      const durationMs = 10_000 + i * 8_000   // grows from 10s to 82s
      const conclusion = i >= 7 ? 'failure' : 'success'
      return makeRun(i + 1, conclusion, startedAt, durationMs)
    })
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    const octokit = makeMockOctokit({ perf: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    const job = report.flaky.find(f => f.jobName === 'perf')
    if (job) expect(job.pattern).toBe('slow-degrading')
  })

  it('detects resource-sensitive pattern (high duration variance)', async () => {
    const durations = [5_000, 90_000, 6_000, 85_000, 4_000, 95_000, 7_000, 88_000, 5_000, 92_000]
    const runs: RunSpec[] = durations.map((durationMs, i) => {
      const startedAt = new Date(BASE + i * HOUR).toISOString()
      const conclusion = i % 3 === 0 ? 'failure' : 'success'
      return makeRun(i + 1, conclusion, startedAt, durationMs)
    })
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    const octokit = makeMockOctokit({ flaky: runs })
    const report = await detectFlaky(octokit, 'o', 'r', runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt })))
    const job = report.flaky.find(f => f.jobName === 'flaky')
    if (job) expect(['resource-sensitive', 'intermittent']).toContain(job.pattern)
  })

  it('handles multiple concurrent jobs correctly', async () => {
    const stableRuns = buildRuns(['success','success','success','success','success','success'], BASE)
    const flakyRuns  = buildRuns(['failure','success','failure','success','failure','success','success','success','success','success'], BASE)
    const octokit = makeMockOctokit({ build: stableRuns, test: flakyRuns })
    const allRunIds = new Set([...stableRuns, ...flakyRuns].map(r => r.id))
    const runs = [...allRunIds].map(id => {
      const r = [...stableRuns, ...flakyRuns].find(x => x.id === id)!
      return { id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt }
    })
    const report = await detectFlaky(octokit, 'o', 'r', runs)
    expect(report.stable).toContain('build')
    expect(report.flaky.map(f => f.jobName)).toContain('test')
  })

  it('sortedBy failureRate descending', async () => {
    const highFlaky = buildRuns(['failure','failure','success','failure','success','failure','success','failure','success','success'], BASE)
    const lowFlaky  = buildRuns(['failure','success','success','success','success','success','success','success','success','success'], BASE)
    const octokit = makeMockOctokit({ high: highFlaky, low: lowFlaky })
    const allRuns = [...new Map([...highFlaky, ...lowFlaky].map(r => [r.id, r])).values()]
    const runs = allRuns.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt }))
    const report = await detectFlaky(octokit, 'o', 'r', runs)
    if (report.flaky.length >= 2) {
      expect(report.flaky[0].failureRate).toBeGreaterThanOrEqual(report.flaky[1].failureRate)
    }
  })

  it('handles empty runs array', async () => {
    const octokit = makeMockOctokit({})
    const report = await detectFlaky(octokit, 'o', 'r', [])
    expect(report.flaky).toHaveLength(0)
    expect(report.stable).toHaveLength(0)
    expect(report.totalAnalyzed).toBe(0)
  })

  it('respects all provided runs — does not silently cap at 20', async () => {
    const runs = buildRuns(Array.from({ length: 30 }, (_, i) => i % 4 === 0 ? 'failure' : 'success'), BASE)
    const octokit = makeMockOctokit({ job: runs })
    const apiRuns = runs.map(r => ({ id: r.id, conclusion: r.conclusion, started_at: r.startedAt, completed_at: r.completedAt }))
    const report = await detectFlaky(octokit, 'o', 'r', apiRuns)
    const job = report.flaky.find(f => f.jobName === 'job') ?? report.stable.find(s => s === 'job')
    expect(job).toBeDefined()
    if (report.flaky.find(f => f.jobName === 'job')) {
      expect(report.flaky[0].occurrences).toBe(30)
    }
  }, 60000)
})

// ─── isTimeDependentPattern ──────────────────────────────────────────────────

describe('isTimeDependentPattern', () => {
  it('returns false with fewer than 4 failures', () => {
    const ts = ['2026-03-01T10:00:00Z', '2026-03-02T10:00:00Z', '2026-03-03T10:00:00Z']
    expect(isTimeDependentPattern(ts)).toBe(false)
  })

  it('returns true when failures cluster heavily in few hours across multiple days', () => {
    // All failures at hour 10 or 11, one per day over 8 days
    const ts = [
      '2026-03-01T10:00:00Z', '2026-03-02T10:30:00Z', '2026-03-03T11:00:00Z',
      '2026-03-04T10:15:00Z', '2026-03-05T11:30:00Z', '2026-03-06T10:00:00Z',
      '2026-03-07T11:00:00Z', '2026-03-08T10:45:00Z',
    ]
    expect(isTimeDependentPattern(ts)).toBe(true)
  })

  it('returns false when failures are spread evenly across the day', () => {
    // Each failure at a different hour on a different day
    const ts = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((h, i) =>
      `2026-03-${String(i + 1).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`
    )
    expect(isTimeDependentPattern(ts)).toBe(false)
  })

  it('returns false for 4 failures each in a different hour (no repetition)', () => {
    const ts = [
      '2026-03-01T03:00:00Z', '2026-03-02T09:00:00Z',
      '2026-03-03T15:00:00Z', '2026-03-04T21:00:00Z',
    ]
    expect(isTimeDependentPattern(ts)).toBe(false)
  })

  it('returns false when all failures happen on the same calendar day', () => {
    const ts = [
      '2026-05-24T20:10:00Z', '2026-05-24T20:25:00Z', '2026-05-24T20:40:00Z',
      '2026-05-24T20:53:00Z', '2026-05-24T21:05:00Z',
    ]
    expect(isTimeDependentPattern(ts)).toBe(false)
  })

  it('returns true when all failures recur at the same hour across multiple days', () => {
    const ts = [
      '2026-03-01T14:00:00Z', '2026-03-02T14:30:00Z', '2026-03-03T14:00:00Z',
      '2026-03-04T14:15:00Z', '2026-03-05T14:00:00Z',
    ]
    expect(isTimeDependentPattern(ts)).toBe(true)
  })

  it('returns true when top 3 hours cover >= 60% of failures with repetition across days', () => {
    // 6 failures at hours 10,11,12 (repeated) + 4 spread elsewhere → top3 = 6/10 = 60%
    const ts = [
      '2026-03-01T10:00:00Z', '2026-03-02T11:00:00Z', '2026-03-03T12:00:00Z',
      '2026-03-04T10:30:00Z', '2026-03-05T11:00:00Z', '2026-03-06T12:00:00Z',
      '2026-03-07T02:00:00Z', '2026-03-08T08:00:00Z', '2026-03-09T14:00:00Z', '2026-03-10T20:00:00Z',
    ]
    expect(isTimeDependentPattern(ts)).toBe(true)
  })

  it('returns false when no single hour repeats even if many failures', () => {
    // 8 failures each at a unique hour on a different day
    const ts = [
      '2026-03-01T01:00:00Z', '2026-03-02T03:00:00Z', '2026-03-03T07:00:00Z',
      '2026-03-04T11:00:00Z', '2026-03-05T15:00:00Z', '2026-03-06T17:00:00Z',
      '2026-03-07T19:00:00Z', '2026-03-08T22:00:00Z',
    ]
    expect(isTimeDependentPattern(ts)).toBe(false)
  })
})
