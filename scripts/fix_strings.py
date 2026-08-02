"""Fix all corrupted string endings in lib.rs."""
import re

with open("src-tauri/src/lib.rs", "r", encoding="utf-8") as f:
    content = f.read()

fixes = []

# Split into lines for processing
lines = content.split("\n")
in_string = False
in_line_comment = False
in_block_comment = False

for line_num, line in enumerate(lines, 1):
    in_line_comment = False
    i = 0
    while i < len(line):
        ch = line[i]

        if in_line_comment:
            break

        if in_block_comment:
            if ch == "*" and i + 1 < len(line) and line[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2
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
            # Chinese character outside string - find the issue
            # Look backwards for a missing closing quote
            fixes.append((line_num, i, ch))

        i += 1

if fixes:
    print(f"Found {len(fixes)} non-ASCII chars potentially outside strings")
    for line_num, col, ch in fixes[:15]:
        ctx = lines[line_num - 1][max(0, col-20):min(len(lines[line_num-1]), col+5)]
        print(f"  Line {line_num}, col {col}: U+{ord(ch):04X} ctx: {ctx!r}")
else:
    print("No non-ASCII characters found outside strings")

# Now: check for UNBALANCED quotes on each line
print("\n--- Checking for unbalanced quotes ---")
for line_num, line in enumerate(lines, 1):
    # Strip line comments first
    comment_pos = line.find("//")
    if comment_pos >= 0:
        check_part = line[:comment_pos]
    else:
        check_part = line

    # Count quotes (handle escaped quotes)
    quotes = check_part.count('"') - check_part.count('\\"')
    if quotes % 2 != 0:
        # Odd number of quotes - might be an unclosed string
        # Check if it's a legit multi-line string continuation
        stripped = check_part.strip()
        if stripped and not stripped.endswith("\\"):
            print(f"Line {line_num}: ODD quotes ({quotes}): {stripped[:100]!r}")
