//! The fast part of Clairière. Speaks one JSON message per line over stdin/stdout.
mod meta;
mod remove;
mod scan;

use scan::{Progress, Tree, ARTEFACT_KINDS, NONE};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    tree: RwLock<Option<Tree>>,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    out: Mutex<()>,
}

fn send(st: &State, v: Value) {
    let line = v.to_string();
    let _guard = st.out.lock().unwrap();
    let stdout = std::io::stdout();
    let mut w = stdout.lock();
    let _ = w.write_all(line.as_bytes());
    let _ = w.write_all(b"\n");
    let _ = w.flush();
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn register(st: &State, id: u64) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    st.cancels.lock().unwrap().insert(id, flag.clone());
    flag
}

fn progress_json(id: u64, p: &Progress, started: Instant) -> Value {
    let names = p.branch_names.lock().unwrap();
    let mut top: Vec<(usize, u64)> = (0..names.len())
        .map(|i| (i, p.branch_bytes[i].load(Relaxed)))
        .filter(|(_, b)| *b > 0)
        .collect();
    top.sort_by_key(|(_, b)| std::cmp::Reverse(*b));
    top.truncate(14);
    let top: Vec<Value> = top.iter().map(|(i, b)| json!({"name": names[*i], "bytes": b})).collect();
    json!({
        "ev": "progress", "id": id,
        "files": p.files.load(Relaxed), "dirs": p.dirs.load(Relaxed),
        "bytes": p.bytes.load(Relaxed), "errors": p.errors.load(Relaxed),
        "ms": started.elapsed().as_millis() as u64,
        "current": p.current.lock().map(|c| c.clone()).unwrap_or_default(),
        "top": top,
    })
}

fn cmd_scan(st: Arc<State>, id: u64, path: PathBuf, keep: bool) {
    let cancel = register(&st, id);
    let progress = Arc::new(Progress::new(true));
    let started = Instant::now();
    let finished = Arc::new(AtomicBool::new(false));
    let ticker = {
        let (st, progress, finished) = (st.clone(), progress.clone(), finished.clone());
        std::thread::spawn(move || {
            while !finished.load(Relaxed) {
                send(&st, progress_json(id, &progress, started));
                std::thread::sleep(Duration::from_millis(66));
            }
        })
    };
    let result = scan::walk(&path, &cancel, &progress, true);
    finished.store(true, Relaxed);
    let _ = ticker.join();
    st.cancels.lock().unwrap().remove(&id);
    match result {
        Ok(tree) => {
            let summary = summary_json(&tree, started.elapsed().as_millis() as u64);
            if keep {
                *st.tree.write().unwrap() = Some(tree);
            }
            let mut msg = summary;
            msg["id"] = json!(id);
            msg["ok"] = json!(true);
            send(&st, msg);
        }
        Err(e) if e == "cancelled" => send(&st, json!({"id": id, "ok": false, "cancelled": true})),
        Err(e) => send(&st, json!({"id": id, "ok": false, "error": e})),
    }
}

fn top_file_json(f: &scan::TopFile) -> Value {
    json!({
        "path": lossy(&f.path), "size": f.size, "mtime": f.mtime,
        "lossy": f.path.to_str().is_none(),
    })
}

fn summary_json(tree: &Tree, ms: u64) -> Value {
    let root = &tree.nodes[0];
    let artefacts: Vec<Value> = tree
        .artefacts()
        .into_iter()
        .map(|i| {
            let n = &tree.nodes[i as usize];
            json!({
                "id": i,
                "path": lossy(&tree.path_of(i)),
                "kind": ARTEFACT_KINDS[n.artefact as usize],
                "bytes": n.bytes, "files": n.files, "mtime": n.mtime,
                "lossy": tree.is_lossy(i),
            })
        })
        .collect();
    json!({
        "root": lossy(&tree.root),
        "bytes": root.bytes, "files": root.files, "dirs": root.dirs,
        "errors": tree.errors, "ms": ms,
        "topFiles": tree.top_files.iter().map(top_file_json).collect::<Vec<_>>(),
        "artefacts": artefacts,
        "denied": tree.denied.iter().take(50).map(|p| lossy(p)).collect::<Vec<_>>(),
        "skippedMounts": tree.skipped_mounts.iter().map(|p| lossy(p)).collect::<Vec<_>>(),
    })
}

struct Item {
    dir: u32,
    name: String,
    lossy: bool,
    size: u64,
    mtime: i64,
}

fn list_items(tree: &Tree, id: u32) -> Vec<Item> {
    let mut items: Vec<Item> = tree
        .children(id)
        .into_iter()
        .map(|c| {
            let n = &tree.nodes[c as usize];
            Item {
                dir: c,
                name: n.name.to_string_lossy().into_owned(),
                lossy: n.name.to_str().is_none(),
                size: n.bytes,
                mtime: n.mtime,
            }
        })
        .collect();
    if tree.nodes[id as usize].own_files > 0 {
        if let Ok(rd) = fs::read_dir(tree.path_of(id)) {
            for ent in rd.flatten() {
                let Ok(md) = ent.metadata() else {
                    continue;
                };
                if md.is_dir() {
                    continue;
                }
                let name = ent.file_name();
                items.push(Item {
                    dir: NONE,
                    lossy: name.to_str().is_none(),
                    name: name.to_string_lossy().into_owned(),
                    size: meta::alloc(&md),
                    mtime: meta::mtime(&md),
                });
            }
        }
    }
    items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    items
}

struct ViewOpts {
    min_bytes: u64,
    max_children: usize,
    budget: usize,
}

fn view_node(tree: &Tree, id: u32, depth: u32, opts: &mut ViewOpts) -> Value {
    let n = &tree.nodes[id as usize];
    let mut v = json!({
        "id": id, "name": n.name.to_string_lossy(), "kind": "dir",
        "size": n.bytes, "files": n.files, "dirs": n.dirs, "mtime": n.mtime,
        "denied": n.denied,
        "lossy": n.name.to_str().is_none(),
        "hasChildren": n.first_child != NONE || n.own_files > 0,
    });
    if depth == 0 {
        return v;
    }
    let items = list_items(tree, id);
    let total = n.bytes;
    let mut kept = Vec::new();
    let mut kept_bytes = 0u64;
    let mut dropped = 0u64;
    for it in &items {
        let keep = kept.len() < opts.max_children
            && it.size >= opts.min_bytes
            && opts.budget > 0;
        if !keep {
            dropped += 1;
            continue;
        }
        opts.budget -= 1;
        kept_bytes += it.size;
        if it.dir != NONE {
            kept.push(view_node(tree, it.dir, depth - 1, opts));
        } else {
            kept.push(json!({
                "name": it.name, "kind": "file", "size": it.size,
                "mtime": it.mtime, "lossy": it.lossy,
            }));
        }
    }
    if dropped > 0 {
        kept.push(json!({
            "name": "", "kind": "other", "count": dropped,
            "size": total.saturating_sub(kept_bytes),
        }));
    }
    v["children"] = Value::Array(kept);
    v
}

fn cmd_view(st: &State, id: u64, msg: &Value) {
    let guard = st.tree.read().unwrap();
    let Some(tree) = guard.as_ref() else {
        send(st, json!({"id": id, "ok": false, "error": "no_scan"}));
        return;
    };
    let node = msg["node"].as_u64().unwrap_or(0) as u32;
    if node as usize >= tree.nodes.len() {
        send(st, json!({"id": id, "ok": false, "error": "unknown_folder"}));
        return;
    }
    let mut opts = ViewOpts {
        min_bytes: msg["minBytes"].as_u64().unwrap_or(0),
        max_children: msg["maxChildren"].as_u64().unwrap_or(5000) as usize,
        budget: msg["budget"].as_u64().unwrap_or(30000) as usize,
    };
    let depth = msg["depth"].as_u64().unwrap_or(1) as u32;
    let mut v = view_node(tree, node, depth, &mut opts);
    let mut chain = Vec::new();
    let mut cur = tree.nodes[node as usize].parent;
    while cur != NONE {
        chain.push(json!({"id": cur, "name": tree.nodes[cur as usize].name.to_string_lossy()}));
        cur = tree.nodes[cur as usize].parent;
    }
    chain.reverse();
    let result = json!({
        "id": id, "ok": true,
        "path": lossy(&tree.path_of(node)),
        "pathLossy": tree.is_lossy(node),
        "ancestors": chain,
        "node": v.take(),
    });
    send(st, result);
}

fn cmd_forget(st: &State, id: u64, msg: &Value) {
    let mut guard = st.tree.write().unwrap();
    let Some(tree) = guard.as_mut() else {
        send(st, json!({"id": id, "ok": true}));
        return;
    };
    let mut ok = true;
    if let Some(items) = msg["items"].as_array() {
        for it in items {
            let Some(p) = it["path"].as_str() else { continue };
            ok &= tree.forget(Path::new(p), it["size"].as_u64().unwrap_or(0));
        }
    }
    let summary = summary_json(tree, 0);
    send(st, json!({
        "id": id, "ok": ok,
        "bytes": summary["bytes"], "files": summary["files"], "dirs": summary["dirs"],
        "topFiles": summary["topFiles"], "artefacts": summary["artefacts"],
    }));
}

fn cmd_measure(st: Arc<State>, id: u64, msg: &Value) {
    let cancel = register(&st, id);
    let paths: Vec<String> = msg["paths"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    for path in &paths {
        if cancel.load(Relaxed) {
            break;
        }
        let p = Path::new(path);
        let progress = Progress::new(false);
        let (exists, bytes, files) = match fs::symlink_metadata(p) {
            Ok(md) if md.is_dir() => {
                let _ = scan::walk(p, &cancel, &progress, false);
                (true, progress.bytes.load(Relaxed), progress.files.load(Relaxed))
            }
            Ok(md) if md.is_file() => (true, meta::alloc(&md), 1),
            _ => (false, 0, 0),
        };
        send(&st, json!({"ev": "measured", "id": id, "path": path, "exists": exists, "bytes": bytes, "files": files}));
    }
    st.cancels.lock().unwrap().remove(&id);
    send(&st, json!({"id": id, "ok": true}));
}

/// The engine's own last line of defence; the app applies its stricter list first.
/// A disk's root ("/", "C:\\") has no named part and is always refused.
fn refuse(path: &Path) -> bool {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return true;
    }
    !path.components().any(|c| matches!(c, Component::Normal(_)))
}

fn cmd_delete(st: Arc<State>, id: u64, msg: &Value) {
    let cancel = register(&st, id);
    let keep_root = msg["keepRoot"].as_bool().unwrap_or(false);
    let paths: Vec<String> = msg["paths"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let started = Instant::now();
    let ctx = remove::Ctx::new(&cancel);
    let mut results = Vec::new();
    let done = AtomicBool::new(false);
    std::thread::scope(|s| {
        let (st_ref, ctx_ref, done_ref) = (&st, &ctx, &done);
        let ticker = s.spawn(move || {
            while !done_ref.load(Relaxed) {
                send(st_ref, json!({
                    "ev": "deleting", "id": id,
                    "freed": ctx_ref.freed.load(Relaxed),
                    "removed": ctx_ref.removed.load(Relaxed),
                    "errors": ctx_ref.errors.load(Relaxed),
                }));
                std::thread::sleep(Duration::from_millis(80));
            }
        });
        for path in &paths {
            let p = Path::new(path);
            let before = ctx.freed.load(Relaxed);
            let errors_before = ctx.errors.load(Relaxed);
            if refuse(p) {
                results.push(json!({"path": path, "freed": 0, "ok": false, "error": "refused"}));
                continue;
            }
            remove::remove(p, keep_root, &ctx);
            let errs = ctx.errors.load(Relaxed) - errors_before;
            results.push(json!({
                "path": path,
                "freed": ctx.freed.load(Relaxed) - before,
                "ok": errs == 0,
                "gone": !keep_root && fs::symlink_metadata(p).is_err(),
                "errors": errs,
            }));
        }
        done.store(true, Relaxed);
        let _ = ticker.join();
    });
    st.cancels.lock().unwrap().remove(&id);
    send(&st, json!({
        "id": id, "ok": true,
        "freed": ctx.freed.load(Relaxed),
        "removed": ctx.removed.load(Relaxed),
        "errors": ctx.errors.load(Relaxed),
        "messages": *ctx.messages.lock().unwrap(),
        "cancelled": cancel.load(Relaxed),
        "results": results,
        "ms": started.elapsed().as_millis() as u64,
    }));
}

fn bench(path: &str) {
    let cancel = AtomicBool::new(false);
    let progress = Progress::new(true);
    let t = Instant::now();
    match scan::walk(Path::new(path), &cancel, &progress, true) {
        Ok(tree) => {
            let r = &tree.nodes[0];
            println!(
                "{} bytes, {} files, {} dirs, {} errors, {} ms",
                r.bytes, r.files, r.dirs, tree.errors, t.elapsed().as_millis()
            );
        }
        Err(e) => println!("error: {e}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--bench" {
        bench(&args[2]);
        return;
    }
    let st = Arc::new(State::default());
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = msg["id"].as_u64().unwrap_or(0);
        let st2 = st.clone();
        match msg["cmd"].as_str().unwrap_or("") {
            "scan" => {
                let path = PathBuf::from(msg["path"].as_str().unwrap_or(""));
                let keep = msg["keep"].as_bool().unwrap_or(true);
                std::thread::spawn(move || cmd_scan(st2, id, path, keep));
            }
            "view" => {
                std::thread::spawn(move || cmd_view(&st2, id, &msg));
            }
            "forget" => {
                std::thread::spawn(move || cmd_forget(&st2, id, &msg));
            }
            "measure" => {
                std::thread::spawn(move || cmd_measure(st2, id, &msg));
            }
            "delete" => {
                std::thread::spawn(move || cmd_delete(st2, id, &msg));
            }
            "cancel" => {
                if let Some(flag) = st.cancels.lock().unwrap().get(&msg["target"].as_u64().unwrap_or(0)) {
                    flag.store(true, Relaxed);
                }
                send(&st, json!({"id": id, "ok": true}));
            }
            _ => send(&st, json!({"id": id, "ok": false, "error": "unknown_command"})),
        }
    }
}
