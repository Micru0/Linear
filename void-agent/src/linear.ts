import { LinearClient, LinearClientOptions } from "@linear/sdk";

// Define the shape of the environment variables we expect
export interface Env {
  LINEAR_API_KEY: string;
}

// Singleton instance of the LinearClient
let linearClient: LinearClient | null = null;

function getLinearClient(env: Env): LinearClient {
  if (!linearClient) {
    if (!env.LINEAR_API_KEY) {
      throw new Error("LINEAR_API_KEY is not set in the environment.");
    }
    const options: LinearClientOptions = { apiKey: env.LINEAR_API_KEY };
    linearClient = new LinearClient(options);
  }
  return linearClient;
}

// Type definitions for the update payloads.
export interface IssueUpdatePayload {
  title?: string;
  description?: string;
  teamId?: string;
  labelIds?: string[];
  estimate?: number | string;
  priority?: number;
  assigneeId?: string;
}

export interface SubtaskCreatePayload {
  title: string;
  description?: string;
}

async function makeGraphQLRequest(env: Env, query: string, variables: Record<string, any>) {
  const client = getLinearClient(env);
  try {
    const result: any = await client.client.rawRequest(query, variables);
    return result.data;
  } catch (error: any) {
    console.error("GraphQL Request Failed:", error.response?.errors || error.message);
    throw new Error(`GraphQL request failed: ${error.message}`);
  }
}

let botId: string | null = null;

export async function getBotId(env: Env): Promise<string> {
  if (botId) return botId;
  const client = getLinearClient(env);
  const me = await client.viewer;
  if (!me.id) throw new Error("Could not fetch bot's own user ID.");
  botId = me.id;
  return botId;
}

export async function getIssue(env: Env, issueId: string) {
    const query = `
        query Issue($id: String!) {
            issue(id: $id) {
                id
                title
                description
                labels { nodes { id } }
            }
        }`;
    const variables = { id: issueId };
    const data = await makeGraphQLRequest(env, query, variables);
    const issue = data?.issue;
    if (!issue) {
        throw new Error(`Failed to fetch issue ${issueId}`);
    }
    // a bit of data transformation to make it easier to use
    return {
        ...issue,
        labelIds: issue.labels.nodes.map((l: {id: string}) => l.id)
    };
}

export async function getComments(env: Env, issueId: string) {
    const query = `
        query Issue($id: String!) {
            issue(id: $id) {
                comments {
                    nodes {
                        id
                        body
                        user { id, name }
                    }
                }
            }
        }`;
    const variables = { id: issueId };
    const data = await makeGraphQLRequest(env, query, variables);
    if (!data?.issue?.comments?.nodes) {
        throw new Error(`Failed to fetch comments for issue ${issueId}`);
    }
    return data.issue.comments.nodes;
}

/**
 * Updates an issue in Linear.
 * @param env - The environment variables.
 * @param issueId - The ID of the issue to update.
 * @param payload - The data to update on the issue.
 */
export async function updateIssue(env: Env, issueId: string, payload: IssueUpdatePayload): Promise<void> {
  const client = getLinearClient(env);
  
  // Convert estimate to a number if it's a string
  const estimateAsNumber = typeof payload.estimate === 'string' 
    ? parseInt(payload.estimate, 10) 
    : payload.estimate;

  // Build a dynamic variables object
  const variables: { [key: string]: any } = {
    id: issueId,
    input: {
      title: payload.title,
      description: payload.description,
      teamId: payload.teamId,
      labelIds: payload.labelIds,
      estimate: estimateAsNumber,
      priority: payload.priority,
      assigneeId: payload.assigneeId,
    },
  };

  // The GraphQL mutation for updating an issue
  const mutation = `
    mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id, title }
      }
    }`;
  const data = await makeGraphQLRequest(env, mutation, variables);
  if (!data?.issueUpdate?.success) {
    throw new Error(`Failed to update issue ${issueId}`);
  }
}

export async function createMultipleSubtasks(env: Env, parentId: string, subtasks: SubtaskCreatePayload[]) {
  const query = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id, title }
      }
    }`;
  
  const promises = subtasks.map(subtask => {
    const variables = { input: { parentId, ...subtask } };
    return makeGraphQLRequest(env, query, variables);
  });

  const results = await Promise.allSettled(promises);
  return results
    .map(result => {
      if (result.status === "rejected" || !result.value?.issueCreate?.success) {
        console.error("Subtask creation failed:", result);
        return null;
      }
      return result.value.issueCreate.issue;
    })
    .filter(Boolean);
}

export async function createComment(env: Env, issueId: string, body: string) {
  const query = `
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id, body }
      }
    }`;
  const variables = { input: { issueId, body } };
  const data = await makeGraphQLRequest(env, query, variables);
  if (!data?.commentCreate?.success) {
    throw new Error(`Failed to create comment on issue ${issueId}`);
  }
  return data.commentCreate.comment;
}

export async function subscribeToIssue(env: Env, issueId: string, userId: string) {
  const query = `
    mutation IssueSubscriptionCreate($issueId: String!, $userId: String!) {
        issueSubscriptionCreate(input: { issueId: $issueId, userId: $userId, type: "all" }) {
            success
            issueSubscription { id }
        }
    }`;
  const variables = { issueId, userId };
  const data = await makeGraphQLRequest(env, query, variables);
  if (!data?.issueSubscriptionCreate?.success) {
    throw new Error(`Failed to subscribe user ${userId} to issue ${issueId}`);
  }
  return data.issueSubscriptionCreate.issueSubscription;
}

export async function addReaction(env: Env, issueId: string, emoji: string) {
  const query = `
    mutation ReactionCreate($input: ReactionCreateInput!) {
      reactionCreate(input: $input) {
        success
        reaction { id, emoji }
      }
    }`;
  const variables = { input: { issueId, emoji } };
  const data = await makeGraphQLRequest(env, query, variables);
  if (!data?.reactionCreate?.success) {
    throw new Error(`Failed to add reaction to issue ${issueId}`);
  }
  return data.reactionCreate.reaction;
}
