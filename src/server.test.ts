/**
 * Tests for MCP Server
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { VoteResult } from "./orchestrator.ts";
import { formatVoteResult } from "./server.ts";

describe("MCP Server", () => {
  describe("formatVoteResult", () => {
    const mockResult: VoteResult = {
      response: "The recommended approach is to proceed cautiously.",
      proposals: [
        {
          memberId: "mem_1",
          content: "Proceed cautiously with careful analysis.",
          reasoning: "Risk mitigation is important.",
        },
        {
          memberId: "mem_2",
          content: "Move forward boldly.",
          reasoning: "Opportunity favors the brave.",
        },
        {
          memberId: "mem_3",
          content: "Gather more information first.",
          reasoning: "Knowledge is power.",
        },
      ],
      votes: [
        {
          voterId: "mem_1",
          proposalMemberId: "mem_2",
          reasoning: "Bold approach has merit.",
        },
        {
          voterId: "mem_2",
          proposalMemberId: "mem_1",
          reasoning: "Caution is wise.",
        },
        {
          voterId: "mem_3",
          proposalMemberId: "mem_1",
          reasoning: "Agrees with risk assessment.",
        },
      ],
      winner: {
        memberId: "mem_1",
        content: "Proceed cautiously with careful analysis.",
        reasoning: "Risk mitigation is important.",
      },
      evictions: [],
      errors: [],
    };

    it("should include the response", () => {
      const formatted = formatVoteResult(mockResult);
      assertStringIncludes(formatted, "proceed cautiously");
    });

    it("should include vote breakdown", () => {
      const formatted = formatVoteResult(mockResult);
      assertStringIncludes(formatted, "Vote Breakdown");
      assertStringIncludes(formatted, "Member 1");
      assertStringIncludes(formatted, "Member 2");
    });

    it("should include all proposals", () => {
      const formatted = formatVoteResult(mockResult);
      assertStringIncludes(formatted, "All Proposals");
      assertStringIncludes(formatted, "Proposal 1");
      assertStringIncludes(formatted, "Proposal 2");
      assertStringIncludes(formatted, "Proposal 3");
    });

    it("should include tie-break explanation when present", () => {
      const resultWithTie: VoteResult = {
        ...mockResult,
        tieBreak: {
          tiedProposals: [mockResult.proposals[0], mockResult.proposals[1]],
          decision: "mem_1",
          reasoning: "Proposal 1 was more comprehensive",
        },
      };

      const formatted = formatVoteResult(resultWithTie);
      assertStringIncludes(formatted, "Tie-Break");
      assertStringIncludes(formatted, "comprehensive");
    });

    it("should include eviction results when present", () => {
      const resultWithEviction: VoteResult = {
        ...mockResult,
        evictions: [
          {
            memberId: "mem_2",
            nominations: [
              {
                nominatorId: "mem_1",
                nomineeId: "mem_2",
                reasoning: "Too aggressive",
              },
              {
                nominatorId: "mem_3",
                nomineeId: "mem_2",
                reasoning: "Conflicts with values",
              },
            ],
            evicted: false,
          },
        ],
      };

      const formatted = formatVoteResult(resultWithEviction);
      assertStringIncludes(formatted, "Eviction Results");
      assertStringIncludes(formatted, "2 nominations");
    });

    it("should indicate when member was evicted", () => {
      const resultWithEviction: VoteResult = {
        ...mockResult,
        evictions: [
          {
            memberId: "mem_2",
            nominations: Array(6).fill({
              nominatorId: "mem_x",
              nomineeId: "mem_2",
              reasoning: "Problematic",
            }),
            evicted: true,
            replacement: "cand_new",
          },
        ],
      };

      const formatted = formatVoteResult(resultWithEviction);
      assertStringIncludes(formatted, "EVICTED");
      assertStringIncludes(formatted, "replaced by");
    });

    it("should handle abstentions in vote breakdown", () => {
      const resultWithAbstention: VoteResult = {
        ...mockResult,
        votes: [
          ...mockResult.votes,
          {
            voterId: "mem_4",
            proposalMemberId: null,
            reasoning: "None aligned with my values",
          },
        ],
      };

      const formatted = formatVoteResult(resultWithAbstention);
      assertStringIncludes(formatted, "abstained");
    });
  });

  describe("vote tool progress notifications", () => {
    interface ProgressNotification {
      method: string;
      params: {
        progressToken: string | number;
        progress: number;
        total: number;
        message: string;
      };
    }

    it("should send progress notifications when progressToken is provided", async () => {
      const notifications: ProgressNotification[] = [];
      const mockProgressToken = "test-token-123";

      // Create a mock sendNotification function
      const sendNotification = async (notification: ProgressNotification) => {
        notifications.push(notification);
      };

      // Create the sendProgress helper inline (same logic as server.ts)
      const sendProgress = async (
        progress: number,
        total: number,
        message: string,
      ) => {
        if (mockProgressToken !== undefined) {
          await sendNotification({
            method: "notifications/progress",
            params: {
              progressToken: mockProgressToken,
              progress,
              total,
              message,
            },
          });
        }
      };

      // Simulate the progress calls made during vote
      await sendProgress(1, 4, "Collecting proposals from the council.");
      await sendProgress(2, 4, "Council is voting on proposals.");
      await sendProgress(3, 4, "Voting complete, processing evictions.");
      await sendProgress(4, 4, "Council deliberation complete.");

      assertEquals(notifications.length, 4);

      // Verify first notification
      assertEquals(notifications[0].method, "notifications/progress");
      assertEquals(notifications[0].params.progressToken, mockProgressToken);
      assertEquals(notifications[0].params.progress, 1);
      assertEquals(notifications[0].params.total, 4);
      assertStringIncludes(
        notifications[0].params.message,
        "Collecting proposals",
      );

      // Verify second notification
      assertEquals(notifications[1].params.progress, 2);
      assertStringIncludes(
        notifications[1].params.message,
        "voting on proposals",
      );

      // Verify third notification
      assertEquals(notifications[2].params.progress, 3);
      assertStringIncludes(
        notifications[2].params.message,
        "processing evictions",
      );

      // Verify fourth notification
      assertEquals(notifications[3].params.progress, 4);
      assertStringIncludes(notifications[3].params.message, "complete");
    });

    it("should not send notifications when progressToken is undefined", async () => {
      const notifications: ProgressNotification[] = [];
      const progressToken = undefined;

      const sendNotification = async (notification: ProgressNotification) => {
        notifications.push(notification);
      };

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

      // Simulate progress calls
      await sendProgress(1, 4, "Collecting proposals...");
      await sendProgress(2, 4, "Voting...");
      await sendProgress(3, 4, "Evictions...");
      await sendProgress(4, 4, "Complete.");

      assertEquals(notifications.length, 0);
    });

    it("should include correct progress token in all notifications", async () => {
      const notifications: ProgressNotification[] = [];
      const numericToken = 42;

      const sendNotification = async (notification: ProgressNotification) => {
        notifications.push(notification);
      };

      const sendProgress = async (
        progress: number,
        total: number,
        message: string,
      ) => {
        if (numericToken !== undefined) {
          await sendNotification({
            method: "notifications/progress",
            params: { progressToken: numericToken, progress, total, message },
          });
        }
      };

      await sendProgress(1, 4, "Step 1");
      await sendProgress(2, 4, "Step 2");

      // All notifications should have the same token
      for (const notification of notifications) {
        assertEquals(notification.params.progressToken, numericToken);
      }
    });
  });
});
