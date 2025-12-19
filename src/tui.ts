/**
 * Interactive TUI for viewing council member and candidate chat histories
 */

import {
  clearScreen as cliffyClearScreen,
  cursorTo,
} from "@cliffy/ansi/ansi-escapes";
import { colors } from "@cliffy/ansi/colors";
import { Confirm, Input, Select } from "@cliffy/prompt";
import pagerImport from "less-pager-mini";
// @ts-ignore: internal module access for reset
import { resetConfig } from "less-pager-mini/dist/config.js";
import type { Candidate, Member, Persona } from "./db.ts";
import { CouncilDB } from "./db.ts";
import type { ChatMessage } from "./llm.ts";

const pager = pagerImport as unknown as typeof pagerImport.default;

/**
 * Clear the screen and move cursor to home
 */
function clearScreen(): void {
  console.log(cliffyClearScreen + cursorTo(0, 0));
}

/**
 * Get terminal size for responsive layouts
 */
function getTerminalSize(): { columns: number; rows: number } {
  try {
    const size = Deno.consoleSize();
    return { columns: size.columns || 80, rows: size.rows || 24 };
  } catch {
    return { columns: 80, rows: 24 };
  }
}

/**
 * Word wrap text to fit within a maximum width
 */
function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length === 0) {
        currentLine = word;
      } else if (currentLine.length + 1 + word.length <= maxWidth) {
        currentLine += " " + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Strip ANSI codes to get actual visible length
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Render text content in a beautiful Unicode box
 * Box is full terminal width (content wraps to fit)
 */
function renderBox(
  title: string,
  lines: string[],
  titleColor: (s: string) => string = colors.bold.cyan,
): string[] {
  const { columns } = getTerminalSize();
  const boxWidth = columns - 2; // Leave small margin
  const contentWidth = boxWidth - 4; // "│ " + content + " │"

  // Word-wrap all lines to fit within the box
  const wrappedLines: string[] = [];
  for (const line of lines) {
    const visibleLine = stripAnsi(line);
    if (visibleLine.length <= contentWidth) {
      wrappedLines.push(line);
    } else {
      // For lines with ANSI codes, wrap the visible text
      const wrapped = wordWrap(visibleLine, contentWidth);
      wrappedLines.push(...wrapped);
    }
  }

  const result: string[] = [];

  // Top border with title
  const titleText = ` ${title} `;
  const dashesNeeded = boxWidth - stripAnsi(titleText).length - 3; // -3 for ╭─ and ╮
  result.push(
    colors.dim("╭─") + titleColor(titleText) +
      colors.dim("─".repeat(Math.max(0, dashesNeeded)) + "╮"),
  );

  // Content lines
  for (const line of wrappedLines) {
    const visibleLength = stripAnsi(line).length;
    const padding = contentWidth - visibleLength;
    result.push(
      colors.dim("│ ") + line + " ".repeat(Math.max(0, padding)) +
        colors.dim(" │"),
    );
  }

  // Bottom border
  result.push(colors.dim("╰" + "─".repeat(boxWidth - 2) + "╯"));

  return result;
}

/**
 * Format a timestamp to a readable date string
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Format persona details
 */
function formatPersona(persona: Persona): string[] {
  const lines: string[] = [];

  // Header section with Name and Model
  lines.push(colors.bold.magenta("Name: ") + persona.name);
  if (persona.model) {
    lines.push(colors.bold.blue("Model: ") + persona.model);
  }
  lines.push("");

  // Background
  lines.push(colors.bold.yellow("Background:"));
  lines.push(persona.background);
  lines.push("");

  // Values
  lines.push(colors.bold.green("Values:"));
  persona.values.forEach((v) => lines.push(`  • ${v}`));
  lines.push("");

  // Traits
  lines.push(colors.bold.cyan("Traits:"));
  persona.traits.forEach((t) => lines.push(`  • ${t}`));
  lines.push("");

  // Decision Style
  lines.push(colors.bold.red("Decision Style:"));
  lines.push(persona.decisionStyle);

  return lines;
}

/**
 * Format a single chat message (no wrapping - let pager handle it)
 */
function formatChatMessage(msg: ChatMessage): string[] {
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
  lines.push(colors.gray("─".repeat(60)));
  lines.push("");
  lines.push(msg.content);

  return lines;
}

/**
 * Scrollable view for profiles and chat history using less-pager-mini
 * Note: less-pager-mini handles terminal resize (SIGWINCH) and text wrapping natively
 */
async function showScrollableView(
  title: string,
  personaLines: string[],
  statsLines: string[],
  chatHistory: ChatMessage[],
): Promise<void> {
  // Pre-render all content as colored strings
  const allLines: string[] = [];

  // Header
  allLines.push("");
  allLines.push(colors.bgCyan.bold(` ${title} `));
  allLines.push("");

  // Persona section in a box
  allLines.push(...renderBox("Persona", personaLines, colors.bold.cyan));
  allLines.push("");

  // Stats section in a box
  allLines.push(...renderBox("Statistics", statsLines, colors.bold.cyan));
  allLines.push("");

  // Chat history section
  if (chatHistory.length === 0) {
    allLines.push(colors.dim("  No chat history available."));
  } else {
    allLines.push(
      colors.bold.yellow(
        `═══ Chat History (${chatHistory.length} messages) ═══`,
      ),
    );
    for (const msg of chatHistory.toReversed()) {
      allLines.push(...formatChatMessage(msg));
    }
  }

  allLines.push("");

  // Use less-pager-mini to display the pre-rendered content
  await pager(allLines.join("\n"), true);
  // Reset scroll position for next view
  resetConfig();
  clearScreen();
}

/**
 * Show member details
 */
async function showMemberProfile(member: Member): Promise<void> {
  const personaLines = formatPersona(member.persona);
  const statsLines = [
    colors.bold("ID: ") + member.id,
    colors.bold("Created: ") + formatTimestamp(member.createdAt),
    colors.bold("Promoted: ") + formatTimestamp(member.promotedAt),
    colors.bold("Active Context: ") + member.chatHistory.length.toString() +
    " msgs",
  ];

  await showScrollableView(
    `Council Member: ${member.persona.name}`,
    personaLines,
    statsLines,
    member.chatHistory,
  );
}

/**
 * Show message history (reverse chronological - newest first)
 */
async function showMessageHistory(
  db: CouncilDB,
  type: "member" | "candidate",
  id: string,
  name: string,
): Promise<void> {
  // Fetch all messages (up to 100)
  const result = await db.getMessageHistory(type, id, {
    limit: 100,
    reverse: true,
  });

  // Empty case is handled by action menu disabling the option
  if (result.items.length === 0) {
    return;
  }

  const messages = result.items;

  while (true) {
    clearScreen();

    console.log("");
    console.log(
      colors.bgCyan.bold(
        `  Message History: ${name} (${messages.length} total)  `,
      ),
    );
    console.log("");

    const options = [
      ...messages.map((msg, i) => {
        const roleColor = msg.role === "system"
          ? colors.magenta
          : msg.role === "user"
          ? colors.blue
          : colors.green;
        const preview = msg.content.slice(0, 60).replace(/\n/g, " ");
        return {
          name: `${roleColor(`[${msg.role}]`)} ${
            colors.dim(formatTimestamp(msg.timestamp))
          } ${preview}${msg.content.length > 60 ? "..." : ""}`,
          value: `msg_${i}`,
        };
      }),
      {
        name: colors.dim("← Back"),
        value: "__back__",
      },
    ];

    const selected = await Select.prompt({
      message: "Select a message to view:",
      options,
    });

    if (!selected || selected === "__back__") {
      return;
    }

    // View selected message
    const msgIndex = parseInt(selected.replace("msg_", ""));
    const msg = messages[msgIndex];
    if (msg) {
      const roleColors: Record<string, (s: string) => string> = {
        system: colors.magenta,
        user: colors.blue,
        assistant: colors.green,
      };
      const roleColor = roleColors[msg.role] || colors.yellow;

      const lines: string[] = [];
      lines.push("");
      lines.push(
        colors.bgCyan.bold(`  Message ${msgIndex + 1}/${messages.length}  `),
      );
      lines.push("");
      lines.push(
        colors.bold("Timestamp: ") + formatTimestamp(msg.timestamp),
      );
      lines.push(colors.bold("Role: ") + roleColor(msg.role));
      lines.push("");
      lines.push(colors.bold("Content:"));
      lines.push(msg.content);
      lines.push("");

      await pager(lines.join("\n"), true);
      resetConfig();
      clearScreen();
    }
  }
}

/**
 * Member action menu
 */
async function showMemberActions(
  member: Member,
  db: CouncilDB,
): Promise<{ action: "back" | "demoted"; id: string }> {
  while (true) {
    clearScreen();
    console.log("");
    console.log(colors.bgCyan.bold(`  ${member.persona.name}  `));
    console.log(
      colors.dim(`  ${member.persona.model || "default model"}`),
    );
    console.log("");

    const historyCount = await db.getHistoryCount("member", member.id);

    const options = [
      { name: "👤 Profile & Active Context", value: "profile" },
      {
        name: `📜 Message History (${historyCount})`,
        value: "history",
        disabled: historyCount === 0,
      },
      { name: colors.yellow("👎 Demote"), value: "demote" },
      { name: colors.dim("← Back to list"), value: "back" },
    ];

    const selected = await Select.prompt({
      message: "Choose an action:",
      options,
    });

    if (!selected || selected === "back") {
      return { action: "back", id: member.id };
    }

    if (selected === "profile") {
      await showMemberProfile(member);
      continue;
    }

    if (selected === "history") {
      await showMessageHistory(db, "member", member.id, member.persona.name);
      continue;
    }

    if (selected === "demote") {
      // Confirm demotion
      clearScreen();
      console.log("");
      console.log(
        colors.yellow(`  Demote ${member.persona.name} to candidate?`),
      );
      console.log(
        colors.dim(
          "  They will lose their council seat and become a candidate.",
        ),
      );
      console.log("");

      const confirm = await Confirm.prompt({
        message: "Confirm demotion?",
        default: false,
      });

      if (confirm) {
        // Convert member to candidate
        const candidate: Candidate = {
          id: member.id,
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

        return { action: "demoted", id: member.id };
      }
      continue;
    }
  }
}

/**
 * Show candidate profile
 */
async function showCandidateProfile(candidate: Candidate): Promise<void> {
  const personaLines = formatPersona(candidate.persona);
  const statsLines = [
    colors.bold("ID: ") + candidate.id,
    colors.bold("Created: ") + formatTimestamp(candidate.createdAt),
    colors.bold("Fitness Score: ") + candidate.fitness.toString(),
    colors.bold("Active Context: ") + candidate.chatHistory.length.toString() +
    " msgs",
  ];

  if (candidate.evictedAt) {
    statsLines.push(
      colors.bold.red("Evicted: ") +
        formatTimestamp(candidate.evictedAt),
    );
    if (candidate.evictionReason) {
      statsLines.push(
        colors.bold.red("Reason: ") + candidate.evictionReason,
      );
    }
  }

  await showScrollableView(
    `Candidate: ${candidate.persona.name}`,
    personaLines,
    statsLines,
    candidate.chatHistory,
  );
}

/**
 * Candidate action menu
 */
async function showCandidateActions(
  candidate: Candidate,
  db: CouncilDB,
): Promise<{ action: "back" | "evicted" | "promoted"; id: string }> {
  while (true) {
    clearScreen();
    console.log("");
    console.log(colors.bgCyan.bold(`  ${candidate.persona.name}  `));
    console.log(
      colors.dim(
        `  ${
          candidate.persona.model || "default model"
        } | Fitness: ${candidate.fitness}`,
      ),
    );
    console.log("");

    const historyCount = await db.getHistoryCount("candidate", candidate.id);

    const options = [
      { name: "👤 Profile & Active Context", value: "profile" },
      {
        name: `📜 Message History (${historyCount})`,
        value: "history",
        disabled: historyCount === 0,
      },
      { name: colors.green("👍 Promote"), value: "promote" },
      { name: colors.red("🚫 Evict"), value: "evict" },
      { name: colors.dim("← Back to list"), value: "back" },
    ];

    const selected = await Select.prompt({
      message: "Choose an action:",
      options,
    });

    if (!selected || selected === "back") {
      return { action: "back", id: candidate.id };
    }

    if (selected === "profile") {
      await showCandidateProfile(candidate);
      continue;
    }

    if (selected === "history") {
      await showMessageHistory(
        db,
        "candidate",
        candidate.id,
        candidate.persona.name,
      );
      continue;
    }

    if (selected === "promote") {
      // Confirm promotion
      clearScreen();
      console.log("");
      console.log(
        colors.green(`  Promote ${candidate.persona.name} to council?`),
      );
      console.log(
        colors.dim("  They will become a full council member."),
      );
      console.log("");

      const confirm = await Confirm.prompt({
        message: "Confirm promotion?",
        default: false,
      });

      if (confirm) {
        // Convert candidate to member
        const member: Member = {
          id: candidate.id,
          persona: candidate.persona,
          createdAt: candidate.createdAt,
          promotedAt: Date.now(),
          chatHistory: candidate.chatHistory,
        };

        // Update state
        const state = await db.getCouncilState();
        state.candidateIds = state.candidateIds.filter(
          (id) => id !== candidate.id,
        );
        state.memberIds.push(member.id);

        await db.saveMember(member);
        await db.deleteCandidate(candidate.id);
        await db.saveCouncilState(state);

        return { action: "promoted", id: candidate.id };
      }
      continue;
    }

    if (selected === "evict") {
      // Ask for eviction reason
      clearScreen();
      console.log("");
      console.log(colors.red(`  Evict ${candidate.persona.name}?`));
      console.log(
        colors.dim(
          "  They will be marked as evicted and moved to the evicted list.",
        ),
      );
      console.log("");

      const reason = await Input.prompt({
        message: "Eviction reason:",
      });

      if (!reason || reason.trim() === "") {
        console.log(
          colors.yellow("\n  Eviction cancelled (no reason provided).\n"),
        );
        await Input.prompt({
          message: colors.dim("Press Enter to continue..."),
          default: "",
        });
        continue;
      }

      const confirm = await Confirm.prompt({
        message: "Confirm eviction?",
        default: false,
      });

      if (confirm) {
        // Evict candidate first (this updates candidateIds in state)
        await db.evictCandidate(candidate.id, reason.trim());

        // Then update removal causes on the fresh state
        const state = await db.getCouncilState();
        state.lastRemovalCauses = [
          `${candidate.persona.name} manually evicted via TUI: ${reason}`,
          ...state.lastRemovalCauses.slice(0, 9),
        ];
        await db.saveCouncilState(state);

        return { action: "evicted", id: candidate.id };
      }
      continue;
    }
  }
}

/**
 * Navigation result from list views
 */
type ListNavigation =
  | { type: "main-menu" }
  | { type: "members"; selectedId?: string }
  | { type: "candidates"; selectedId?: string }
  | { type: "evicted"; selectedId?: string };

/**
 * Show list of council members
 * Handles state transitions when members are demoted
 */
async function showMembersList(
  db: CouncilDB,
  initialSelectedId?: string,
): Promise<ListNavigation> {
  let selectedId: string | undefined = initialSelectedId;

  while (true) {
    clearScreen();
    const { items: members } = await db.getAllMembers();

    // Empty case - return to main menu
    if (members.length === 0) {
      return { type: "main-menu" };
    }

    const options = [
      ...members.map((m) => ({
        name: `${m.persona.name} ${
          m.persona.model ? colors.dim(`[${m.persona.model}]`) : ""
        } (${m.chatHistory.length} ctx, promoted ${
          formatTimestamp(m.promotedAt)
        })`,
        value: m.id,
      })),
      { name: colors.dim("← Back to main menu"), value: "__back__" },
    ];

    // Find default option index based on selectedId
    const defaultIndex = selectedId
      ? options.findIndex((o) => o.value === selectedId)
      : undefined;

    const selected = await Select.prompt({
      message: "Select a council member:",
      options,
      default: defaultIndex !== undefined && defaultIndex >= 0
        ? options[defaultIndex].value
        : undefined,
    });

    if (!selected || selected === "__back__") {
      return { type: "main-menu" };
    }

    const member = members.find((m) => m.id === selected);
    if (member) {
      const result = await showMemberActions(member, db);
      selectedId = result.id;

      if (result.action === "demoted") {
        // Member was demoted - show candidate actions for same person
        const candidate = await db.getCandidate(result.id);
        if (candidate) {
          const candidateResult = await showCandidateActionsLoop(
            candidate,
            db,
          );
          selectedId = candidateResult.id;
          // If they were promoted back, continue in members list
          if (candidateResult.action === "promoted") {
            continue;
          }
          // If evicted, navigate to evicted list
          if (candidateResult.action === "evicted") {
            return { type: "evicted", selectedId: candidateResult.id };
          }
          // If back, navigate to candidates list
          return { type: "candidates", selectedId: candidateResult.id };
        }
      }
    }
  }
}

/**
 * Helper to handle candidate actions with state transitions
 */
async function showCandidateActionsLoop(
  candidate: Candidate,
  db: CouncilDB,
): Promise<{ action: "back" | "evicted" | "promoted"; id: string }> {
  let currentCandidate = candidate;

  while (true) {
    const result = await showCandidateActions(currentCandidate, db);

    if (result.action === "back") {
      return result;
    }

    if (result.action === "promoted") {
      // Candidate was promoted - show member actions for same person
      const member = await db.getMember(result.id);
      if (member) {
        const memberResult = await showMemberActionsLoop(member, db);
        // If they were demoted back, continue with candidate
        if (memberResult.action === "demoted") {
          const newCandidate = await db.getCandidate(memberResult.id);
          if (newCandidate) {
            currentCandidate = newCandidate;
            continue;
          }
        }
        // If back, return promoted status
        return { action: "promoted", id: result.id };
      }
      return result;
    }

    if (result.action === "evicted") {
      // Candidate was evicted - show evicted actions for same person
      const evicted = await db.getEvictedCandidate(result.id);
      if (evicted) {
        const evictedResult = await showEvictedActionsLoop(evicted, db);
        // If restored, continue with candidate
        if (evictedResult.action === "restored") {
          const newCandidate = await db.getCandidate(evictedResult.id);
          if (newCandidate) {
            currentCandidate = newCandidate;
            continue;
          }
        }
        // If deleted or back, return evicted status
        return { action: "evicted", id: result.id };
      }
      return result;
    }
  }
}

/**
 * Helper to handle member actions with state transitions
 */
async function showMemberActionsLoop(
  member: Member,
  db: CouncilDB,
): Promise<{ action: "back" | "demoted"; id: string }> {
  let currentMember = member;

  while (true) {
    const result = await showMemberActions(currentMember, db);

    if (result.action === "back") {
      return result;
    }

    if (result.action === "demoted") {
      // Member was demoted - show candidate actions for same person
      const candidate = await db.getCandidate(result.id);
      if (candidate) {
        const candidateResult = await showCandidateActionsLoop(candidate, db);
        // If promoted back, continue with member
        if (candidateResult.action === "promoted") {
          const newMember = await db.getMember(candidateResult.id);
          if (newMember) {
            currentMember = newMember;
            continue;
          }
        }
        // If evicted or back, return demoted status
        return { action: "demoted", id: result.id };
      }
      return result;
    }
  }
}

/**
 * Helper to handle evicted actions with state transitions
 */
async function showEvictedActionsLoop(
  candidate: Candidate,
  db: CouncilDB,
): Promise<{ action: "back" | "deleted" | "restored"; id: string }> {
  let currentCandidate = candidate;

  while (true) {
    const result = await showEvictedCandidateActions(currentCandidate, db);

    if (result.action === "back" || result.action === "deleted") {
      return result;
    }

    if (result.action === "restored") {
      // Candidate was restored - show candidate actions for same person
      const restoredCandidate = await db.getCandidate(result.id);
      if (restoredCandidate) {
        const candidateResult = await showCandidateActionsLoop(
          restoredCandidate,
          db,
        );
        // If evicted again, continue with evicted
        if (candidateResult.action === "evicted") {
          const evicted = await db.getEvictedCandidate(candidateResult.id);
          if (evicted) {
            currentCandidate = evicted;
            continue;
          }
        }
        // If promoted or back, return restored status
        return { action: "restored", id: result.id };
      }
      return result;
    }
  }
}

/**
 * Show list of candidates
 * Handles state transitions when candidates are promoted or evicted
 */
async function showCandidatesList(
  db: CouncilDB,
  initialSelectedId?: string,
): Promise<ListNavigation> {
  let selectedId: string | undefined = initialSelectedId;

  while (true) {
    clearScreen();
    const { items: candidates } = await db.getAllCandidates();

    // Empty case - return to main menu
    if (candidates.length === 0) {
      return { type: "main-menu" };
    }

    // Sort by fitness score descending
    candidates.sort((a, b) => b.fitness - a.fitness);

    const options = [
      ...candidates.map((c) => ({
        name: `${c.persona.name} ${
          c.persona.model ? colors.dim(`[${c.persona.model}]`) : ""
        } (fitness: ${c.fitness}, ${c.chatHistory.length} msgs)`,
        value: c.id,
      })),
      { name: colors.dim("← Back to main menu"), value: "__back__" },
    ];

    // Find default option index based on selectedId
    const defaultIndex = selectedId
      ? options.findIndex((o) => o.value === selectedId)
      : undefined;

    const selected = await Select.prompt({
      message: "Select a candidate:",
      options,
      default: defaultIndex !== undefined && defaultIndex >= 0
        ? options[defaultIndex].value
        : undefined,
    });

    if (!selected || selected === "__back__") {
      return { type: "main-menu" };
    }

    const candidate = candidates.find((c) => c.id === selected);
    if (candidate) {
      const result = await showCandidateActionsLoop(candidate, db);
      selectedId = result.id;

      if (result.action === "promoted") {
        // Candidate was promoted - navigate to members list with them selected
        return { type: "members", selectedId: result.id };
      }

      if (result.action === "evicted") {
        // Candidate was evicted - navigate to evicted list with them selected
        return { type: "evicted", selectedId: result.id };
      }
    }
  }
}

/**
 * Show evicted candidate profile (read-only)
 */
async function showEvictedCandidateProfile(
  candidate: Candidate,
): Promise<void> {
  const personaLines = formatPersona(candidate.persona);
  const statsLines = [
    colors.bold("ID: ") + candidate.id,
    colors.bold("Created: ") + formatTimestamp(candidate.createdAt),
    colors.bold("Fitness Score: ") + candidate.fitness.toString(),
    colors.bold.red("Evicted: ") +
    formatTimestamp(candidate.evictedAt || 0),
    colors.bold.red("Reason: ") +
    (candidate.evictionReason || "Unknown"),
    colors.bold("Active Context: ") + candidate.chatHistory.length.toString() +
    " msgs",
  ];

  await showScrollableView(
    `Evicted: ${candidate.persona.name}`,
    personaLines,
    statsLines,
    candidate.chatHistory,
  );
}

/**
 * Evicted candidate action menu
 */
async function showEvictedCandidateActions(
  candidate: Candidate,
  db: CouncilDB,
): Promise<{ action: "back" | "deleted" | "restored"; id: string }> {
  while (true) {
    clearScreen();
    console.log("");
    console.log(
      colors.bgRed.bold(`  ${candidate.persona.name} (EVICTED)  `),
    );
    console.log(
      colors.dim(`  Evicted: ${formatTimestamp(candidate.evictedAt || 0)}`),
    );
    console.log("");

    const historyCount = await db.getHistoryCount("candidate", candidate.id);

    const options = [
      { name: "👤 Profile & Active Context", value: "profile" },
      {
        name: `📜 Message History (${historyCount})`,
        value: "history",
        disabled: historyCount === 0,
      },
      { name: colors.green("☥ Revive"), value: "restore" },
      { name: colors.red("🗑 Delete permanently"), value: "delete" },
      { name: colors.dim("← Back to list"), value: "back" },
    ];

    const selected = await Select.prompt({
      message: "Choose an action:",
      options,
    });

    if (!selected || selected === "back") {
      return { action: "back", id: candidate.id };
    }

    if (selected === "profile") {
      await showEvictedCandidateProfile(candidate);
      continue;
    }

    if (selected === "history") {
      await showMessageHistory(
        db,
        "candidate",
        candidate.id,
        candidate.persona.name,
      );
      continue;
    }

    if (selected === "restore") {
      // Confirm restoration
      clearScreen();
      console.log("");
      console.log(
        colors.green(`  Restore ${candidate.persona.name} to candidates?`),
      );
      console.log(
        colors.dim("  They will be added back to the candidate pool."),
      );
      console.log("");

      const confirm = await Confirm.prompt({
        message: "Confirm restoration?",
        default: false,
      });

      if (confirm) {
        // Remove eviction markers
        candidate.evictedAt = undefined;
        candidate.evictionReason = undefined;

        // Move from evicted to candidates
        await db.deleteEvictedCandidate(candidate.id);
        await db.saveCandidate(candidate);

        return { action: "restored", id: candidate.id };
      }
      continue;
    }

    if (selected === "delete") {
      // Confirm deletion
      clearScreen();
      console.log("");
      console.log(
        colors.red(`  DELETE ${candidate.persona.name} PERMANENTLY?`),
      );
      console.log(
        colors.dim(
          "  This action cannot be undone. All data will be lost.",
        ),
      );
      console.log("");

      const confirm = await Confirm.prompt({
        message: "Confirm permanent deletion?",
        default: false,
      });

      if (confirm) {
        await db.deleteEvictedCandidate(candidate.id);

        return { action: "deleted", id: candidate.id };
      }
      continue;
    }
  }
}

/**
 * Show list of evicted candidates (paginated, reverse order - newest first)
 * Handles state transitions when evicted candidates are restored or deleted
 */
async function showEvictedList(
  db: CouncilDB,
  initialSelectedId?: string,
): Promise<ListNavigation> {
  const PAGE_SIZE = 10;
  let cursor: string | undefined;
  let selectedId: string | undefined = initialSelectedId;

  while (true) {
    clearScreen();

    // Use reverse=true to get newest evictions first (by ULID order which is based on ID creation time)
    // But evicted candidates use their original ID, so we sort by evictedAt after fetching
    const result = await db.getAllEvictedCandidates({
      limit: PAGE_SIZE,
      cursor,
      reverse: true,
    });

    // Empty case - return to main menu
    if (result.items.length === 0 && !cursor) {
      return { type: "main-menu" };
    }

    // Sort by eviction date descending (most recent first)
    const evicted = result.items.sort(
      (a, b) => (b.evictedAt || 0) - (a.evictedAt || 0),
    );

    const options = [
      ...evicted.map((c) => ({
        name: `${c.persona.name} ${
          c.persona.model ? colors.dim(`[${c.persona.model}]`) : ""
        } (evicted ${formatTimestamp(c.evictedAt || 0)})`,
        value: c.id,
      })),
      ...(result.hasMore
        ? [{ name: colors.cyan("Next page ▶"), value: "__next__" }]
        : []),
      ...(cursor
        ? [{ name: colors.cyan("◀ First page"), value: "__first__" }]
        : []),
      { name: colors.dim("← Back to main menu"), value: "__back__" },
    ];

    // Find default option index based on selectedId
    const defaultIndex = selectedId
      ? options.findIndex((o) => o.value === selectedId)
      : undefined;

    const selected = await Select.prompt({
      message: "Select an evicted candidate:",
      options,
      default: defaultIndex !== undefined && defaultIndex >= 0
        ? options[defaultIndex].value
        : undefined,
    });

    if (!selected || selected === "__back__") {
      return { type: "main-menu" };
    }

    if (selected === "__next__") {
      cursor = result.cursor;
      selectedId = undefined;
      continue;
    }

    if (selected === "__first__") {
      cursor = undefined;
      selectedId = undefined;
      continue;
    }

    const candidate = evicted.find((c) => c.id === selected);
    if (candidate) {
      const actionResult = await showEvictedActionsLoop(candidate, db);

      if (actionResult.action === "deleted") {
        // Deleted - reset cursor and selection to top of list
        cursor = undefined;
        selectedId = undefined;
      } else if (actionResult.action === "restored") {
        // Restored - navigate to candidates list with them selected
        return { type: "candidates", selectedId: actionResult.id };
      } else {
        // Back - remember position
        selectedId = actionResult.id;
      }
    }
  }
}

/**
 * Show council overview/stats
 * Note: less-pager-mini handles terminal resize and text wrapping natively
 */
async function showOverview(db: CouncilDB): Promise<void> {
  const state = await db.getCouncilState();
  const { items: members } = await db.getAllMembers();
  const { items: candidates } = await db.getAllCandidates();

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

  // Build content lines - no width restriction, let pager handle wrapping
  const lines: string[] = [];

  lines.push("");
  lines.push(colors.bgCyan.bold("  Council Overview  "));
  lines.push("");
  lines.push(colors.bold("Council State:"));
  lines.push(`  • Members: ${colors.green(members.length.toString())} / 8`);
  lines.push(
    `  • Candidates: ${
      colors.yellow(candidates.length.toString())
    } / ${state.targetPoolSize}`,
  );
  lines.push(`  • Rounds since eviction: ${state.roundsSinceEviction}`);
  lines.push("");
  lines.push(colors.bold("Message Statistics:"));
  lines.push(`  • Total member active context: ${totalMemberMessages}`);
  lines.push(`  • Total candidate history: ${totalCandidateMessages}`);
  lines.push("");
  lines.push(colors.bold("Candidate Pool:"));
  lines.push(`  • Average fitness: ${avgCandidateFitness}`);
  lines.push(`  • Target pool size: ${state.targetPoolSize}`);
  lines.push("");

  if (state.lastRemovalCauses.length > 0) {
    lines.push(colors.bold.red("Last Removal Causes:"));
    lines.push("");

    if (state.removalHistorySummary) {
      lines.push(colors.yellow(state.removalHistorySummary));
      lines.push("");
      lines.push(colors.dim("Recent events:"));
    }

    for (const cause of state.lastRemovalCauses) {
      lines.push(`  • ${cause}`);
    }
    lines.push("");
  }

  // Use less-pager-mini to display
  await pager(lines.join("\n"), true);
  resetConfig();
  clearScreen();
}

/**
 * Main menu
 */
async function mainMenu(db: CouncilDB): Promise<boolean> {
  // Navigation state for cross-list transitions
  let navigation: ListNavigation = { type: "main-menu" };

  while (true) {
    // Handle navigation from list views
    if (navigation.type === "members") {
      navigation = await showMembersList(db, navigation.selectedId);
      continue;
    }
    if (navigation.type === "candidates") {
      navigation = await showCandidatesList(db, navigation.selectedId);
      continue;
    }
    if (navigation.type === "evicted") {
      navigation = await showEvictedList(db, navigation.selectedId);
      continue;
    }

    // Show main menu
    clearScreen();

    const state = await db.getCouncilState();
    const { items: evictedCandidates } = await db.getAllEvictedCandidates();
    const evictedCount = evictedCandidates.length;

    console.log("");
    console.log(colors.bgMagenta.bold("  🏛️  MCP Council TUI Viewer  "));
    console.log("");
    console.log(
      colors.dim(
        `  Council: ${state.memberIds.length} members | Pool: ${state.candidateIds.length} candidates | Evicted: ${evictedCount}`,
      ),
    );
    console.log("");

    const memberCount = state.memberIds.length;
    const candidateCount = state.candidateIds.length;

    const options = [
      { name: "📊 Overview - Council statistics", value: "overview" },
      {
        name: `🧐 Council Members (${memberCount})`,
        value: "members",
        disabled: memberCount === 0,
      },
      {
        name: `🤓 Candidates (${candidateCount})`,
        value: "candidates",
        disabled: candidateCount === 0,
      },
      {
        name: `💀 Evicted Candidates (${evictedCount})`,
        value: "evicted",
        disabled: evictedCount === 0,
      },
      { name: colors.dim("❌ Exit"), value: "exit" },
    ];

    const selected = await Select.prompt({
      message: "Choose an option:",
      options,
    });

    if (!selected) {
      return false;
    }

    switch (selected) {
      case "overview":
        await showOverview(db);
        break;
      case "members":
        navigation = await showMembersList(db);
        break;
      case "candidates":
        navigation = await showCandidatesList(db);
        break;
      case "evicted":
        navigation = await showEvictedList(db);
        break;
      case "exit":
        return false;
    }
  }
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
