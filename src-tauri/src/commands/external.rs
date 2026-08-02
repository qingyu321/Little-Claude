use tauri::AppHandle;
use tokio::process::Command;

#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), String> {
    let mut cmd = Command::new("code");
    cmd.arg(&path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.spawn()
        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Use 'open -R' to reveal (select) the file in Finder
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        cmd.args(["/select,", &path]);
        cmd.creation_flags(0x08000000);
        cmd.spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Helper: create an NSURL from a file path string (macOS only).
/// Returns a raw pointer to the NSURL object, or null on failure.
#[cfg(target_os = "macos")]
unsafe fn create_nsurl_from_path(path: &str) -> *mut objc::runtime::Object {
    use objc::msg_send;
    use objc::runtime::{Class, Object};
    use objc::sel;
    use objc::sel_impl;

    let nsstring_class = Class::get("NSString").unwrap();
    let path_nsstring: *mut Object = msg_send![nsstring_class, alloc];
    let path_nsstring: *mut Object = msg_send![path_nsstring,
        initWithBytes: path.as_ptr() as *const std::ffi::c_void
        length: path.len()
        encoding: 4u64  // NSUTF8StringEncoding
    ];
    if path_nsstring.is_null() {
        return std::ptr::null_mut();
    }

    let nsurl_class = Class::get("NSURL").unwrap();
    let file_url: *mut Object = msg_send![nsurl_class,
        fileURLWithPath: path_nsstring
        isDirectory: false
    ];
    file_url
}

/// Show the macOS native share sheet for a file at the current mouse position.
#[tauri::command]
pub async fn share_file(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| {
                unsafe {
                    use objc::msg_send;
                    use objc::runtime::{Class, Object};
                    use objc::sel;
                    use objc::sel_impl;

                    let file_url = create_nsurl_from_path(&path);
                    if file_url.is_null() {
                        return;
                    }

                    // Create NSArray with the URL
                    let nsarray_class = Class::get("NSArray").unwrap();
                    let items: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];

                    // Create NSSharingServicePicker
                    let picker_class = Class::get("NSSharingServicePicker").unwrap();
                    let picker: *mut Object = msg_send![picker_class, alloc];
                    let picker: *mut Object = msg_send![picker, initWithItems: items];
                    if picker.is_null() {
                        return;
                    }

                    // Get key window's content view
                    let nsapp_class = Class::get("NSApplication").unwrap();
                    let nsapp: *mut Object = msg_send![nsapp_class, sharedApplication];
                    let key_window: *mut Object = msg_send![nsapp, keyWindow];
                    if key_window.is_null() {
                        return;
                    }

                    let content_view: *mut Object = msg_send![key_window, contentView];
                    if content_view.is_null() {
                        return;
                    }

                    // Get mouse position and convert to view coordinates
                    let nsevent_class = Class::get("NSEvent").unwrap();
                    let mouse_screen: cocoa::foundation::NSPoint =
                        msg_send![nsevent_class, mouseLocation];
                    let mouse_window: cocoa::foundation::NSPoint = msg_send![key_window,
                        convertPointFromScreen: mouse_screen
                    ];
                    let mouse_view: cocoa::foundation::NSPoint = msg_send![content_view,
                        convertPoint: mouse_window fromView: std::ptr::null::<Object>()
                    ];

                    let anchor_rect = cocoa::foundation::NSRect::new(
                        mouse_view,
                        cocoa::foundation::NSSize::new(1.0, 1.0),
                    );

                    let _: () = msg_send![picker,
                        showRelativeToRect: anchor_rect
                        ofView: content_view
                        preferredEdge: 1u64  // NSRectEdge.minY (bottom)
                    ];
                }
            });
        })
        .map_err(|e| format!("Failed to share: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = path;
    }

    Ok(())
}

/// Directly invoke WeChat's sharing service for a file (macOS only).
#[tauri::command]
pub async fn share_to_wechat(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| {
                unsafe {
                    use objc::msg_send;
                    use objc::runtime::{Class, Object};
                    use objc::sel;
                    use objc::sel_impl;

                    let file_url = create_nsurl_from_path(&path);
                    if file_url.is_null() {
                        return;
                    }

                    // Create NSArray with the URL
                    let nsarray_class = Class::get("NSArray").unwrap();
                    let items: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];

                    // Get all sharing services for this file
                    let service_class = Class::get("NSSharingService").unwrap();
                    let services: *mut Object = msg_send![service_class,
                        sharingServicesForItems: items
                    ];

                    let count: usize = msg_send![services, count];

                    // Find WeChat's sharing service by title
                    for i in 0..count {
                        let service: *mut Object = msg_send![services, objectAtIndex: i];
                        let title: *mut Object = msg_send![service, title];
                        let utf8: *const std::ffi::c_char = msg_send![title, UTF8String];
                        if utf8.is_null() {
                            continue;
                        }
                        let title_str = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
                        if title_str.contains("WeChat") || title_str.contains("微信") {
                            let _: () = msg_send![service, performWithItems: items];
                            return;
                        }
                    }

                    // WeChat service not found -- log for debugging
                    eprintln!(
                        "[share_to_wechat] WeChat sharing service not found. Available services:"
                    );
                    for i in 0..count {
                        let service: *mut Object = msg_send![services, objectAtIndex: i];
                        let title: *mut Object = msg_send![service, title];
                        let utf8: *const std::ffi::c_char = msg_send![title, UTF8String];
                        if !utf8.is_null() {
                            let t = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
                            eprintln!("  - {}", t);
                        }
                    }
                }
            });
        })
        .map_err(|e| format!("Failed to share to WeChat: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = path;
    }

    Ok(())
}
