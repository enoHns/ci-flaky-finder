"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const rest_1 = require("@octokit/rest");
const flaky_analyzer_1 = require("./flaky.analyzer");
const reporter_1 = require("./reporter");
async function run() {
    try {
        const token = core.getInput('github-token', { required: true });
        const lookback = parseInt(core.getInput('lookback-runs') || '30');
        const postComment = core.getBooleanInput('post-comment');
        const failOnFlaky = core.getBooleanInput('fail-on-flaky');
        const aiEnabled = core.getBooleanInput('ai-suggestions');
        const aiToken = aiEnabled ? (core.getInput('ai-token') || token) : undefined;
        const aiModel = core.getInput('ai-model') || 'gpt-4o-mini';
        const aiEndpoint = core.getInput('ai-endpoint') || 'https://models.inference.ai.azure.com/chat/completions';
        const octokit = new rest_1.Octokit({ auth: token });
        const ctx = github.context;
        const { owner, repo } = ctx.repo;
        // GITHUB_WORKFLOW_REF = "owner/repo/.github/workflows/ci.yml@refs/heads/main"
        const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? '';
        const detectedWorkflow = workflowRef.split('@')[0].split('/').pop() ?? '';
        const workflow = core.getInput('workflow') || detectedWorkflow;
        core.info(`flaky-finder — ${owner}/${repo}, workflow: ${workflow || 'all'}, lookback: ${lookback}`);
        const perPage = Math.min(lookback, 100);
        let runs;
        if (workflow) {
            const { data } = await octokit.actions.listWorkflowRuns({
                owner, repo, workflow_id: workflow, per_page: perPage, status: 'completed',
            });
            runs = data.workflow_runs;
        }
        else {
            const { data } = await octokit.actions.listWorkflowRunsForRepo({
                owner, repo, per_page: perPage, status: 'completed',
            });
            runs = data.workflow_runs;
        }
        const report = await (0, flaky_analyzer_1.detectFlaky)(octokit, owner, repo, runs, aiToken, aiModel, aiEndpoint);
        core.setOutput('flaky-count', report.flaky.length);
        if (postComment && ctx.payload.pull_request) {
            await (0, reporter_1.renderReport)(octokit, ctx, report);
            core.info('PR comment posted');
        }
        if (failOnFlaky && report.flaky.length > 0) {
            core.setFailed(`${report.flaky.length} flaky job(s) detected: ${report.flaky.map(f => f.jobName).join(', ')}`);
            return;
        }
        core.info(`Done — ${report.flaky.length} flaky job(s) found`);
    }
    catch (err) {
        core.setFailed(`flaky-finder failed: ${err.message}`);
    }
}
run();
