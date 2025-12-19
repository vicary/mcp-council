/**
 * MCP Server for AI Council
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Council } from "./council.ts";
import { CouncilDB } from "./db.ts";
import { OpenAIProvider } from "./llm.ts";
import type { VoteResult } from "./orchestrator.ts";
import { Orchestrator } from "./orchestrator.ts";

export function formatVoteResult(result: VoteResult): string {
  const sections: string[] = [];

  // Main response
  sections.push(`## Response\n\n${result.response}`);

  // Vote breakdown
  const voteSummary = result.votes
    .map((v) => {
      const voterIndex = result.proposals.findIndex((p) =>
        p.memberId === v.voterId
      ) + 1;
      const votedFor = v.proposalMemberId
        ? result.proposals.findIndex((p) => p.memberId === v.proposalMemberId) +
          1
        : "abstained";
      return `- Member ${voterIndex}: voted for ${
        votedFor === "abstained" ? "abstained" : `Proposal ${votedFor}`
      } — ${v.reasoning}`;
    })
    .join("\n");

  sections.push(`## Vote Breakdown\n\n${voteSummary}`);

  // Proposals with reasoning
  const proposalsSummary = result.proposals
    .map((p, i) =>
      `### Proposal ${i + 1}\n\n${p.content}\n\n*Reasoning: ${p.reasoning}*`
    )
    .join("\n\n");

  sections.push(`## All Proposals\n\n${proposalsSummary}`);

  // Tie-break explanation if any
  if (result.tieBreak) {
    sections.push(
      `## Tie-Break\n\n${result.tieBreak.reasoning}\n\nTied proposals: ${
        result.tieBreak.tiedProposals.map((p) =>
          result.proposals.findIndex((pr) => pr.memberId === p.memberId) + 1
        ).join(", ")
      }`,
    );
  }

  // Evictions if any
  if (result.evictions.length > 0) {
    const evictionSummary = result.evictions
      .map((e) => {
        const memberIndex = result.proposals.findIndex((p) =>
          p.memberId === e.memberId
        ) + 1;
        const reasonText = e.reason ? `\n  Reasons: ${e.reason}` : "";
        return `- Member ${memberIndex}: ${
          e.evicted
            ? `EVICTED (${e.nominations.length} nominations)${
              e.replacement ? ` → replaced by ${e.replacement}` : ""
            }${reasonText}`
            : `${e.nominations.length} nominations (not enough for supermajority)`
        }`;
      })
      .join("\n");

    sections.push(`## Eviction Results\n\n${evictionSummary}`);
  }

  return sections.join("\n\n---\n\n");
}

export async function createServer(): Promise<McpServer> {
  // Initialize dependencies eagerly on server creation
  const db = await CouncilDB.open();
  const llm = new OpenAIProvider();
  const council = new Council(db, llm);
  const orchestrator = new Orchestrator(db, llm);

  function getCouncil(): { council: Council; orchestrator: Orchestrator } {
    return { council, orchestrator };
  }

  const server = new McpServer({
    name: "mcp-council",
    version: "0.1.0",
  });

  // Register vote tool
  server.registerTool(
    "vote",
    {
      description:
        "Submit a query to the AI council for deliberation. The council will propose responses, vote on them, and return the winning response with full reasoning and vote breakdown.",
      inputSchema: {
        prompt: z.string().describe(
          "The query or request to submit to the council",
        ),
      },
    },
    async ({ prompt }, { sendNotification, _meta }) => {
      const progressToken = _meta?.progressToken;

      const sendProgress = async (
        progress: number,
        total: number,
        message: string,
      ) => {
        if (progressToken !== undefined) {
          await sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total, message },
          });
        }
      };

      try {
        const { council, orchestrator } = getCouncil();

        // Check minimum council size before proceeding
        if (!(await council.hasMinimumMembers())) {
          const memberCount = await council.getMemberCount();
          return {
            content: [
              {
                type: "text",
                text:
                  `Council has insufficient members (${memberCount}/3 minimum required). Pool recovery is in progress. Please try again in a few moments.`,
              },
            ],
            isError: true,
          };
        }

        // Mark operation as in progress to pause recovery
        council.setOperationInProgress(true);

        // Progress: Starting proposal round
        await sendProgress(
          1,
          4,
          "Collecting proposals from the council.",
        );

        const result = await orchestrator.vote(prompt, {
          onProposalsCollected: async () => {
            await sendProgress(
              2,
              4,
              "Council is voting on proposals.",
            );
          },
          onVotingComplete: async () => {
            await sendProgress(
              3,
              4,
              "Voting complete, processing evictions.",
            );
          },
        });

        await sendProgress(4, 4, "Council deliberation complete.");

        // Run candidate practice round in background
        council.getCandidatePool().runPracticeRound(prompt).catch(
          console.error,
        );

        return {
          content: [
            {
              type: "text",
              text: formatVoteResult(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error during council vote: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      } finally {
        // Always clear operation flag, even on error
        council.setOperationInProgress(false);
      }
    },
  );

  // Register council_status tool
  server.registerTool(
    "council_status",
    {
      description:
        "Get the current status of the council including members, candidates, and pool statistics.",
      inputSchema: {},
    },
    async () => {
      const { council } = getCouncil();
      const status = await council.getStatus();

      const memberList = status.members
        .map(
          (m, i) =>
            `${i + 1}. ${m.persona.name} (${
              m.persona.values.slice(0, 3).join(", ")
            })`,
        )
        .join("\n");

      const candidateList = status.candidates
        .map(
          (c, i) =>
            `${i + 1}. ${c.persona.name} (fitness: ${c.fitness}, values: ${
              c.persona.values.slice(0, 2).join(", ")
            })`,
        )
        .join("\n");

      const statusText = `# Council Status

## Members (${status.members.length}/8)
${memberList}

## Candidates (${status.candidates.length}/${status.state.targetPoolSize})
${candidateList}

## Statistics
- Rounds since last eviction: ${status.state.roundsSinceEviction}
- Target pool size: ${status.state.targetPoolSize}
- Recent removal causes: ${status.state.lastRemovalCauses.length}
${
        status.state.removalHistorySummary
          ? `\n## Removal History Summary\n${status.state.removalHistorySummary}`
          : ""
      }`;

      return {
        content: [
          {
            type: "text",
            text: statusText,
          },
        ],
      };
    },
  );

  // Start periodic pool recovery instead of bootstrap
  // This spreads the initialization load and makes recovery more resilient
  council.startPeriodicRecovery();

  return server;
}

export async function runServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
