/**
 * Tests for MCP Server
 */

import { assertStringIncludes } from "@std/assert";
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
});
