use tauri::AppHandle;

/// Set the macOS dock icon dynamically from base64-encoded PNG data.
#[tauri::command]
pub async fn set_dock_icon(app: AppHandle, png_base64: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&png_base64)
            .map_err(|e| format!("Invalid base64: {}", e))?;

        // NSApplication APIs must be called on the main thread
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| unsafe {
                use objc::msg_send;
                use objc::runtime::{Class, Object};
                use objc::sel;
                use objc::sel_impl;

                let nsdata_class = Class::get("NSData").unwrap();
                let nsdata: *mut Object = msg_send![nsdata_class, alloc];
                let nsdata: *mut Object = msg_send![nsdata,
                    initWithBytes: data.as_ptr()
                    length: data.len()
                ];

                let nsimage_class = Class::get("NSImage").unwrap();
                let nsimage: *mut Object = msg_send![nsimage_class, alloc];
                let nsimage: *mut Object = msg_send![nsimage, initWithData: nsdata];

                if !nsimage.is_null() {
                    let nsapp_class = Class::get("NSApplication").unwrap();
                    let nsapp: *mut Object = msg_send![nsapp_class, sharedApplication];
                    let _: () = msg_send![nsapp, setApplicationIconImage: nsimage];
                }
            });
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (&app, &png_base64);

    Ok(())
}
