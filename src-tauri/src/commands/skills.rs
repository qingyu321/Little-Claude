use serde::{Deserialize, Deserializer, Serialize};

// ── Slash Commands & Skills ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SlashCommand {
    name: String,
    description: String,
    source: String,
    has_args: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct UnifiedCommand {
    name: String,
    description: String,
    source: String,   // "builtin" | "global" | "project"
    category: String, // "builtin" | "command" | "skill"
    has_args: bool,
    path: Option<String>, // Only for skills, points to SKILL.md
    immediate: bool,      // true = execute immediately (no message sent)
    #[serde(skip_serializing_if = "Option::is_none")]
    execution: Option<String>, // "ui" | "cli" | "session"  --?how command is executed
}

/// Scan and return all available slash commands (built-in + custom .md files)
#[tauri::command]
pub async fn list_slash_commands(cwd: Option<String>) -> Result<Vec<SlashCommand>, String> {
    let mut commands: Vec<SlashCommand> = vec![];

    // Built-in commands: (name, description, has_args)
    let builtins: [(&str, &str, bool); 29] = [
        ("/ask", "Ask a question without making changes", false),
        ("/bug", "Report a bug with Claude Code", false),
        ("/clear", "Clear conversation history", false),
        ("/code", "Switch to code mode (default)", false),
        ("/compact", "Compact conversation to reduce context", false),
        ("/config", "Open settings panel", false),
        ("/context", "Manage context files and directories", false),
        ("/cost", "Show session cost and token usage", false),
        ("/doctor", "Check Claude Code health status", false),
        ("/exit", "Close the application", false),
        ("/export", "Export conversation to markdown", true),
        ("/help", "Show available commands", false),
        ("/init", "Initialize project configuration", false),
        ("/mcp", "Manage MCP server connections", false),
        ("/memory", "View or edit MEMORY.md files", false),
        ("/model", "Switch the AI model", false),
        ("/permissions", "View and manage tool permissions", false),
        ("/plan", "Enter plan mode for complex tasks", false),
        ("/rename", "Rename the current session", true),
        ("/resume", "Resume a previous session", true),
        ("/rewind", "Rewind conversation to a previous turn", false),
        ("/stats", "Show session statistics", false),
        ("/status", "Show session status", false),
        ("/statusline", "Configure status line display", false),
        ("/tasks", "View running background tasks", false),
        ("/teleport", "Teleport context to a new session", false),
        ("/theme", "Toggle light/dark/system theme", false),
        ("/todos", "View todo items from the session", false),
        ("/usage", "Show detailed token usage breakdown", false),
    ];
    for (name, desc, has_args) in &builtins {
        commands.push(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "builtin".to_string(),
            has_args: *has_args,
        });
    }

    // Helper: scan a directory for .md command files
    fn scan_commands_dir(dir: &std::path::Path, source: &str) -> Vec<SlashCommand> {
        let mut cmds = vec![];
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return cmds,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "md") {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let name = format!("/{}", stem);

                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let description = content
                    .lines()
                    .next()
                    .map(|line| line.trim_start_matches('#').trim().to_string())
                    .unwrap_or_else(|| stem.clone());
                let has_args = content.contains("$ARGUMENTS");

                cmds.push(SlashCommand {
                    name,
                    description,
                    source: source.to_string(),
                    has_args,
                });
            }
        }
        cmds
    }

    // Global custom commands: ~/.claude/commands/*.md
    if let Some(home) = dirs::home_dir() {
        let global_dir = home.join(".claude").join("commands");
        commands.extend(scan_commands_dir(&global_dir, "global"));
    }

    // Project custom commands: {cwd}/.claude/commands/*.md
    if let Some(ref cwd_path) = cwd {
        let project_dir = std::path::Path::new(cwd_path)
            .join(".claude")
            .join("commands");
        commands.extend(scan_commands_dir(&project_dir, "project"));
    }

    Ok(commands)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SkillInfo {
    name: String,
    description: String,
    path: String,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    disable_model_invocation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_invocable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    argument_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTranslationItem {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTranslation {
    key: String,
    name: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTranslationConfig {
    pub(crate) base_url: String,
    pub(crate) api_format: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) proxy_url: Option<String>,
}

/// YAML frontmatter fields for SKILL.md files
#[derive(Debug, Deserialize, Default)]
pub(crate) struct SkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
    #[serde(default, rename = "user-invocable")]
    user_invocable: Option<bool>,
    #[serde(
        default,
        rename = "allowed-tools",
        deserialize_with = "deserialize_optional_string_list"
    )]
    allowed_tools: Option<Vec<String>>,
    #[serde(default, rename = "argument-hint")]
    argument_hint: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

fn deserialize_optional_string_list<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_yaml::Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };

    let tools = match value {
        serde_yaml::Value::Sequence(items) => items
            .into_iter()
            .filter_map(|item| match item {
                serde_yaml::Value::String(s) => Some(s.trim().to_string()),
                other => other.as_str().map(|s| s.trim().to_string()),
            })
            .filter(|s| !s.is_empty())
            .collect(),
        serde_yaml::Value::String(s) => s
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        _ => Vec::new(),
    };

    Ok(Some(tools))
}

/// Parse YAML frontmatter from a SKILL.md file content.
/// Returns (parsed frontmatter, body text after frontmatter).
fn parse_skill_frontmatter(content: &str) -> (SkillFrontmatter, &str) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (SkillFrontmatter::default(), content);
    }
    // Find the closing ---
    let after_open = &trimmed[3..];
    if let Some(close_idx) = after_open.find("\n---") {
        let yaml_str = &after_open[..close_idx];
        let body_start = 3 + close_idx + 4; // "---" + yaml + "\n---"
        let body = trimmed.get(body_start..).unwrap_or("");
        // Skip leading newline in body
        let body = body.strip_prefix('\n').unwrap_or(body);
        match serde_yaml::from_str::<SkillFrontmatter>(yaml_str) {
            Ok(fm) => (fm, body),
            Err(_) => (SkillFrontmatter::default(), content),
        }
    } else {
        (SkillFrontmatter::default(), content)
    }
}

/// Update or insert a single YAML frontmatter field.
/// If value is None, the field is removed. If no frontmatter exists, one is created.
fn update_frontmatter_field(content: &str, field: &str, value: Option<&str>) -> String {
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        let after_open = &trimmed[3..];
        if let Some(close_idx) = after_open.find("\n---") {
            let yaml_section = &after_open[..close_idx];
            let body = &trimmed[3 + close_idx + 4..];

            // Filter out existing field line
            let mut lines: Vec<&str> = yaml_section
                .lines()
                .filter(|line| {
                    let trimmed_line = line.trim();
                    !trimmed_line.starts_with(&format!("{}:", field))
                })
                .collect();

            // Add field if value is provided
            if let Some(val) = value {
                lines.push(&""); // will be replaced
                let new_line = format!("{}: {}", field, val);
                // Replace the empty placeholder
                let last = lines.len() - 1;
                lines.remove(last);
                let owned_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
                let mut result = String::from("---\n");
                for line in &owned_lines {
                    result.push_str(line);
                    result.push('\n');
                }
                result.push_str(&new_line);
                result.push_str("\n---");
                result.push_str(body);
                return result;
            }

            // Just remove the field
            let owned_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            if owned_lines.iter().all(|l| l.trim().is_empty()) {
                // No fields left, remove frontmatter entirely
                let body = body.strip_prefix('\n').unwrap_or(body);
                return body.to_string();
            }
            let mut result = String::from("---\n");
            for line in &owned_lines {
                result.push_str(line);
                result.push('\n');
            }
            result.push_str("---");
            result.push_str(body);
            return result;
        }
    }

    // No existing frontmatter  --?add one if value is provided
    if let Some(val) = value {
        return format!("---\n{}: {}\n---\n{}", field, val, content);
    }

    content.to_string()
}

fn collect_skill_files(dir: &std::path::Path, max_depth: usize) -> Vec<std::path::PathBuf> {
    fn visit(
        dir: &std::path::Path,
        depth: usize,
        max_depth: usize,
        found: &mut Vec<std::path::PathBuf>,
    ) {
        if depth > max_depth {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if skill_file.exists() {
                found.push(skill_file);
            } else {
                visit(&path, depth + 1, max_depth, found);
            }
        }
    }

    let mut found = Vec::new();
    visit(dir, 0, max_depth, &mut found);
    found
}

fn skill_display_fields(skill_file: &std::path::Path) -> (String, String, SkillFrontmatter) {
    let fallback_name = skill_file
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let content = std::fs::read_to_string(skill_file).unwrap_or_default();
    let (fm, body) = parse_skill_frontmatter(&content);

    let name = fm
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback_name);

    let description = fm
        .description
        .clone()
        .filter(|description| !description.trim().is_empty())
        .or_else(|| {
            body.lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim_start_matches('#').trim().to_string())
        })
        .unwrap_or_else(|| name.clone());

    (name, description, fm)
}

fn scan_skill_infos(dir: &std::path::Path, scope: &str) -> Vec<SkillInfo> {
    collect_skill_files(dir, 8)
        .into_iter()
        .map(|skill_file| {
            let (name, description, fm) = skill_display_fields(&skill_file);
            SkillInfo {
                name,
                description,
                path: skill_file.to_string_lossy().to_string(),
                scope: scope.to_string(),
                disable_model_invocation: fm.disable_model_invocation,
                user_invocable: fm.user_invocable,
                allowed_tools: fm.allowed_tools,
                argument_hint: fm.argument_hint,
                model: fm.model,
                context: fm.context,
                agent: fm.agent,
                version: fm.version,
            }
        })
        .collect()
}

fn scan_skill_commands(dir: &std::path::Path, source: &str) -> Vec<UnifiedCommand> {
    collect_skill_files(dir, 8)
        .into_iter()
        .map(|skill_file| {
            let (name, description, fm) = skill_display_fields(&skill_file);
            UnifiedCommand {
                name: format!("/{}", name),
                description,
                source: source.to_string(),
                category: "skill".to_string(),
                has_args: fm.argument_hint.is_some(),
                path: Some(skill_file.to_string_lossy().to_string()),
                immediate: false,
                execution: None,
            }
        })
        .collect()
}

fn dedupe_skill_infos(skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(skills.len());
    for skill in skills {
        let key = format!("{}:{}", skill.scope, skill.name.to_lowercase());
        if seen.insert(key) {
            deduped.push(skill);
        }
    }
    deduped
}

fn dedupe_unified_skill_commands(commands: Vec<UnifiedCommand>) -> Vec<UnifiedCommand> {
    let mut seen_skills = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(commands.len());
    for command in commands {
        if command.category == "skill" {
            let key = format!("{}:{}", command.source, command.name.to_lowercase());
            if !seen_skills.insert(key) {
                continue;
            }
        }
        deduped.push(command);
    }
    deduped
}

/// Scan and return all available skills (global + project)
#[tauri::command]
pub async fn list_skills(cwd: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let mut skills: Vec<SkillInfo> = vec![];

    // Global skills: Codex, legacy Claude, and shared agent skill directories.
    if let Some(home) = dirs::home_dir() {
        for dir in [
            home.join(".codex").join("skills"),
            home.join(".agents").join("skills"),
            home.join(".claude").join("skills"),
            home.join(".codex").join("plugins").join("cache"),
        ] {
            skills.extend(scan_skill_infos(&dir, "global"));
        }
    }

    // Project skills: prefer Codex layout, keep Claude layout for compatibility.
    if let Some(ref cwd_path) = cwd {
        let cwd = std::path::Path::new(cwd_path);
        for dir in [
            cwd.join(".codex").join("skills"),
            cwd.join(".agents").join("skills"),
            cwd.join(".claude").join("skills"),
        ] {
            skills.extend(scan_skill_infos(&dir, "project"));
        }
    }

    Ok(dedupe_skill_infos(skills))
}

/// Read a skill file and return its content
#[tauri::command]
pub async fn read_skill(path: String, cwd: Option<String>) -> Result<String, String> {
    let resolved = resolve_skill_path(&path, cwd.as_deref())?;
    std::fs::read_to_string(&resolved).map_err(|e| format!("Cannot read skill file: {}", e))
}

/// Write content to a skill file, creating parent directories if needed
#[tauri::command]
pub async fn write_skill(
    path: String,
    content: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let resolved = resolve_skill_path(&path, cwd.as_deref())?;
    if content.len() > 1024 * 1024 {
        return Err("Skill content too large (max 1 MiB)".to_string());
    }
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    std::fs::write(&resolved, &content).map_err(|e| format!("Cannot write skill file: {}", e))
}

/// Delete a skill file; remove the parent directory if it becomes empty
#[tauri::command]
pub async fn delete_skill(path: String, cwd: Option<String>) -> Result<(), String> {
    let resolved = resolve_skill_path(&path, cwd.as_deref())?;
    std::fs::remove_file(&resolved).map_err(|e| format!("Failed to delete skill file: {}", e))?;

    // If the parent directory is now empty, remove it too
    if let Some(parent) = resolved.parent() {
        if parent.is_dir() {
            let is_empty = std::fs::read_dir(parent)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if is_empty {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    Ok(())
}

/// Unified endpoint that returns all commands and skills in a single call
#[tauri::command]
pub async fn list_all_commands(cwd: Option<String>, cli_backend: Option<String>) -> Result<Vec<UnifiedCommand>, String> {
    let mut commands: Vec<UnifiedCommand> = vec![];

    // 1. Built-in commands: (name, description, has_args, execution)
    // execution: "ui" = handled in frontend, "cli" = run as separate CLI process, "session" = needs active CLI session
    let builtins: [(&str, &str, bool, &str); 24] = [
        ("/ask", "Ask a question without making changes", false, "ui"),
        ("/bug", "Report a bug with Claude Code", false, "ui"),
        (
            "/bypass",
            "Switch to bypass mode (skip all permission prompts)",
            false,
            "ui",
        ),
        ("/clear", "Clear conversation history", false, "ui"),
        ("/code", "Switch to code mode (default)", false, "ui"),
        (
            "/compact",
            "Compact conversation to reduce context",
            false,
            "session",
        ),
        (
            "/context",
            "Manage context files and directories",
            false,
            "session",
        ),
        ("/cost", "Show session cost and token usage", false, "ui"),
        (
            "/doctor",
            "Check Claude Code health status",
            false,
            "session",
        ),
        ("/export", "Export conversation to markdown", true, "ui"),
        ("/help", "Show available commands", false, "ui"),
        (
            "/init",
            "Initialize project configuration",
            false,
            "session",
        ),
        ("/mcp", "Manage MCP server connections", false, "session"),
        ("/memory", "View or edit MEMORY.md files", false, "session"),
        (
            "/permissions",
            "View and manage tool permissions",
            false,
            "session",
        ),
        ("/plan", "Enter plan mode for complex tasks", false, "ui"),
        ("/rename", "Rename the current session", true, "ui"),
        (
            "/rewind",
            "Rewind conversation to a previous turn",
            false,
            "ui",
        ),
        ("/stats", "Show session statistics", false, "session"),
        (
            "/statusline",
            "Configure status line display",
            false,
            "session",
        ),
        ("/tasks", "View running background tasks", false, "session"),
        (
            "/teleport",
            "Teleport context to a new session",
            false,
            "session",
        ),
        (
            "/todos",
            "View todo items from the session",
            false,
            "session",
        ),
        ("/usage", "Show detailed token usage breakdown", false, "ui"),
    ];
    // Commands that are valid on Codex (cross-backend). Claude-only commands
    // like /compact, /cost, /rewind, etc. are hidden when Codex is active.
    let codex_supported: std::collections::HashSet<&str> = [
        "/ask", "/bug", "/bypass", "/clear", "/code",
        "/export", "/help", "/plan", "/rename",
    ]
    .iter()
    .cloned()
    .collect();

    for (name, desc, has_args, execution) in &builtins {
        // Filter: on Codex, skip Claude-only built-in commands
        if cli_backend.as_deref() == Some("codex") && !codex_supported.contains(name) {
            continue;
        }
        commands.push(UnifiedCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "builtin".to_string(),
            category: "builtin".to_string(),
            has_args: *has_args,
            path: None,
            immediate: true,
            execution: Some(execution.to_string()),
        });
    }

    // Helper: scan a directory for .md command files
    fn scan_commands_dir(dir: &std::path::Path, source: &str) -> Vec<UnifiedCommand> {
        let mut cmds = vec![];
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return cmds,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "md") {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let name = format!("/{}", stem);

                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let description = content
                    .lines()
                    .next()
                    .map(|line| line.trim_start_matches('#').trim().to_string())
                    .unwrap_or_else(|| stem.clone());
                let has_args = content.contains("$ARGUMENTS");

                cmds.push(UnifiedCommand {
                    name,
                    description,
                    source: source.to_string(),
                    category: "command".to_string(),
                    has_args,
                    path: None,
                    immediate: false,
                    execution: None,
                });
            }
        }
        cmds
    }

    // 2. Global custom commands: ~/.claude/commands/*.md
    if let Some(home) = dirs::home_dir() {
        let global_dir = home.join(".claude").join("commands");
        commands.extend(scan_commands_dir(&global_dir, "global"));
    }

    // 3. Project custom commands: {cwd}/.claude/commands/*.md
    if let Some(ref cwd_path) = cwd {
        let project_dir = std::path::Path::new(cwd_path)
            .join(".claude")
            .join("commands");
        commands.extend(scan_commands_dir(&project_dir, "project"));
    }

    // 4. Global skills: Codex, legacy Claude, and shared agent skill directories.
    if let Some(home) = dirs::home_dir() {
        for dir in [
            home.join(".codex").join("skills"),
            home.join(".agents").join("skills"),
            home.join(".claude").join("skills"),
            home.join(".codex").join("plugins").join("cache"),
        ] {
            commands.extend(scan_skill_commands(&dir, "global"));
        }
    }

    // 5. Project skills: prefer Codex layout, keep Claude layout for compatibility.
    if let Some(ref cwd_path) = cwd {
        let cwd = std::path::Path::new(cwd_path);
        for dir in [
            cwd.join(".codex").join("skills"),
            cwd.join(".agents").join("skills"),
            cwd.join(".claude").join("skills"),
        ] {
            commands.extend(scan_skill_commands(&dir, "project"));
        }
    }

    Ok(dedupe_unified_skill_commands(commands))
}

/// Toggle a skill's enabled/disabled state by writing/removing
/// `disable-model-invocation` in its YAML frontmatter.
#[tauri::command]
pub async fn toggle_skill_enabled(
    path: String,
    enabled: bool,
    cwd: Option<String>,
) -> Result<(), String> {
    let resolved = resolve_skill_path(&path, cwd.as_deref())?;
    let content = std::fs::read_to_string(&resolved)
        .map_err(|e| format!("Cannot read skill file: {}", e))?;
    let new_content = if enabled {
        // Remove disable-model-invocation (or set to false)
        update_frontmatter_field(&content, "disable-model-invocation", None)
    } else {
        // Set disable-model-invocation: true
        update_frontmatter_field(&content, "disable-model-invocation", Some("true"))
    };
    std::fs::write(&resolved, &new_content).map_err(|e| format!("Cannot write skill file: {}", e))
}

/// Lexically normalize a path (resolve `.`/`..` without touching the disk),
/// case-fold, and use `/` separators so roots and targets compare uniformly
/// across platforms. Prefix/RootDir components are kept so different drives or
/// absolute roots can't collide after normalization.
fn normalize_lexical(path: &std::path::Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Prefix(p) => {
                parts.push(p.as_os_str().to_string_lossy().to_string());
            }
            std::path::Component::RootDir => parts.push("/".to_string()),
            std::path::Component::Normal(s) => {
                parts.push(s.to_string_lossy().to_string());
            }
        }
    }
    parts.join("/").to_lowercase()
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix('~') {
        if let Some(home) = dirs::home_dir() {
            let sep = if rest.starts_with(['/', '\\']) {
                ""
            } else {
                "/"
            };
            return format!(
                "{}{}{}",
                home.to_string_lossy(),
                sep,
                rest.trim_start_matches(['/', '\\'])
            );
        }
    }
    path.to_string()
}

/// Allowed skill roots. Global dirs are always allowed; project dirs only when
/// `cwd` is provided (mirrors the scan in list_skills).
fn skill_roots(cwd: Option<&str>) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".codex/skills",
            ".agents/skills",
            ".claude/skills",
            ".codex/plugins/cache",
        ] {
            roots.push(home.join(rel));
        }
    }
    if let Some(cwd) = cwd {
        for rel in [".codex/skills", ".agents/skills", ".claude/skills"] {
            roots.push(std::path::Path::new(cwd).join(rel));
        }
    }
    roots
}

/// Canonicalize `p` if it exists; otherwise canonicalize the nearest existing
/// ancestor and append the remaining (non-existent) components. The result is
/// symlink-free along its existing prefix — a symlink anywhere in the path can
/// no longer redirect the final location. Mirrors files.rs::safe_resolve.
fn resolve_existing_or_ancestor(p: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if p.exists() {
        return std::fs::canonicalize(p)
            .map_err(|e| format!("Cannot resolve path '{}': {}", p.display(), e));
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p;
    loop {
        let Some(parent) = cur.parent() else {
            return Err(format!("路径不存在: {}", p.display()));
        };
        if parent == cur {
            return Err(format!("路径不存在: {}", p.display()));
        }
        if let Some(name) = cur.file_name() {
            suffix.push(name.to_os_string());
        }
        cur = parent;
        if cur.exists() {
            break;
        }
    }
    let canon_root = std::fs::canonicalize(cur)
        .map_err(|e| format!("Cannot resolve path '{}': {}", p.display(), e))?;
    let mut result = canon_root;
    for name in suffix.iter().rev() {
        result.push(name);
    }
    Ok(result)
}

/// Resolve a skill file path (canonicalized, symlink-free) and verify it stays
/// inside the allowed skill roots — the unified entry point for
/// read/write/delete/toggle. A symlinked skill directory (or symlinked file)
/// that points outside the roots is rejected. Non-existent write targets are
/// resolved through their nearest existing ancestor, so the final path is
/// already checked before any parent directories are created.
fn resolve_skill_path(path: &str, cwd: Option<&str>) -> Result<std::path::PathBuf, String> {
    // Relative paths would resolve against the app's working directory, not
    // the session cwd — reject them outright.
    let expanded = expand_tilde(path);
    let p = std::path::Path::new(&expanded);
    if !p.is_absolute() {
        return Err(format!("Skill path must be absolute: {}", path));
    }

    let target = resolve_existing_or_ancestor(p)?;
    let target_norm = normalize_lexical(&target);

    for root in skill_roots(cwd) {
        // Resolve the root the same way so a symlinked parent directory
        // (e.g. ~/.claude -> elsewhere) is consistent on both sides.
        let canon_root = match resolve_existing_or_ancestor(&root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let root_norm = normalize_lexical(&canon_root);
        if target_norm == root_norm || target_norm.starts_with(&format!("{}/", root_norm)) {
            return Ok(target);
        }
    }
    Err(format!(
        "Refusing to access file outside allowed skill directories: {}",
        path
    ))
}
