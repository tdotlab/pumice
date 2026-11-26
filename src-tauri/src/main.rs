#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adapter;
mod bridge;

use std::sync::atomic::Ordering;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(adapter::Session::default())
        .manage(bridge::Dirty::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<bridge::Dirty>().0.load(Ordering::SeqCst) {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bridge::vault_open,
            bridge::vault_list,
            bridge::vault_read,
            bridge::vault_stat,
            bridge::vault_write,
            bridge::set_dirty,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Pumice");
}
