; Portable build for Little Claude
; ================================
; As of 2026-07-23, the portable build NO LONGER uses NSIS self-extracting
; archives.  All frontend assets are embedded at compile time by Tauri, and
; all bundled skills (video-analysis, image-reader, ...) are embedded via
; rust-embed in the binary.
;
; The resulting little-claude.exe (cargo build --release) IS the portable
; single-file executable.  No extraction, no temp files, no installer.
;
; To produce a distributable portable exe:
;   cargo build --release
;   cp target/release/little-claude.exe LittleClaude-Portable.exe
;
; Maintenance: when a new skill joins resources/bundled-skills/, just
; rebuild — rust-embed picks it up automatically at compile time.
