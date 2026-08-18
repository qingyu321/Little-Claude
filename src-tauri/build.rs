fn main() {
    // Build frontend (Vite) before compiling Rust.
    // `tauri build` runs beforeBuildCommand (pnpm build) itself, which
    // produces dist/ — so this only fires when dist/index.html is missing,
    // i.e. a bare `cargo build --release` without the tauri wrapper. Building
    // here unconditionally duplicated the frontend build (C1: two npm/pnpm
    // runs per release) and used npm while the project is pnpm-based.
    #[cfg(not(debug_assertions))]
    {
        let dist_index = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("dist")
            .join("index.html");
        if !dist_index.exists() {
            let pnpm = if cfg!(target_os = "windows") { "pnpm.cmd" } else { "pnpm" };
            let status = std::process::Command::new(pnpm)
                .args(["run", "build"])
                .current_dir(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap(),
                )
                .status()
                .expect("前端构建失败 (pnpm run build)");
            if !status.success() {
                panic!("前端构建退出码非零");
            }
            if !dist_index.exists() {
                panic!("dist/index.html 未生成, 前端构建可能失败");
            }
        }
    }

    tauri_build::build()
}
