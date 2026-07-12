#[cfg(all(feature = "wry", feature = "cef"))]
compile_error!("select exactly one runtime feature");

fn run<R: tauri::Runtime>(builder: tauri::Builder<R>) {
    builder
        .plugin(tauri_agent_plugin::init())
        .run(tauri::generate_context!())
        .expect("failed to run Fleet runtime fixture");
}

#[cfg(feature = "wry")]
fn main() {
    run(tauri::Builder::default());
}

#[cfg(feature = "cef")]
fn main() {
    tauri_runtime_cef::configure(tauri_runtime_cef::CefConfig {
        identifier: "dev.byeongsu.tauri-agent-fleet.runtime-fixture".into(),
        command_line_args: vec![
            ("use-mock-keychain".into(), None),
            ("password-store".into(), Some("basic".into())),
        ],
        ..Default::default()
    });
    if std::env::args().any(|arg| arg.starts_with("--type=")) {
        tauri_runtime_cef::run_cef_helper_process();
        return;
    }
    type Cef = tauri_runtime_cef::CefRuntime<tauri::EventLoopMessage>;
    run(tauri::Builder::<Cef>::new());
}
