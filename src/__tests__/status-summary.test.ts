import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAssistantPlan, formatSubagentStatus, formatToolStatus, summarizeToolCompletionDetail } from '../status-summary.js';

describe('status-summary', () => {
  it('formats task tool status using the human description first', () => {
    assert.deepEqual(
      formatToolStatus('task', {
        agent_type: 'code-review',
        description: 'Code review github-remote',
        prompt: 'Please do a thorough code review',
      }),
      {
        label: '🤖 Agent',
        detail: 'Code review github-remote',
        statusLine: '🤖 Agent Code review github-remote',
      },
    );
  });

  it('formats bash tool status using description before raw command text', () => {
    assert.deepEqual(
      formatToolStatus('bash', {
        description: 'Check git status for staged/unstaged changes',
        command: 'cd ~/source/github-remote && git --no-pager status',
      }),
      {
        label: '▶️ Run',
        detail: 'Check git status for staged/unstaged changes',
        statusLine: '▶️ Run Check git status for staged/unstaged changes',
      },
    );
  });

  it('extracts intent, concise reasoning, and first actionable tool from assistant planning metadata', () => {
    assert.deepEqual(
      extractAssistantPlan({
        content: '',
        reasoningText: 'The user wants a thorough code review.\n\nLet me start by checking git status.',
        toolRequests: [
          { name: 'report_intent', arguments: { intent: 'Reviewing code changes' } },
          {
            name: 'bash',
            arguments: {
              description: 'Check git status for staged/unstaged changes',
              command: 'cd ~/source/github-remote && git --no-pager status',
            },
          },
        ],
      }),
      {
        intentText: 'Reviewing code changes',
        thinkingSummary: 'The user wants a thorough code review.',
        activeToolStatus: '▶️ Run Check git status for staged/unstaged changes',
      },
    );
  });

  it('falls back to assistant content when tool requests exist but reasoning text is absent', () => {
    assert.equal(
      extractAssistantPlan({
        content: 'I\'ll inspect the repository before reviewing it.',
        toolRequests: [{ name: 'view', arguments: { path: '/tmp/repo' } }],
      }).thinkingSummary,
      'I\'ll inspect the repository before reviewing it.',
    );
  });

  it('normalizes and clips tool completion details', () => {
    assert.equal(
      summarizeToolCompletionDetail('  Path does not exist\n\n  because the repo was renamed.  ', 36),
      'Path does not exist because the repo…',
    );
  });

  it('formats subagent milestones for human-readable progress updates', () => {
    assert.deepEqual(
      formatSubagentStatus({ agentName: 'code-review', agentDisplayName: 'Code Review Agent' }),
      {
        statusLine: '🤖 Starting Code Review Agent',
      },
    );
  });

  it('suppresses noisy raw web fetch completion dumps', () => {
    assert.equal(
      summarizeToolCompletionDetail('Content type text/xml; charset=utf-8 cannot be simplified to markdown. Here is the raw content: Contents of https://feeds.bbci.co.uk/news/rss.xml: <?xml version="1.0"?>'),
      'Fetched content',
    );
  });
});