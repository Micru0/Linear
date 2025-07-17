/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import {
  Env as LinearEnv,
  updateIssue,
  createMultipleSubtasks,
  createComment,
  subscribeToIssue,
  addReaction,
  getBotId,
  getIssue,
  getComments,
} from "./linear";
import { Env as LlmEnv, getTriagePlan, TriagePlan } from "./llm";
import { Env as KbEnv, getTeamKnowledgeBase, getLabelKnowledgeBase, validateLabelIds } from "./kb";

// The system prompt that instructs the LLM on how to perform the triage.
const SYSTEM_PROMPT = `
You are an expert AI assistant for the team at Bawes. Your goal is to ensure every issue is perfectly clear before an engineer sees it. Follow these steps in order.

**Rule #1: Do NOT invent information.** Your primary goal is to gather information, not to make it up. If a detail isn't in the issue or the knowledge base, you MUST ask for it.

**Step 1: Assess for Clarity**
First, critically analyze the issue's title and description. Ask yourself: "Could an engineer start working on this immediately, or are there open questions?"

-   **Vague/Incomplete Issue**: If there is any ambiguity, you MUST ask for clarification. Do not invent details or assume context. Your primary job is to get the information needed for a complete ticket.
-   **Perfectly Clear Issue**: If the request is specific and actionable, you can proceed to the next step.

**Example of a Vague Issue & How to Handle It:**
-   **Vague Issue**: "Call center needs to be logged and transcribed."
-   **Analysis**: This is too vague. What call center? What information should be logged? Where are transcriptions stored?
-   **Action**: Set \`needsClarification: true\` and ask questions in \`clarificationComment\`. Use markdown for clarity. For example: "To make sure I understand, could you please provide a few more details?
    -   Which call center or phone line should be logged?
    -   What specific information from each call is needed (e.g., caller ID, duration)?
    -   Where should the final transcriptions be stored?"

**Step 2: Generate a Triage Plan**
-   **If Vague**: Set \`needsClarification\` to \`true\`. Write specific, professional questions in \`clarificationComment\` using markdown. Do not generate any other part of the plan.
-   **If Clear**: Set \`needsClarification\` to \`false\`. Generate a complete plan, including team, labels, priority, and estimate. Use the \`rewrite\` field to structure the information into a clean, actionable format for the final ticket. Use markdown for the title and description.

**Handling Conversations:**
When a user replies to your question, the new information is your opportunity to achieve perfect clarity. You MUST use the conversation to rewrite the issue title and description into a final, actionable state. Use clear headings and bullet points in the description for readability. Set \`needsClarification\` to \`false\` and complete the triage.

**TriagePlan JSON Structure:**
-   \`rewrite\` (optional):
    -   \`title\`: The new, clear title (use markdown if helpful).
    -   \`description\`: The new, comprehensive description (use markdown with clear headings and lists).
-   \`priority\`: "Urgent", "High", "Medium", "Low", or "No priority".
-   \`teamId\`: The ID of the correct team from the knowledge base.
-   \`labelIds\`: A list of relevant label UUIDs from the knowledge base.
-   \`estimate\`: A Fibonacci point estimate (0, 1, 2, 3, 5, 8, 13).
-   \`assigneeId\` (optional): A specific person's ID, if you are highly confident.
-   \`subtasks\` (optional): A list of titles for subtasks if the issue is an epic.
-   \`needsClarification\`: \`true\` if you still lack information.
-   \`clarificationComment\` (optional): Your question to the user. Must end with \`<!-- bot -->\`.

Your final output must be only the JSON TriagePlan.
`;

// Define the mapping from priority names to their numeric IDs in Linear.
const priorityMap: { [key: string]: number } = {
	"No priority": 0,
	"Urgent": 1,
	"High": 2,
	"Medium": 3,
	"Low": 4,
  };

// Combine all environment interfaces
export interface Env extends LinearEnv, LlmEnv, KbEnv {
	PROMPT?: string; // Allow prompt override from environment
	AWAITING_INFO_LABEL_ID?: string; // Optional label ID for clarification
    LINEAR_SIGNING_SECRET: string; // The secret used to verify webhook signatures
}

// Define the expected shape of a Linear webhook payload
interface IssueData {
	id: string;
	title:string;
	description?: string;
	team: { id: string, name: string};
	creator?: {id: string};
}

interface CommentData {
	id: string;
	body: string;
	issueId: string; // This is not in the payload, but we get it from issue.id
	userId: string;
	issue: { id: string };
}

interface LinearWebhookPayload {
	action: 'create' | 'update' | 'remove';
	type: 'Issue' | 'Comment';
	data: IssueData | CommentData;
	organizationId: string;
	createdAt: string;
}

/**
 * Verifies the signature of an incoming Linear webhook request.
 * @param request The incoming request.
 * @param secret The signing secret.
 * @returns A promise that resolves to true if the signature is valid.
 */
async function verifySignature(request: any, secret: string): Promise<boolean> {
    const signatureHeader = request.headers.get('linear-signature');
    if (!signatureHeader) {
        console.warn('Missing linear-signature header');
        return false;
    }

    try {
        const body = await request.clone().text();
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify'] // Correct usage for the verify operation
        );

        // Convert the hex signature from the header into an ArrayBuffer
        const signatureBytes = new Uint8Array(signatureHeader.match(/[\da-f]{2}/gi)!.map((h: string) => parseInt(h, 16)));

        // Verify the signature against the body
        const isValid = await crypto.subtle.verify(
            'HMAC',
            key,
            signatureBytes.buffer,
            encoder.encode(body)
        );

        return isValid;
    } catch (error) {
        console.error('Error verifying signature:', error);
        return false;
    }
}

/**
 * Handles the logic for triaging a new issue.
 * This is run in the background via ctx.waitUntil().
 */
async function handleNewIssue(payload: LinearWebhookPayload, env: Env) {
	const data = payload.data as IssueData;
	const { id: issueId, title, description, creator } = data;

	const teamKb = await getTeamKnowledgeBase(env);
	const teamKbString = JSON.stringify(teamKb, null, 2);

	const labelKb = await getLabelKnowledgeBase(env);
	const labelKbString = JSON.stringify(labelKb, null, 2);

	const issueContent = `Title: ${title}\n\nDescription: ${description || ''}`;
	const promptWithKb = `${env.PROMPT || SYSTEM_PROMPT}\n\nTeam Knowledge Base:\n${teamKbString}\n\nLabel Knowledge Base:\n${labelKbString}`;

	const plan = await getTriagePlan(
		{ ...env, PROMPT: promptWithKb },
		issueContent
	);

	if (plan.needsClarification && plan.clarificationComment) {
		await createComment(env, issueId, plan.clarificationComment);
		if (env.AWAITING_INFO_LABEL_ID) {
			await updateIssue(env, issueId, { labelIds: [env.AWAITING_INFO_LABEL_ID] });
		}
	} else {
		const { teamId, labelIds, estimate, assigneeId, subtasks, priority } = plan;

		const validLabelIds = await validateLabelIds(env, labelIds || []);

		await updateIssue(env, issueId, {
			teamId,
			labelIds: validLabelIds,
			estimate,
			priority: priority ? priorityMap[priority] : undefined,
			assigneeId,
		});
		if (subtasks && subtasks.length > 0) {
			await createMultipleSubtasks(env, issueId, subtasks.map(title => ({ title })));
		}
		if (creator) {
			await subscribeToIssue(env, issueId, creator.id);
		}
		await addReaction(env, issueId, '✅');
	}
}

/**
 * Handles the logic for re-triaging an issue after a new comment.
 * This is run in the background via ctx.waitUntil().
 */
async function handleComment(payload: LinearWebhookPayload, env: Env) {
	const data = payload.data as CommentData;

	// Ignore comments from the bot itself to prevent loops
	if (data.body.includes('<!-- bot -->')) {
		console.log("Ignoring comment from bot.");
		return;
	}

	const issueId = data.issue.id;
	const issue = await getIssue(env, issueId);

	// Only process comments on issues that are awaiting information
	if (!env.AWAITING_INFO_LABEL_ID || !issue.labelIds.includes(env.AWAITING_INFO_LABEL_ID)) {
		console.log("Ignoring comment: issue not awaiting info.");
		return;
	}

	console.log(`[${issueId}] Processing comment to re-triage issue.`);
	const teamKb = await getTeamKnowledgeBase(env);
	const teamKbString = JSON.stringify(teamKb, null, 2);
	const labelKb = await getLabelKnowledgeBase(env);
	const labelKbString = JSON.stringify(labelKb, null, 2);

	const comments = await getComments(env, issueId);
	const conversationHistory = comments
		.map((c: any) => `${c.user?.name || 'User'}: ${c.body}`)
		.join('\n\n');

	const issueContent = `The user has replied to our clarification request. Follow the SOP. Here is the full context.\n\nOriginal Title: ${issue.title}\n\nOriginal Description: ${issue.description || ''}\n\nConversation History:\n${conversationHistory}`;
	const promptWithKb = `${env.PROMPT || SYSTEM_PROMPT}\n\nTeam Knowledge Base:\n${teamKbString}\n\nLabel Knowledge Base:\n${labelKbString}`;

	const plan = await getTriagePlan({ ...env, PROMPT: promptWithKb }, issueContent);
	console.log(`[${issueId}] Re-triage plan generated:`, JSON.stringify(plan, null, 2));

	if (plan.needsClarification && plan.clarificationComment) {
		// Still needs more info, so ask again.
		console.log(`[${issueId}] Still needs clarification. Posting new comment.`);
		await createComment(env, issueId, plan.clarificationComment);
	} else {
		// Triage is now possible.
		console.log(`[${issueId}] Executing re-triage plan.`);
		const { teamId, labelIds, estimate, assigneeId, subtasks, priority, rewrite } = plan;
		const validLabelIds = await validateLabelIds(env, labelIds || []);

		// Remove 'Awaiting Info' label and add new ones.
		const finalLabelIds = issue.labelIds
			.filter((id: string) => id !== env.AWAITING_INFO_LABEL_ID)
			.concat(validLabelIds);

		await updateIssue(env, issueId, {
			title: rewrite?.title,
			description: rewrite?.description,
			teamId,
			labelIds: finalLabelIds,
			estimate,
			priority: priority ? priorityMap[priority] : undefined,
			assigneeId,
		});

		if (subtasks && subtasks.length > 0) {
			console.log(`[${issueId}] Creating ${subtasks.length} subtasks.`);
			await createMultipleSubtasks(env, issueId, subtasks.map(title => ({ title })));
		}

		await addReaction(env, issueId, '✅');
		console.log(`[${issueId}] Re-triage complete.`);
	}
}


export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // First, verify the webhook signature
        const isVerified = await verifySignature(request.clone(), env.LINEAR_SIGNING_SECRET);
        if (!isVerified) {
            return new Response('Invalid signature', { status: 401 });
        }

		const payload = await request.json<LinearWebhookPayload>();

		// Use waitUntil to process the webhook in the background
		if (payload.type === 'Issue' && payload.action === 'create') {
			ctx.waitUntil(handleNewIssue(payload, env));
		} else if (payload.type === 'Comment' && payload.action === 'create') {
			ctx.waitUntil(handleComment(payload, env));
		}

		// Respond immediately to Linear to avoid timeouts
		return new Response('Webhook acknowledged', { status: 200 });
	},
};
