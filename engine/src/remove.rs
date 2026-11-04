//! Fast deletion that never follows links and never leaves the disk it started on.
use crate::meta;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;

const MAX_ERRORS: usize = 20;

pub struct Ctx<'a> {
    pub freed: AtomicU64,
    pub removed: AtomicU64,
    pub errors: AtomicU64,
    pub messages: Mutex<Vec<String>>,
    pub cancel: &'a AtomicBool,
}

impl<'a> Ctx<'a> {
    pub fn new(cancel: &'a AtomicBool) -> Self {
        Ctx {
            freed: AtomicU64::new(0),
            removed: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            messages: Mutex::new(Vec::new()),
            cancel,
        }
    }

    fn fail(&self, path: &Path, why: &str) {
        self.errors.fetch_add(1, Relaxed);
        let mut m = self.messages.lock().unwrap();
        if m.len() < MAX_ERRORS {
            m.push(format!("{} : {}", path.display(), why));
        }
    }
}

fn make_writable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).is_ok()
}

fn why(e: &std::io::Error) -> &'static str {
    match e.kind() {
        ErrorKind::PermissionDenied => "accès refusé",
        ErrorKind::NotFound => "déjà absent",
        _ => "suppression impossible",
    }
}

fn remove_file(path: &Path, size: u64, ctx: &Ctx) {
    let mut res = fs::remove_file(path);
    if matches!(&res, Err(e) if e.kind() == ErrorKind::PermissionDenied) {
        // Package managers often leave read-only folders behind: unlocking one is all it takes.
        if path.parent().is_some_and(make_writable) {
            res = fs::remove_file(path);
        }
    }
    match res {
        Ok(()) => {
            ctx.freed.fetch_add(size, Relaxed);
            ctx.removed.fetch_add(1, Relaxed);
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => ctx.fail(path, why(&e)),
    }
}

fn list(path: &Path, ctx: &Ctx) -> Option<Vec<fs::DirEntry>> {
    let mut rd = fs::read_dir(path);
    if matches!(&rd, Err(e) if e.kind() == ErrorKind::PermissionDenied) && make_writable(path) {
        rd = fs::read_dir(path);
    }
    match rd {
        Ok(rd) => Some(rd.filter_map(Result::ok).collect()),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => {
            ctx.fail(path, why(&e));
            None
        }
    }
}

fn remove_dir_tree(path: &Path, dev: u64, self_bytes: u64, ctx: &Ctx) {
    if ctx.cancel.load(Relaxed) {
        return;
    }
    let Some(entries) = list(path, ctx) else {
        return;
    };
    for ent in entries {
        remove_entry(&ent, dev, ctx);
    }
    if ctx.cancel.load(Relaxed) {
        return;
    }
    remove_empty_dir(path, self_bytes, ctx);
}

fn remove_empty_dir(path: &Path, self_bytes: u64, ctx: &Ctx) {
    let mut res = fs::remove_dir(path);
    if matches!(&res, Err(e) if e.kind() == ErrorKind::PermissionDenied) {
        if path.parent().is_some_and(make_writable) {
            res = fs::remove_dir(path);
        }
    }
    match res {
        Ok(()) => {
            ctx.freed.fetch_add(self_bytes, Relaxed);
            ctx.removed.fetch_add(1, Relaxed);
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => {
            // A failure further down already explains why a folder stays non-empty.
            if ctx.errors.load(Relaxed) == 0 {
                ctx.fail(path, why(&e));
            }
        }
    }
}

fn remove_entry(ent: &fs::DirEntry, dev: u64, ctx: &Ctx) {
    let path = ent.path();
    let Ok(md) = ent.metadata() else {
        return;
    };
    if md.is_dir() {
        if meta::dev(&md) != dev {
            ctx.fail(&path, "autre disque monté ici, laissé en place");
            return;
        }
        remove_dir_tree(&path, dev, meta::alloc(&md), ctx);
    } else {
        remove_file(&path, meta::alloc(&md), ctx);
    }
}

/// Deletes `root` (or only what it contains when `keep_root`), using all the threads available.
pub fn remove(root: &Path, keep_root: bool, ctx: &Ctx) {
    let Ok(md) = fs::symlink_metadata(root) else {
        return;
    };
    if !md.is_dir() {
        if keep_root {
            return; // A link or a file where a folder was expected: leave it alone.
        }
        remove_file(root, meta::alloc(&md), ctx);
        return;
    }
    let dev = meta::dev(&md);
    let Some(entries) = list(root, ctx) else {
        return;
    };

    // Share the top-level entries, and one level below, between threads.
    let mut paths: Vec<fs::DirEntry> = Vec::with_capacity(entries.len());
    let mut parents: Vec<(PathBuf, u64)> = Vec::new();
    for ent in entries {
        let is_dir = ent.file_type().is_ok_and(|t| t.is_dir());
        if !is_dir {
            paths.push(ent);
            continue;
        }
        let Ok(child_md) = ent.metadata() else {
            continue;
        };
        if meta::dev(&child_md) != dev {
            ctx.fail(&ent.path(), "autre disque monté ici, laissé en place");
            continue;
        }
        let p = ent.path();
        if let Some(sub) = list(&p, ctx) {
            parents.push((p, meta::alloc(&child_md)));
            paths.extend(sub);
        }
    }

    let queue = Mutex::new(paths);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 16);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let next = queue.lock().unwrap().pop();
                let Some(ent) = next else {
                    break;
                };
                remove_entry(&ent, dev, ctx);
            });
        }
    });
    if ctx.cancel.load(Relaxed) {
        return;
    }
    for (p, bytes) in parents {
        remove_empty_dir(&p, bytes, ctx);
    }
    if !keep_root {
        remove_empty_dir(root, meta::alloc(&md), ctx);
    }
}
