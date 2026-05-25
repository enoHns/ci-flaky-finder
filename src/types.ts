export interface FlakyTest {
  jobName:      string
  stepName:     string
  failureRate:  number
  occurrences:  number
  avgDurationMs: number
  durationCV:   number
  lastFailedAt: string
  pattern:      'intermittent' | 'slow-degrading' | 'time-dependent' | 'resource-sensitive' | 'runner-dependent'
  suggestedFix: string
}

export interface FlakyReport {
  flaky:         FlakyTest[]
  stable:        string[]
  newFlaky:      FlakyTest[]
  improved:      string[]
  totalAnalyzed: number
}

export interface JobRun {
  runId:        number
  jobId:        number
  conclusion:   string
  startedAt:    string
  completedAt:  string | null
  durationMs:   number
  steps:        { name: string; conclusion: string; durationMs: number }[]
  runnerName?:  string
}
