# flaky-finder

[![CI](https://github.com/enoHns/flaky-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/enoHns/flaky-finder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Detect flaky tests in your GitHub Actions workflows — no setup, no config file, one step.

---

## What it does

**flaky-finder** analyzes your last N workflow runs and finds jobs that pass sometimes and fail others. For each flaky job it tells you:

- **Failure rate** — how often it fails
- **Pattern** — *intermittent*, *slow-degrading*, *time-dependent*, or *resource-sensitive*
- **Which step** inside the job is actually failing
- **A specific fix** for that pattern

Results land as a PR comment, updated on every push.

---

## Install

```yaml
# .github/workflows/ci.yml
- name: Check for flaky tests
  uses: enoHns/flaky-finder@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

That's it.

---

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github-token` | required | Token with `actions:read` + `pull-requests:write` |
| `lookback-runs` | `30` | Number of past runs to analyze (max 100) |
| `post-comment` | `true` | Post/update a PR comment with the report |

## Outputs

| Output | Description |
|--------|-------------|
| `flaky-count` | Number of flaky jobs detected |

---

## How it works

1. Fetches the last N workflow runs for your repo
2. For each job, computes failure rate and duration coefficient of variation
3. Classifies as flaky if: `5% < failure_rate < 85%` or `duration_cv > 40%`
4. Detects failure pattern using time clustering and linear trend analysis
5. Posts a PR comment with job-level details and a concrete suggested fix

---

## Failure patterns

| Pattern | Diagnosis | Fix |
|---------|-----------|-----|
| `intermittent` | Passes and fails randomly | Add retry logic, check race conditions |
| `slow-degrading` | Gets slower over time | Memory leak or growing fixtures |
| `time-dependent` | Fails at specific hours | Shared resource under load — mock it |
| `resource-sensitive` | Duration varies wildly | Runner contention — upsize or parallelize |

---

## License

MIT
