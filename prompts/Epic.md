# AI Council

An 8-member AI council exposed as an MCP server. TypeScript + Deno, persisted to
SQLite.

## MCP Tools

| Tool   | Parameters       | Description                                                                                    |
| ------ | ---------------- | ---------------------------------------------------------------------------------------------- |
| `vote` | `prompt: string` | Submit query to council; spawns orchestrator, runs all rounds, returns response with reasoning |

### Use Cases

```
vote("Should we invest in NVDA given current AI market trends?")
vote("Review this code for security vulnerabilities: <code>")
vote("Draft a professional email declining a meeting invitation")
vote("What's the ethical approach to handling user data in this scenario?")
```

**Output format**: Executed response + vote breakdown + member reasoning +
tie-break explanation (if any)

## Architecture

- **Council**: 8 members with persistent personas and chat history
- **Candidates**: Dynamic pool (3–20) competing for promotion
- **Orchestrator**: Stateless session per vote; manages rounds in parallel
- **Context management**: Summarize histories every 3 rounds

## Bootstrap

On startup: restore members/candidates from DB → create candidates to target
pool size → if no council exists, select 8 randomly from candidates.

## Voting Flow

All rounds run in parallel for efficiency.

### Round 1: Proposals

Each member proposes a response aligned with their persona values.

### Round 2: Selection

Members vote for favorite proposal (no self-voting, may abstain). Orchestrator
executes winning proposal. On tie, orchestrator decides and explains in output.

**Output**: Response + all votes with reasoning.

### Round 3: Eviction

Members nominate up to one peer for eviction based on proposal/vote conflicts.
Supermajority (6+) required. Evicted members demote to candidates → immediate
promotion vote.

Post-vote: All members receive anonymized summary for context retention.

## Member Circulation

### Promotion (on vacancy)

- Council members: 2 votes each
- Candidates: 1 vote each
- Ties: Orchestrator decides based on fitness history
- Execute via `promote(candidateId)`

## Candidate Pool

### Dynamic Sizing

| Event                      | Effect    | Bounds  |
| -------------------------- | --------- | ------- |
| 10 rounds without demotion | Target −1 | Min: 3  |
| Council demotion occurs    | Target +1 | Max: 20 |

No new candidates created if pool exceeds target.

### Practice Rounds (after each council vote)

Candidates run parallel deliberation: propose → vote (no self-voting) → eviction
vote.

- **Eviction**: Simple majority
- **Nullification**: 75% favorite votes on a proposal protects its author from
  eviction

Survivors may update their persona prompt. Fitness (cumulative votes) tracked.

### Creation

On eviction (if below target): Spawn session with all personas + last eviction
cause → generate new persona → initialize with council intro + last 10 removal
causes.
