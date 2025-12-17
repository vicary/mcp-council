/**
 * Interactive TUI for viewing council member and candidate chat histories
 */

import { promptSelect } from "@std/cli/unstable-prompt-select";
import * as colors from "@std/fmt/colors";
import type { Candidate, Member, Persona } from "./db.ts";
import { CouncilDB } from "./db.ts";
import type { ChatMessage } from "./llm.ts";

// ANSI escape codes for cursor and screen control
const ESC = "\x1b";
const CLEAR_SCREEN = `${ESC}[2J`;
const CURSOR_HOME = `${ESC}[H`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;

// Minimum terminal size requirements
const MIN_COLS = 60;
const MIN_ROWS = 10;
const MAX_CONTENT_WIDTH = 120;

/**
 * Get terminal size
 */
function getTerminalSize(): { rows: number; cols: number } {
  try {
    const size = Deno.consoleSize();
    return { rows: size.rows, cols: size.columns };
  } catch {
    return { rows: 24, cols: 80 };
  }
}

/**
 * Clear the screen and move cursor to home
 */
function clearScreen(): void {
  console.log(CLEAR_SCREEN + CURSOR_HOME);
}

/**
 * Check if terminal size is sufficient
 */
function isTerminalTooSmall(): boolean {
  const { rows, cols } = getTerminalSize();
  return cols < MIN_COLS || rows < MIN_ROWS;
}

/**
 * Render an error screen when terminal is too small
 */
function renderTooSmallScreen(): void {
  const { rows, cols } = getTerminalSize();
  console.log(CLEAR_SCREEN + CURSOR_HOME);

  // Fill entire screen with red background
  const message1 = "Terminal too small!";
  const message2 = `Current: ${cols}x${rows}`;
  const message3 = `Minimum: ${MIN_COLS}x${MIN_ROWS}`;
  const message4 = "Please resize your terminal";

  // Center the messages vertically
  const totalLines = 6;
  const startRow = Math.max(0, Math.floor((rows - totalLines) / 2));

  for (let i = 0; i < rows; i++) {
    if (i === startRow) {
      console.log(
        colors.bgRed(
          colors.white(
            colors.bold(
              message1.padStart(Math.floor((cols + message1.length) / 2))
                .padEnd(cols),
            ),
          ),
        ),
      );
    } else if (i === startRow + 2) {
      console.log(
        colors.bgRed(
          colors.white(
            message2.padStart(Math.floor((cols + message2.length) / 2)).padEnd(
              cols,
            ),
          ),
        ),
      );
    } else if (i === startRow + 3) {
      console.log(
        colors.bgRed(
          colors.white(
            message3.padStart(Math.floor((cols + message3.length) / 2)).padEnd(
              cols,
            ),
          ),
        ),
      );
    } else if (i === startRow + 5) {
      console.log(
        colors.bgRed(
          colors.yellow(
            message4.padStart(Math.floor((cols + message4.length) / 2)).padEnd(
              cols,
            ),
          ),
        ),
      );
    } else {
      console.log(colors.bgRed(" ".repeat(cols)));
    }
  }
}

/**
 * Format a timestamp to a readable date string
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Word wrap text to fit within a given width
 */
function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      const currentVisibleLength = colors.stripAnsiCode(currentLine).length;
      const wordVisibleLength = colors.stripAnsiCode(word).length;
      if (currentVisibleLength + wordVisibleLength + 1 <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

/**
 * Render a box with title
 */
function renderBox(title: string, content: string[], width: number): string[] {
  const lines: string[] = [];
  const innerWidth = width - 4; // Space inside the box (excluding "│ " and " │")

  // Top border: ┌─ + ` title ` + ─...─ + ┐
  // Total width should be: 1 (┌) + 1 (─) + title.length + 2 (spaces) + dashes + 1 (┐) = width
  // Dashes = width - 1 - 1 - title.length - 2 - 1 = width - title.length - 5
  const titleSection = colors.bold(` ${title} `);
  const dashesNeeded = Math.max(0, width - title.length - 5);
  lines.push(
    colors.cyan("┌─") +
      colors.cyan(titleSection) +
      colors.cyan("─".repeat(dashesNeeded)) +
      colors.cyan("┐"),
  );

  // Content
  for (const line of content) {
    const wrapped = wordWrap(line, innerWidth);
    for (const wrappedLine of wrapped) {
      // Use stripAnsiCode to get the visible length for proper padding
      const visibleLength = colors.stripAnsiCode(wrappedLine).length;
      const padding = " ".repeat(Math.max(0, innerWidth - visibleLength));
      lines.push(colors.cyan("│ ") + wrappedLine + padding + colors.cyan(" │"));
    }
  }

  // Bottom border: └ + ─...─ + ┘
  // Total width should be: 1 (└) + dashes + 1 (┘) = width
  // Dashes = width - 2
  lines.push(
    colors.cyan("└") + colors.cyan("─".repeat(width - 2)) + colors.cyan("┘"),
  );

  return lines;
}

/**
 * Format persona details
 */
function formatPersona(persona: Persona): string[] {
  return [
    colors.bold(colors.magenta("Name: ")) + persona.name,
    "",
    colors.bold(colors.yellow("Background:")),
    persona.background,
    "",
    colors.bold(colors.green("Values:")),
    persona.values.map((v) => `  • ${v}`).join("\n"),
    "",
    colors.bold(colors.cyan("Traits:")),
    persona.traits.map((t) => `  • ${t}`).join("\n"),
    "",
    colors.bold(colors.red("Decision Style:")),
    persona.decisionStyle,
  ];
}

/**
 * Format a single chat message
 */
function formatChatMessage(msg: ChatMessage, width: number): string[] {
  const lines: string[] = [];
  const roleColors: Record<string, (s: string) => string> = {
    system: colors.bgMagenta,
    user: colors.bgBlue,
    assistant: colors.bgGreen,
  };

  const roleColor = roleColors[msg.role] || colors.bgYellow;
  const roleLabel = roleColor(colors.bold(` ${msg.role.toUpperCase()} `));
  const timestamp = colors.dim(formatTimestamp(msg.timestamp));

  lines.push("");
  lines.push(`${roleLabel} ${timestamp}`);
  lines.push(colors.gray("─".repeat(Math.min(width - 4, 60))));

  const wrapped = wordWrap(msg.content, width - 4);
  for (const line of wrapped) {
    lines.push("  " + line);
  }

  return lines;
}

/**
 * Scrollable view for chat history
 */
async function showScrollableView(
  title: string,
  personaLines: string[],
  statsLines: string[],
  chatHistory: ChatMessage[],
): Promise<void> {
  // Function to build content lines for current terminal size
  const buildContent = (): string[] => {
    const { cols } = getTerminalSize();
    const contentWidth = Math.min(cols - 2, MAX_CONTENT_WIDTH);
    const allLines: string[] = [];

    // Header
    allLines.push("");
    allLines.push(
      colors.bgCyan(colors.bold(` ${title} `.padEnd(contentWidth, " "))),
    );
    allLines.push("");

    // Persona section
    allLines.push(...renderBox("Persona", personaLines, contentWidth));
    allLines.push("");

    // Stats section
    allLines.push(...renderBox("Statistics", statsLines, contentWidth));
    allLines.push("");

    // Chat history section
    if (chatHistory.length === 0) {
      allLines.push(colors.dim("  No chat history available."));
    } else {
      allLines.push(
        colors.bold(
          colors.yellow(
            `═══ Chat History (${chatHistory.length} messages) ═══`,
          ),
        ),
      );
      for (const msg of chatHistory) {
        allLines.push(...formatChatMessage(msg, contentWidth));
      }
    }

    allLines.push("");
    allLines.push(colors.dim("─".repeat(contentWidth)));

    return allLines;
  };

  // State
  let allLines = buildContent();
  let scrollOffset = 0;
  let needsRebuild = false;

  // Get current dimensions for rendering
  const getDimensions = () => {
    const { rows, cols } = getTerminalSize();
    const visibleRows = rows - 3; // Reserve space for help line
    const maxOffset = Math.max(0, allLines.length - visibleRows);
    return { rows, cols, visibleRows, maxOffset };
  };

  // Setup raw mode for keyboard input
  Deno.stdin.setRaw(true);
  console.log(CURSOR_HIDE);

  const render = () => {
    // Check for minimum size
    if (isTerminalTooSmall()) {
      renderTooSmallScreen();
      return;
    }

    // Rebuild content if needed (after resize)
    if (needsRebuild) {
      allLines = buildContent();
      needsRebuild = false;
    }

    const { visibleRows, maxOffset } = getDimensions();

    // Clamp scroll offset to valid range
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));

    console.log(CLEAR_SCREEN + CURSOR_HOME);

    // Render visible lines
    for (
      let i = 0;
      i < visibleRows && i + scrollOffset < allLines.length;
      i++
    ) {
      console.log(allLines[i + scrollOffset]);
    }

    // Scroll indicator
    const scrollPercent = maxOffset > 0
      ? Math.round((scrollOffset / maxOffset) * 100)
      : 100;
    const scrollInfo = maxOffset > 0 ? ` [${scrollPercent}%]` : "";

    // Help line at bottom
    console.log("");
    console.log(
      colors.dim(
        `↑/k: Up | ↓/j: Down | PgUp/u: Page Up | PgDn/d: Page Down | Home/g: Top | End/G: Bottom | q/Esc: Back${scrollInfo}`,
      ),
    );
  };

  // Set up SIGWINCH handler for terminal resize
  const onResize = () => {
    needsRebuild = true;
    render();
  };
  let hasResizeHandler = false;
  try {
    Deno.addSignalListener("SIGWINCH", onResize);
    hasResizeHandler = true;
  } catch {
    // SIGWINCH not available on this platform (e.g., Windows)
  }

  render();

  // Read keyboard input
  const buf = new Uint8Array(3);
  try {
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;

      const key = buf.slice(0, n);
      const { visibleRows, maxOffset } = getDimensions();

      // Check for escape sequences (arrow keys, etc.)
      if (key[0] === 27) {
        // ESC
        if (key.length === 1) {
          // Just ESC key - exit
          break;
        }
        if (key[1] === 91) {
          // CSI sequence
          switch (key[2]) {
            case 65: // Up arrow
              scrollOffset = Math.max(0, scrollOffset - 1);
              break;
            case 66: // Down arrow
              scrollOffset = Math.min(maxOffset, scrollOffset + 1);
              break;
            case 53: // Page Up (might be followed by ~)
              scrollOffset = Math.max(0, scrollOffset - visibleRows);
              break;
            case 54: // Page Down (might be followed by ~)
              scrollOffset = Math.min(maxOffset, scrollOffset + visibleRows);
              break;
            case 72: // Home
              scrollOffset = 0;
              break;
            case 70: // End
              scrollOffset = maxOffset;
              break;
          }
        }
      } else {
        // Regular key
        const char = String.fromCharCode(key[0]);
        switch (char) {
          case "q":
          case "Q":
            return;
          case "k":
          case "K":
            scrollOffset = Math.max(0, scrollOffset - 1);
            break;
          case "j":
          case "J":
            scrollOffset = Math.min(maxOffset, scrollOffset + 1);
            break;
          case "u":
          case "U":
            scrollOffset = Math.max(0, scrollOffset - visibleRows);
            break;
          case "d":
          case "D":
            scrollOffset = Math.min(maxOffset, scrollOffset + visibleRows);
            break;
          case "g":
            scrollOffset = 0;
            break;
          case "G":
            scrollOffset = maxOffset;
            break;
        }
      }

      render();
    }
  } finally {
    // Clean up signal handler
    if (hasResizeHandler) {
      Deno.removeSignalListener("SIGWINCH", onResize);
    }
    Deno.stdin.setRaw(false);
    console.log(CURSOR_SHOW);
    clearScreen();
  }
}

/**
 * Show member details
 */
async function showMemberDetails(
  member: Member,
  db: CouncilDB,
): Promise<"back" | "deleted" | "demoted"> {
  const personaLines = formatPersona(member.persona);
  const statsLines = [
    colors.bold("ID: ") + member.id,
    colors.bold("Created: ") + formatTimestamp(member.createdAt),
    colors.bold("Promoted: ") + formatTimestamp(member.promotedAt),
    colors.bold("Chat Messages: ") + member.chatHistory.length.toString(),
  ];

  await showScrollableView(
    `Council Member: ${member.persona.name}`,
    personaLines,
    statsLines,
    member.chatHistory,
  );

  // Show action menu after viewing
  clearScreen();
  console.log("");
  console.log(colors.bgCyan(colors.bold(`  ${member.persona.name}  `)));
  console.log("");

  const options = [
    { label: "← Back to list", value: "back" },
    { label: colors.yellow("⬇ Demote to candidate"), value: "demote" },
    { label: colors.red("🗑 Delete permanently"), value: "delete" },
  ];

  const selected = await promptSelect("Choose an action:", options, {
    clear: false,
  });

  if (!selected || selected.value === "back") {
    return "back";
  }

  if (selected.value === "demote") {
    // Confirm demotion
    clearScreen();
    console.log("");
    console.log(colors.yellow(`  Demote ${member.persona.name} to candidate?`));
    console.log(
      colors.dim("  They will lose their council seat and become a candidate."),
    );
    console.log("");

    const confirmOptions = [
      { label: "No, cancel", value: "cancel" },
      { label: colors.yellow("Yes, demote"), value: "confirm" },
    ];

    const confirm = await promptSelect("Confirm:", confirmOptions, {
      clear: false,
    });
    if (confirm?.value === "confirm") {
      // Convert member to candidate
      const candidate: Candidate = {
        id: member.id.replace("mem_", "cand_"),
        persona: member.persona,
        createdAt: member.createdAt,
        fitness: 0,
        chatHistory: member.chatHistory,
      };

      // Update state
      const state = await db.getCouncilState();
      state.memberIds = state.memberIds.filter((id) => id !== member.id);
      state.candidateIds.push(candidate.id);
      state.lastRemovalCauses = [
        `${member.persona.name} manually demoted via TUI`,
        ...state.lastRemovalCauses.slice(0, 9),
      ];

      await db.saveCandidate(candidate);
      await db.deleteMember(member.id);
      await db.saveCouncilState(state);

      console.log(
        colors.green(
          `\n  ${member.persona.name} has been demoted to candidate.\n`,
        ),
      );
      console.log(colors.dim("  Press Enter to continue..."));
      prompt("");
      return "demoted";
    }
    return "back";
  }

  if (selected.value === "delete") {
    // Confirm deletion
    clearScreen();
    console.log("");
    console.log(colors.red(`  DELETE ${member.persona.name}?`));
    console.log(
      colors.dim(
        "  This action cannot be undone. All chat history will be lost.",
      ),
    );
    console.log("");

    const confirmOptions = [
      { label: "No, cancel", value: "cancel" },
      { label: colors.red("Yes, delete permanently"), value: "confirm" },
    ];

    const confirm = await promptSelect("Confirm:", confirmOptions, {
      clear: false,
    });
    if (confirm?.value === "confirm") {
      // Update state
      const state = await db.getCouncilState();
      state.memberIds = state.memberIds.filter((id) => id !== member.id);
      state.lastRemovalCauses = [
        `${member.persona.name} manually deleted via TUI`,
        ...state.lastRemovalCauses.slice(0, 9),
      ];

      await db.deleteMember(member.id);
      await db.saveCouncilState(state);

      console.log(
        colors.green(`\n  ${member.persona.name} has been deleted.\n`),
      );
      console.log(colors.dim("  Press Enter to continue..."));
      prompt("");
      return "deleted";
    }
    return "back";
  }

  return "back";
}

/**
 * Show candidate details
 */
async function showCandidateDetails(
  candidate: Candidate,
  db: CouncilDB,
): Promise<"back" | "deleted"> {
  const personaLines = formatPersona(candidate.persona);
  const statsLines = [
    colors.bold("ID: ") + candidate.id,
    colors.bold("Created: ") + formatTimestamp(candidate.createdAt),
    colors.bold("Fitness Score: ") + candidate.fitness.toString(),
    colors.bold("Chat Messages: ") + candidate.chatHistory.length.toString(),
  ];

  await showScrollableView(
    `Candidate: ${candidate.persona.name}`,
    personaLines,
    statsLines,
    candidate.chatHistory,
  );

  // Show action menu after viewing
  clearScreen();
  console.log("");
  console.log(colors.bgCyan(colors.bold(`  ${candidate.persona.name}  `)));
  console.log("");

  const options = [
    { label: "← Back to list", value: "back" },
    { label: colors.red("🗑 Delete permanently"), value: "delete" },
  ];

  const selected = await promptSelect("Choose an action:", options, {
    clear: false,
  });

  if (!selected || selected.value === "back") {
    return "back";
  }

  if (selected.value === "delete") {
    // Confirm deletion
    clearScreen();
    console.log("");
    console.log(colors.red(`  DELETE ${candidate.persona.name}?`));
    console.log(
      colors.dim(
        "  This action cannot be undone. All chat history will be lost.",
      ),
    );
    console.log("");

    const confirmOptions = [
      { label: "No, cancel", value: "cancel" },
      { label: colors.red("Yes, delete permanently"), value: "confirm" },
    ];

    const confirm = await promptSelect("Confirm:", confirmOptions, {
      clear: false,
    });
    if (confirm?.value === "confirm") {
      // Update state
      const state = await db.getCouncilState();
      state.candidateIds = state.candidateIds.filter((id) =>
        id !== candidate.id
      );
      state.lastRemovalCauses = [
        `${candidate.persona.name} manually deleted via TUI`,
        ...state.lastRemovalCauses.slice(0, 9),
      ];

      await db.deleteCandidate(candidate.id);
      await db.saveCouncilState(state);

      console.log(
        colors.green(`\n  ${candidate.persona.name} has been deleted.\n`),
      );
      console.log(colors.dim("  Press Enter to continue..."));
      prompt("");
      return "deleted";
    }
    return "back";
  }

  return "back";
}

/**
 * Show list of council members
 */
async function showMembersList(db: CouncilDB): Promise<void> {
  while (true) {
    clearScreen();
    const members = await db.getAllMembers();

    if (members.length === 0) {
      console.log(colors.yellow("\n  No council members found.\n"));
      console.log(colors.dim("  Press Enter to go back..."));
      prompt("");
      return;
    }

    const options = [
      ...members.map((m) => ({
        label: `${m.persona.name} (${m.chatHistory.length} msgs, promoted ${
          formatTimestamp(m.promotedAt)
        })`,
        value: m.id,
      })),
      { label: colors.dim("← Back to main menu"), value: "__back__" },
    ];

    const selected = await promptSelect("Select a council member:", options, {
      clear: true,
    });

    if (!selected || selected.value === "__back__") {
      return;
    }

    const member = members.find((m) => m.id === selected.value);
    if (member) {
      await showMemberDetails(member, db);
    }
  }
}

/**
 * Show list of candidates
 */
async function showCandidatesList(db: CouncilDB): Promise<void> {
  while (true) {
    clearScreen();
    const candidates = await db.getAllCandidates();

    if (candidates.length === 0) {
      console.log(colors.yellow("\n  No candidates found.\n"));
      console.log(colors.dim("  Press Enter to go back..."));
      prompt("");
      return;
    }

    // Sort by fitness score descending
    candidates.sort((a, b) => b.fitness - a.fitness);

    const options = [
      ...candidates.map((c) => ({
        label:
          `${c.persona.name} (fitness: ${c.fitness}, ${c.chatHistory.length} msgs)`,
        value: c.id,
      })),
      { label: colors.dim("← Back to main menu"), value: "__back__" },
    ];

    const selected = await promptSelect("Select a candidate:", options, {
      clear: true,
    });

    if (!selected || selected.value === "__back__") {
      return;
    }

    const candidate = candidates.find((c) => c.id === selected.value);
    if (candidate) {
      await showCandidateDetails(candidate, db);
    }
  }
}
/**
 * Show council overview/stats
 */
async function showOverview(db: CouncilDB): Promise<void> {
  clearScreen();
  const state = await db.getCouncilState();
  const members = await db.getAllMembers();
  const candidates = await db.getAllCandidates();

  const totalMemberMessages = members.reduce(
    (sum, m) => sum + m.chatHistory.length,
    0,
  );
  const totalCandidateMessages = candidates.reduce(
    (sum, c) => sum + c.chatHistory.length,
    0,
  );
  const avgCandidateFitness = candidates.length > 0
    ? (
      candidates.reduce((sum, c) => sum + c.fitness, 0) / candidates.length
    ).toFixed(2)
    : "N/A";

  console.log("");
  console.log(colors.bgCyan(colors.bold("  Council Overview  ")));
  console.log("");
  console.log(colors.bold("Council State:"));
  console.log(`  • Members: ${colors.green(members.length.toString())} / 8`);
  console.log(
    `  • Candidates: ${
      colors.yellow(candidates.length.toString())
    } / ${state.targetPoolSize}`,
  );
  console.log(`  • Rounds since eviction: ${state.roundsSinceEviction}`);
  console.log("");
  console.log(colors.bold("Message Statistics:"));
  console.log(`  • Total member messages: ${totalMemberMessages}`);
  console.log(`  • Total candidate messages: ${totalCandidateMessages}`);
  console.log("");
  console.log(colors.bold("Candidate Pool:"));
  console.log(`  • Average fitness: ${avgCandidateFitness}`);
  console.log(`  • Target pool size: ${state.targetPoolSize}`);
  console.log("");

  if (state.lastRemovalCauses.length > 0) {
    console.log(colors.bold(colors.red("Last Removal Causes:")));
    for (const cause of state.lastRemovalCauses) {
      console.log(`  • ${cause}`);
    }
    console.log("");
  }

  console.log(colors.dim("Press Enter to go back..."));
  prompt("");
}

/**
 * Main menu
 */
async function mainMenu(db: CouncilDB): Promise<boolean> {
  clearScreen();

  const state = await db.getCouncilState();

  console.log("");
  console.log(colors.bgMagenta(colors.bold("  🏛️  MCP Council TUI Viewer  ")));
  console.log("");
  console.log(
    colors.dim(
      `  Council: ${state.memberIds.length} members | Pool: ${state.candidateIds.length} candidates`,
    ),
  );
  console.log("");

  const options = [
    { label: "📊 Overview - Council statistics", value: "overview" },
    {
      label: `👥 Council Members (${state.memberIds.length})`,
      value: "members",
    },
    {
      label: `🎯 Candidates (${state.candidateIds.length})`,
      value: "candidates",
    },
    { label: colors.dim("❌ Exit"), value: "exit" },
  ];

  const selected = await promptSelect("Choose an option:", options, {
    clear: false,
  });

  if (!selected) {
    return false;
  }

  switch (selected.value) {
    case "overview":
      await showOverview(db);
      break;
    case "members":
      await showMembersList(db);
      break;
    case "candidates":
      await showCandidatesList(db);
      break;
    case "exit":
      return false;
  }

  return true;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log(colors.dim("Opening database..."));

  let db: CouncilDB;
  try {
    db = await CouncilDB.open();
  } catch (error) {
    console.error(colors.red("Failed to open database:"), error);
    Deno.exit(1);
  }

  try {
    // Main loop
    while (await mainMenu(db)) {
      // Continue until user exits
    }

    clearScreen();
    console.log(colors.green("\n  Goodbye! 👋\n"));
  } finally {
    db.close();
  }
}

// Run the TUI
if (import.meta.main) {
  main();
}
