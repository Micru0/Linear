
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker';
import { Env } from '../worker';

// A type for the JSON response we expect from the worker
interface WorkerResponse {
  success: boolean;
  issueId?: string;
  plan?: any;
  error?: string;
}

// Mock environment variables and KV namespace
const getMiniflareBindings = (): Env => ({
  LINEAR_SIGNING_SECRET: 'test_signing_secret',
  LINEAR_API_KEY: 'test_linear_api_key',
  OPENAI_API_KEY: 'test_openai_api_key',
  OPENAI_MODEL: 'gpt-4o-mini',
  TEAM_RULES_KV: {
    get: async (key: string) => {
      if (key === 'team_rules.json') {
        return JSON.stringify({
          'team-id-1': {
            name: 'Frontend',
            keywords: ['react', 'ui', 'bug'],
            domains: ['frontend'],
          },
        });
      }
      return null;
    },
    // Add other KV methods if needed, or leave them as no-ops
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  } as any, // Cast to any to simplify mocking
});

// Sample webhook payload for a new issue
const sampleWebhookPayload = {
  action: 'create',
  type: 'Issue',
  data: {
    id: 'issue-id-123',
    title: 'New bug report',
    description: 'There is a bug in the login form.',
    team: { id: 'team-id-triage', name: 'Triage' },
    creator: { id: 'user-id-reporter' },
  },
  organizationId: 'org-id-1',
  createdAt: new Date().toISOString(),
};

describe('Void Auto-Triage Agent Worker', () => {
  let env: Env;

  beforeEach(() => {
    env = getMiniflareBindings();
    // Mock the global fetch used by OpenAI/Linear SDKs
    global.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(options.body.toString()) : {};
      
      // Mock for OpenAI
      if (url.toString().includes('api.openai.com')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            rewrite: { title: 'Bug in Login Form', description: 'Rewritten description.' },
            teamId: 'team-id-1',
            labelIds: ['label-id-bug'],
            needsClarification: false,
          })}}],
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // Mock for Linear APIs
      if (url.toString().includes('api.linear.app')) {
        let responseData = {};
        if (body.query?.includes('issueUpdate')) {
          responseData = { data: { issueUpdate: { success: true } } };
        } else if (body.query?.includes('issueSubscriptionCreate')) {
          responseData = { data: { issueSubscriptionCreate: { success: true } } };
        } else if (body.query?.includes('reactionCreate')) {
          responseData = { data: { reactionCreate: { success: true } } };
        } else {
          responseData = { data: { "unknownMutation": { "success": true } } };
        }
        return new Response(JSON.stringify(responseData), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404 });
    };
  });

  it('should respond 200 OK to a valid issue creation webhook', async () => {
    const request = new Request('https://worker.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleWebhookPayload),
    });

    const response = await worker.fetch(request, env, {} as any);
    expect(response.status).toBe(200);

    const jsonResponse = await response.json<WorkerResponse>();
    expect(jsonResponse.success).toBe(true);
    expect(jsonResponse.issueId).toBe('issue-id-123');
  });

  it('should ignore non-create actions', async () => {
    const request = new Request('https://worker.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sampleWebhookPayload, action: 'update' }),
    });

    const response = await worker.fetch(request, env, {} as any);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Ignoring non-issue creation event');
  });
});

