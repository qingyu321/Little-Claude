fn main() {
    // Build frontend (Vite) before compiling Rust.
    // In dev mode (cargo tauri dev), Tauri's beforeDevCommand handles this.
    // In release mode (cargo build --release), we handle it here.
    #[cfg(not(debug_assertions))]
    {
        let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
        let status = std::process::Command::new(npm)
            .args(["run", "build"])
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap(),
            )
            .status()
            .expect("前端构建失败 (npm run build)");
        if !status.success() {
            panic!("前端构建退出码非零");
        }
        // Verify dist/index.html exists after build
        let dist_index = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("dist")
            .join("index.html");
        if !dist_index.exists() {
            panic!("dist/index.html 未生成, 前端构建可能失败");
        }
    }

    tauri_build::build()
}
