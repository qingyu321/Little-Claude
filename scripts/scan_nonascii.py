"""Scan lib.rs for non-ASCII characters outside string literals and comments."""
with open("src-tauri/src/lib.rs", "r", encoding="utf-8", errors="replace") as f:
    content = f.read()

lines = content.split("\n")

in_string = False
in_line_comment = False
in_block_comment = False
problem_lines = set()

for line_num, line in enumerate(lines, 1):
    in_line_comment = False
    i = 0
    while i < len(line):
        ch = line[i]

        if in_line_comment:
            break  # rest of line is comment

        if in_block_comment:
            if ch == "*" and i + 1 < len(line) and line[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2  # skip escaped char
                continue
            elif ch == '"':
                in_string = False
            i += 1
            continue

        # Not in string or comment
        if ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
            in_line_comment = True
            break
        if ch == "/" and i + 1 < len(line) and line[i + 1] == "*":
            in_block_comment = True
            i += 2
            continue
        if ch == '"':
            in_string = True
            i += 1
            continue

        if ord(ch) > 127:
            problem_lines.add(line_num)
            if len(problem_lines) <= 20:
                ctx = line[max(0, i - 15) : min(len(line), i + 15)]
                print(
                    f"Line {line_num}, col {i+1}: U+{ord(ch):04X} ({ch}) context: ...{ctx}..."
                )

        i += 1

print(f"\nTotal lines with non-ASCII outside strings: {len(problem_lines)}")
if problem_lines:
    print(f"Lines: {sorted(problem_lines)[:50]}")
