# Void Auto-Triage Agent: Task List

This document outlines the tasks required to build and deploy the Void Auto-Triage Agent, based on the PRD.

## Phase 1: Project Setup and Foundation

-   [ ] **1.1. Project Scaffolding:**
    -   [ ] Create the project directory structure as per the PRD's repository blueprint.
    -   [ ] Initialize a `package.json` file.
    -   [ ] Create empty files: `wrangler.toml`, `src/worker.ts`, `src/linear.ts`, `src/llm.ts`, `src/kb.ts`, `src/prompts/examples.md`, `src/tests/worker.test.ts`.
-   [ ] **1.2. Dependency Management:**
    -   [ ] Install production dependencies: `@linear/sdk`, `zod`, `openai`.
    -   [ ] Install development dependencies: `typescript`, `@cloudflare/workers-types`, `wrangler`, `vitest` (or similar for testing).
-   [ ] **1.3. Configuration:**
    -   [ ] Configure `wrangler.toml` with the worker name, main entrypoint, and compatibility flags.
    -   [ ] Define bindings for KV namespaces (`TEAM_RULES_KV`) and secrets (`LINEAR_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`).
-   [ ] **1.4. Linear API Client (`src/linear.ts`):**
    -   [ ] Implement a typed GraphQL client using `@linear/sdk`.
    -   [ ] Authenticate using the `LINEAR_API_KEY` environment variable.
    -   [ ] Expose high-level functions for:
        -   [ ] `updateIssue` (for title, description, team, labels, estimate)
        -   [ ] `createIssue` (for subtasks)
        -   [ ] `issueCommentCreate`
        -   [ ] `issueSubscriptionCreate`
    -   [ ] Implement batching for GraphQL mutations to respect rate limits.
-   [ ] **1.5. LLM Service (`src/llm.ts`):**
    -   [ ] Define the `triagePlanSchema` using `zod` as specified in the PRD.
    -   [ ] Create a function to call the OpenAI API (GPT-4o) in JSON mode.
    -   [ ] Validate the LLM's JSON output against the `triagePlanSchema`.
    -   [ ] Implement a retry mechanism with backoff for API errors (e.g., 5xx).
-   [ ] **1.6. Knowledge Base Utilities (`src/kb.ts`):**
    -   [ ] Create helper functions to fetch and parse the team/domain mapping from the Cloudflare KV store.

## Phase 2: Core Agent Logic (`src/worker.ts`)

-   [ ] **2.1. Webhook Handling:**
    -   [ ] Set up the worker's `fetch` handler to receive and parse incoming Linear webhooks (`issue.created`, `issue.assignedToYou`).
    -   [ ] Add security verification for webhooks if available/necessary.
-   [ ] **2.2. Issue Ingestion Pipeline:**
    -   [ ] On webhook receipt, fetch the raw issue text.
    -   [ ] Load the knowledge base (team maps, labels) from KV using `kb.ts`.
    -   [ ] Construct the full prompt for the LLM, including issue data, KB data, and few-shot examples from `prompts/examples.md`.
    -   [ ] Call the LLM service (`llm.ts`) to get the `TriagePlan`.
-   [ ] **2.3. Action Execution (Post-Processing):**
    -   [ ] **Clarification Flow:**
        -   [ ] If `plan.needsClarification` is true, call `linear.ts` to post the `plan.clarificationComment`.
        -   [ ] Add an "awaiting-info" label.
    -   [ ] **Auto-Triage Flow:**
        -   [ ] If `plan.needsClarification` is false, use `linear.ts` to perform a bulk update on the issue with the rewritten title/description, new team, labels, and estimate.
        -   [ ] Create all subtasks defined in `plan.subtasks`, linking them to the parent issue.
        -   [ ] Subscribe the reporter and the agent user to the issue for notifications.
        -   [ ] Add a ✅ emoji reaction to the original issue comment or description to signal completion.
-   [ ] **2.4. Rate Limit Handling:**
    -   [ ] Ensure the Linear client (`src/linear.ts`) properly handles `429 Too Many Requests` errors with an exponential backoff strategy, respecting the `X-RateLimit-Reset` header.

## Phase 3: Testing and Deployment

-   [ ] **3.1. Unit & Integration Testing (`src/tests/`):**
    -   [ ] Write unit tests for `zod` schemas.
    -   [ ] Write unit tests for KB mapping logic.
    -   [ ] Write integration tests for the worker by mocking Linear/OpenAI APIs and providing sample webhook payloads. Test all branches of the post-processing logic.
-   [ ] **3.2. Local Development:**
    -   [ ] Document the process for running the agent locally with `wrangler dev`.
    -   [ ] Create a set of sample webhook JSON payloads to test different scenarios.
-   [ ] **3.3. Initial Deployment (Staging):**
    -   [ ] Create a staging Linear workspace.
    -   [ ] Set up secrets and KV namespace in the Cloudflare dashboard for the staging environment.
    -   [ ] Deploy the worker using `wrangler deploy` to the staging environment.
-   [ ] **3.4. End-to-End Testing:**
    -   [ ] Manually create issues in the staging Linear workspace to trigger the agent.
    -   [ ] Verify that issues are triaged correctly within the 30-second target.
    -   [ ] Validate that all actions (rewrites, assignments, subtasks, comments) are performed as expected.
-   [ ] **3.5. Production Deployment:**
    -   [ ] Once stable, deploy to the production environment.
    -   [ ] Monitor logs closely after release.

## Phase 4: Observability and Future Work

-   [ ] **4.1. Logging and Monitoring:**
    -   [ ] Set up Cloudflare Logpush to stream worker logs to a service like Supabase or Workers Analytics.
    -   [ ] Create basic dashboards to monitor execution throughput, error rates, and LLM latency.
-   [ ] **4.2. Future Roadmap (vNext):**
    -   [ ] **(v1.1)** Investigate and implement Cloudflare AI Gateway for LLM routing.
    -   [ ] **(v1.2)** Explore migrating to Linear MCP for richer tool usage.
    -   [ ] **(v1.3)** Design a feedback loop for continuous improvement (RAG). 