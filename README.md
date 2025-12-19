# AI Council MCP Server

## Why?

Pewdiepie did it, wanna try it out too.

The whole project comes from vibe coding, almost didn't touch a line of code.

## What?

An MCP server that provides AI council deliberation — multiple AI personas
discuss your prompt, propose solutions, and vote to select the best response.

Think of it as a "jury of AIs" for more thoughtful, considered answers.

## How?

Each vote triggers a 3-round deliberation:

1. **Propose** — Each council member drafts a response based on their persona
2. **Vote** — Members vote for their favorite proposal (no self-voting); winner
   gets executed
3. **Evict** — Members can nominate underperformers; supermajority (6/8) removes
   them

Evicted members demote to the candidate pool, triggering a promotion vote.
Candidates also run practice rounds to compete for council seats.

The system is self-improving: personas evolve, weak members get replaced, and
the candidate pool dynamically sizes based on council stability.

## Quick Start

### Prerequisites

- [Deno](https://deno.land/) 2.x or later
- OpenAI API key (or compatible endpoint)

### Environment Variables

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

### Running in Development

```bash
deno task dev
```

### Running Tests

```bash
deno test
```

### Type Checking

```bash
deno check && deno lint
```

### Compiling to Executable

```bash
deno task compile
```

This creates a standalone `mcp-council` executable that can be run without Deno:

```bash
./mcp-council
```

## MCP Configuration

### VS Code (Copilot)

Add to your `mcp.json`:

```json
{
  "servers": {
    "mcp-council": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@vicary/mcp-council"],
      "env": {
        "OPENAI_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-council": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@vicary/mcp-council"],
      "env": {
        "OPENAI_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Available MCP Tools

### `vote`

Submit a query to the council for deliberation.

**Parameters:**

- `prompt` (string, required): The query or request to submit

**Returns:** Executed response + vote breakdown + member reasoning + tie-break
explanation (if any)

**Example:**

```
vote("Should we invest in NVDA given current AI market trends?")
vote("Review this code for security vulnerabilities: <code>")
vote("Draft a professional email declining a meeting invitation")
```

### `council_status`

Get the current status of the council including members, candidates, and pool
statistics.

**Parameters:** None

**Returns:** List of council members, candidates, and statistics

## Architecture

- **Council**: 8 members with persistent personas and chat history
- **Candidates**: Dynamic pool (3–20) competing for promotion
- **Orchestrator**: Stateless session per vote; manages rounds in parallel
- **Context management**: Summarize histories every 3 rounds

## Testing the Server

### Using MCP Inspector

The easiest way to test the MCP server is using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector deno run --allow-all src/main.ts
```

This opens a web UI where you can:

1. View available tools
2. Call `vote` with test prompts
3. Call `council_status` to see council state

### Using a Test Client

Create a simple test script:

```typescript
// test-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "deno",
  args: ["run", "--allow-all", "src/main.ts"],
  env: {
    OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",
  },
});

const client = new Client({ name: "test-client", version: "1.0.0" }, {});
await client.connect(transport);

// List tools
const tools = await client.listTools();
console.log("Available tools:", tools);

// Get council status
const status = await client.callTool({ name: "council_status", arguments: {} });
console.log("Council status:", status);

// Submit a vote
const result = await client.callTool({
  name: "vote",
  arguments: { prompt: "What is the meaning of life?" },
});
console.log("Vote result:", result);

await client.close();
```

Run it:

```bash
deno run --allow-all test-client.ts
```

### Manual Testing via stdio

You can also test by piping JSON-RPC messages directly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | deno run --allow-all src/main.ts
```

## License

MIT
