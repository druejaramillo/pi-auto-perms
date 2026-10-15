interface ShellHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

function heredocSyntaxError(): SyntaxError {
  return new SyntaxError("pi-auto-perms: Unsupported or unterminated shell heredoc.");
}

function readHeredocDelimiter(
  command: string,
  start: number,
): { heredoc: ShellHeredoc; end: number } {
  const stripTabs = command[start + 2] === "-";
  let index = start + (stripTabs ? 3 : 2);
  while (command[index] === " " || command[index] === "\t") index++;
  let delimiter = "";
  let quoted = false;
  let started = false;
  let quote: "'" | '"' | undefined;
  for (; index < command.length; index++) {
    const char = command[index] ?? "";
    if (char === "\n" || char === "\0") break;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === "\\") {
        const next = command[++index];
        if (next === undefined || next === "\n") throw heredocSyntaxError();
        delimiter += /[$`"\\]/.test(next) ? next : `\\${next}`;
      } else delimiter += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      started = true;
    } else if (char === "\\") {
      const next = command[++index];
      if (next === undefined || next === "\n") throw heredocSyntaxError();
      delimiter += next;
      quoted = true;
      started = true;
    } else if (/[ \t;&|()<>]/.test(char)) break;
    else {
      if (char === "$" || char === "`" || (!started && char === "#")) throw heredocSyntaxError();
      delimiter += char;
      started = true;
    }
  }
  if (quote || !started) throw heredocSyntaxError();
  return { heredoc: { delimiter, quoted, stripTabs }, end: index };
}

function skipHeredocBody(command: string, start: number, heredoc: ShellHeredoc): number {
  let index = start;
  while (index < command.length) {
    const newline = command.indexOf("\n", index);
    const end = newline === -1 ? command.length : newline;
    const line = command.slice(index, end);
    const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
    if (candidate === heredoc.delimiter) return newline === -1 ? end : end + 1;
    // Expansions execute in the shell; continued lines can change where the body ends.
    // Never hide these behind an opaque stdin payload without understanding their syntax.
    if (!heredoc.quoted && (/[$`]/.test(line) || line.endsWith("\\"))) throw heredocSyntaxError();
    index = newline === -1 ? end : end + 1;
  }
  throw heredocSyntaxError();
}

/** Strip literal heredocs and retain shell command boundaries only for permission tokenization. */
export function stripPermissionShellHeredocs(command: string): string {
  if (!command.includes("<<") && !command.includes("\n")) return command;
  let output = "";
  let quote: "'" | '"' | undefined;
  let wordStart = true;
  const pending: ShellHeredoc[] = [];
  for (let index = 0; index < command.length; ) {
    const char = command[index] ?? "";
    const next = command[index + 1];
    if (quote) {
      // Nested expansion has its own quoting grammar; retain the original conservative parser.
      if (quote === '"' && (char === "`" || (char === "$" && /[({]/.test(next ?? ""))))
        return command;
      output += char;
      index++;
      if (quote === '"' && char === "\\" && next !== undefined) {
        output += next;
        index++;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      if (next !== "\n") {
        output += char + next;
        wordStart = false;
      }
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStart = false;
    } else if (char === "#" && wordStart) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline;
      continue;
    } else if (
      char === "`" ||
      char === "(" ||
      char === ")" ||
      (char === "[" && next === "[") ||
      (char === "$" && /[({'"]/u.test(next ?? ""))
    ) {
      // Do not mistake arithmetic shifts, nested shells, or ANSI-C strings for heredocs.
      return command;
    } else if (command.startsWith("<<<", index)) {
      output += "<<<";
      index += 3;
      wordStart = true;
      continue;
    } else if (command.startsWith("<<", index)) {
      const { heredoc, end } = readHeredocDelimiter(command, index);
      pending.push(heredoc);
      const descriptor = output.match(/(?:^|[ \t\n;&|<>])(\d+)$/)?.[1];
      if (descriptor) output = output.slice(0, -descriptor.length);
      index = end;
      wordStart = true;
      continue;
    } else if (char === "\n") {
      // shell-quote treats newlines as spaces; preserve shell command boundaries explicitly.
      output += ";\n";
      index++;
      for (const heredoc of pending) index = skipHeredocBody(command, index, heredoc);
      pending.length = 0;
      wordStart = true;
      continue;
    } else wordStart = /[ \t;&|<>]/.test(char);
    output += char;
    index++;
  }
  if (quote || pending.length > 0) throw heredocSyntaxError();
  return output;
}
