//! Desktop pet skin import/read commands.
//!
//! Stores imported Codex-pet bundles under `~/.tokenicode/pets/<id>/` so the
//! pet window can hot-swap appearance. This uses `safe_data_dir()` (home +
//! `safe_data_dir_name()`), the same location as usage_log — NOT the app-data
//! dir that the Windows NSIS installer wipes.

use std::path::PathBuf;

fn pets_dir() -> Result<PathBuf, String> {
    crate::safe_data_dir().map(|d| d.join("pets"))
}

fn pet_dir(pet_id: &str) -> Result<PathBuf, String> {
    if pet_id.is_empty()
        || pet_id.len() > 64
        || !pet_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid pet id".to_string());
    }
    Ok(pets_dir()?.join(pet_id))
}

/// Save an imported pet bundle (`pet.json` + `spritesheet.webp`).
/// Returns the pet_id on success.
#[tauri::command]
pub fn save_imported_pet(
    pet_id: String,
    pet_json: String,
    spritesheet_b64: String,
) -> Result<String, String> {
    use base64::Engine;
    use std::io::Write;

    let dir = pet_dir(&pet_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create pet dir: {}", e))?;

    // Validate pet.json is at least structurally JSON and has the required
    // frame + states keys — reject garbage before it lands on disk.
    let parsed: serde_json::Value =
        serde_json::from_str(&pet_json).map_err(|e| format!("Invalid pet.json: {}", e))?;
    if parsed.get("frame").is_none() || parsed.get("states").is_none() {
        return Err("pet.json must contain 'frame' and 'states'".to_string());
    }

    let json_path = dir.join("pet.json");
    let mut f = std::fs::File::create(&json_path).map_err(|e| e.to_string())?;
    f.write_all(pet_json.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);

    if !spritesheet_b64.is_empty() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&spritesheet_b64)
            .map_err(|e| format!("Invalid spritesheet base64: {}", e))?;
        std::fs::write(dir.join("spritesheet.webp"), &bytes).map_err(|e| e.to_string())?;
    }

    Ok(pet_id)
}

/// Read a file inside a pet bundle. `file_name` is one of `pet.json` or
/// `spritesheet.webp`. Returns base64 for binary (webp) and plain text for json.
#[tauri::command]
pub fn read_imported_pet(pet_id: String, file_name: String) -> Result<String, String> {
    use base64::Engine;

    if file_name != "pet.json" && file_name != "spritesheet.webp" {
        return Err("Unsupported pet file".to_string());
    }
    let path = pet_dir(&pet_id)?.join(&file_name);
    let data = std::fs::read(&path).map_err(|e| format!("Cannot read pet file: {}", e))?;
    if file_name == "pet.json" {
        String::from_utf8(data).map_err(|e| format!("pet.json not UTF-8: {}", e))
    } else {
        Ok(base64::engine::general_purpose::STANDARD.encode(&data))
    }
}

/// List imported pet ids (subdirectories of the pets dir that contain a
/// pet.json). Built-in "default" is handled by the frontend, not listed here.
#[tauri::command]
pub fn list_imported_pets() -> Result<Vec<String>, String> {
    let dir = pets_dir()?;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("pet.json").exists() {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}
