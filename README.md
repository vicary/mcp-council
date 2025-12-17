# AI Council MCP Server

An 8-member AI council exposed as an MCP server. TypeScript + Deno, persisted to
SQLite.

## Quick Start

### Prerequisites

- [Deno](https://deno.land/) 2.x or later
- OpenAI API key (or compatible endpoint)

### Environment Variables

```bash
export OPENAI_API_KEY="your-api-key"
# Optional: customize endpoint and model
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o-mini"
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

Add to your `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "council": {
        "command": "/path/to/mcp-council",
        "env": {
          "OPENAI_API_KEY": "your-api-key"
        }
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
    "council": {
      "command": "/path/to/mcp-council",
      "env": {
        "OPENAI_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Using with `deno run` (without compiling)

```json
{
  "mcpServers": {
    "council": {
      "command": "deno",
      "args": ["run", "--allow-all", "/path/to/mcp-council/src/main.ts"],
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

## Project Structure

```
mcp-council/
├── src/
│   ├── main.ts           # Entry point
│   ├── server.ts         # MCP server implementation
│   ├── db.ts             # Deno.Kv persistence layer + domain types
│   ├── llm.ts            # LLM provider abstraction
│   ├── orchestrator.ts   # Voting flow management
│   ├── council.ts        # Council lifecycle
│   ├── candidate-pool.ts # Candidate management
│   ├── persona.ts        # Persona generation
│   └── utils/
│       ├── id.ts         # ID generation
│       └── summarize.ts  # Context summarization
├── tests/
│   ├── db.test.ts
│   ├── llm.test.ts
│   ├── persona.test.ts
│   ├── orchestrator.test.ts
│   ├── candidate-pool.test.ts
│   ├── council.test.ts
│   ├── server.test.ts
│   ├── integration.test.ts
│   └── utils/
│       ├── id.test.ts
│       └── summarize.test.ts
├── deno.json             # Deno configuration
├── Epic.md               # Feature specification
├── TechnicalGuideline.md # Coding guidelines
└── README.md             # This file
```

## License

MIT
