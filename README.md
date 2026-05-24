# flaky-finder

[![CI](https://github.com/enoHns/flaky-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/enoHns/flaky-finder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Detects flaky CI jobs and posts a PR comment with failure rate, pattern, and a concrete fix suggestion.

## Usage

```yaml
- uses: enoHns/flaky-finder@v1
```

No config needed. Analyzes the workflow that triggered the action, posts results as a PR comment.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github-token` | `${{ github.token }}` | Needs `actions:read` + `pull-requests:write` |
| `workflow` | auto | Workflow file to analyze (e.g. `ci.yml`) |
| `lookback-runs` | `30` | Past runs to analyze (max 100) |
| `post-comment` | `true` | Post/update a PR comment |
| `fail-on-flaky` | `false` | Fail the step if flaky jobs are found |
| `ai-suggestions` | `false` | Analyze job logs with an LLM for targeted fix suggestions |
| `ai-model` | `gpt-4o-mini` | Any model on [GitHub Models](https://github.com/marketplace/models) |
| `ai-token` | `github-token` | Override with a different service key |
| `ai-endpoint` | GitHub Models | Override with any OpenAI-compatible endpoint |

## AI suggestions

Requires `permissions: models: read`. Falls back silently to built-in suggestions on any error.

```yaml
jobs:
  check:
    permissions:
      actions: read
      pull-requests: write
      models: read
    steps:
      - uses: enoHns/flaky-finder@v1
        with:
          ai-suggestions: true
```

## Patterns

| Pattern | Signal |
|---------|--------|
| `intermittent` | Random pass/fail in recent runs |
| `slow-degrading` | Duration increasing over time (Pearson r > 0.8) |
| `time-dependent` | Failures cluster at specific UTC hours |
| `resource-sensitive` | Duration variance > 40% CV |

## Privacy

Reads workflow metadata via GitHub API. Nothing leaves GitHub. When `ai-suggestions: true`, the last 3000 chars of failed job logs are sent to the AI endpoint.

## License

MIT
