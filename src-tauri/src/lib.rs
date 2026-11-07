//! Tauri shell around the `hust-course-hack` crawler core.

mod commands;
mod events;
mod login;
mod state;
mod zhihuishu;

use state::AppState;

pub fn run() {
    #[cfg(debug_assertions)]
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|_app| {
            login::cleanup_stale_login_dirs();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_login_window,
            commands::session_info,
            commands::disconnect,
            commands::list_courses,
            commands::fetch_course,
            commands::watch_course,
            commands::complete_documents,
            commands::complete_quizzes,
            commands::answer_bank_info,
            commands::cancel_job,
            commands::helper_script,
            commands::save_text_file,
            zhihuishu::zhs_list_courses,
            zhihuishu::zhs_add_course,
            zhihuishu::zhs_course_detail,
            zhihuishu::zhs_watch_videos,
            zhihuishu::zhs_meet_list,
            zhihuishu::zhs_meet_progress,
            zhihuishu::zhs_meet_watch,
            zhihuishu::zhs_exception_status,
            zhihuishu::zhs_cancel_job,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HUST Course Hack");
}
