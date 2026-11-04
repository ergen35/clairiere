//! Parallel directory walker. Only directories are kept in memory: a directory's
//! files are summed while walking and re-listed on demand when someone looks at it,
//! which keeps millions of files down to a few tens of megabytes.
use crate::meta;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Condvar, Mutex};

pub const NONE: u32 = u32::MAX;
const MAX_BRANCHES: usize = 8192;
const TOP_FILES: usize = 300;
const SEEN_SHARDS: usize = 64;
const MAX_SAMPLES: usize = 200;

pub struct Node {
    pub name: Box<OsStr>,
    pub parent: u32,
    pub first_child: u32,
    pub next_sibling: u32,
    pub own_bytes: u64,
    pub own_files: u32,
    pub bytes: u64,
    pub files: u64,
    pub dirs: u32,
    pub mtime: i64,
    pub denied: bool,
    pub artefact: u8,
}

#[derive(Clone)]
pub struct TopFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
}

pub struct Tree {
    pub root: PathBuf,
    pub nodes: Vec<Node>,
    pub top_files: Vec<TopFile>,
    pub denied: Vec<PathBuf>,
    pub skipped_mounts: Vec<PathBuf>,
    pub errors: u64,
}

pub const ARTEFACT_KINDS: [&str; 7] = ["", "node", "rust", "python", "web", "gradle", "tools"];

struct Task {
    id: u32,
    parent: u32,
    path: PathBuf,
    name: Box<OsStr>,
    dev: u64,
    branch: u32,
    self_bytes: u64,
    mtime: i64,
    artefact: u8,
    hidden: bool,
    in_artefact: bool,
}

struct Rec {
    id: u32,
    node: Node,
}

pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub branch_bytes: Vec<AtomicU64>,
    pub branch_names: Mutex<Vec<String>>,
    pub current: Mutex<String>,
}

impl Progress {
    pub fn new(track_branches: bool) -> Self {
        let mut v = Vec::new();
        if track_branches {
            v.resize_with(MAX_BRANCHES, || AtomicU64::new(0));
        }
        Progress {
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            branch_bytes: v,
            branch_names: Mutex::new(Vec::new()),
            current: Mutex::new(String::new()),
        }
    }
}

struct Shared<'a> {
    queue: Mutex<Vec<Task>>,
    cv: Condvar,
    idle: AtomicUsize,
    workers: usize,
    done: AtomicBool,
    next_id: AtomicU32,
    seen: Vec<Mutex<HashSet<(u64, u64)>>>,
    cancel: &'a AtomicBool,
    progress: &'a Progress,
    collect: bool,
    mounts: Mounts,
    denied: Mutex<Vec<PathBuf>>,
    skipped: Mutex<Vec<PathBuf>>,
}

/// What the kernel says is mounted, so a walk stays on the disk it started on.
pub struct Mounts {
    list: Vec<(PathBuf, String)>,
    root_source: String,
}

impl Mounts {
    pub fn read(root: &Path) -> Mounts {
        let mut list = Vec::new();
        if let Ok(text) = fs::read_to_string("/proc/self/mountinfo") {
            for line in text.lines() {
                let mut parts = line.split(" - ");
                let (Some(a), Some(b)) = (parts.next(), parts.next()) else {
                    continue;
                };
                let Some(mp) = a.split(' ').nth(4) else {
                    continue;
                };
                let Some(source) = b.split(' ').nth(1) else {
                    continue;
                };
                list.push((PathBuf::from(unescape(mp)), source.to_string()));
            }
        }
        let root_source = list
            .iter()
            .filter(|(mp, _)| root.starts_with(mp))
            .max_by_key(|(mp, _)| mp.as_os_str().len())
            .map(|(_, s)| s.clone())
            .unwrap_or_default();
        Mounts { list, root_source }
    }

    /// True when `path` is the mount point of something other than the disk we started on.
    fn is_foreign(&self, path: &Path) -> bool {
        self.list
            .iter()
            .rev()
            .find(|(mp, _)| mp == path)
            .is_some_and(|(_, s)| *s != self.root_source)
    }
}

fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 4], 8) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn thread_count() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    (cores * 3).clamp(8, 48)
}

/// The per-worker result of a walk.
#[derive(Default)]
struct WorkerOut {
    recs: Vec<Rec>,
    heap: BinaryHeap<Reverse<(u64, i64, PathBuf)>>,
}

pub fn walk(root: &Path, cancel: &AtomicBool, progress: &Progress, collect: bool) -> Result<Tree, String> {
    let md = fs::symlink_metadata(root).map_err(|e| format!("{e}"))?;
    if !md.is_dir() {
        return Err("Ce chemin n'est pas un dossier.".into());
    }
    let workers = thread_count();
    let shared = Shared {
        queue: Mutex::new(vec![Task {
            id: 0,
            parent: NONE,
            path: root.to_path_buf(),
            name: root.as_os_str().into(),
            dev: meta::dev(&md),
            branch: NONE,
            self_bytes: meta::alloc(&md),
            mtime: meta::mtime(&md),
            artefact: 0,
            hidden: false,
            in_artefact: false,
        }]),
        cv: Condvar::new(),
        idle: AtomicUsize::new(0),
        workers,
        done: AtomicBool::new(false),
        next_id: AtomicU32::new(1),
        seen: (0..SEEN_SHARDS).map(|_| Mutex::new(HashSet::new())).collect(),
        cancel,
        progress,
        collect,
        mounts: Mounts::read(root),
        denied: Mutex::new(Vec::new()),
        skipped: Mutex::new(Vec::new()),
    };

    let outs: Vec<WorkerOut> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                std::thread::Builder::new()
                    .stack_size(256 * 1024)
                    .spawn_scoped(s, || worker(&shared))
                    .expect("thread")
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("join")).collect()
    });

    if cancel.load(Relaxed) {
        return Err("cancelled".into());
    }

    let count = shared.next_id.load(Relaxed) as usize;
    let mut nodes: Vec<Option<Node>> = Vec::new();
    if collect {
        nodes.resize_with(count, || None);
    }
    let mut heap: BinaryHeap<Reverse<(u64, i64, PathBuf)>> = BinaryHeap::with_capacity(TOP_FILES + 1);
    for out in outs {
        for r in out.recs {
            nodes[r.id as usize] = Some(r.node);
        }
        for item in out.heap {
            heap.push(item);
            if heap.len() > TOP_FILES {
                heap.pop();
            }
        }
    }
    let mut nodes: Vec<Node> = nodes.into_iter().flatten().collect();

    // A parent is always discovered before its children, so ids grow downward and a
    // single reverse pass adds every subtree up into its parent.
    for i in (1..nodes.len()).rev() {
        let parent = nodes[i].parent as usize;
        let (head, tail) = nodes.split_at_mut(i);
        let child = &mut tail[0];
        let p = &mut head[parent];
        p.bytes += child.bytes;
        p.files += child.files;
        p.dirs += child.dirs + 1;
        p.mtime = p.mtime.max(child.mtime);
        child.next_sibling = p.first_child;
        p.first_child = i as u32;
    }

    let mut top_files: Vec<TopFile> = heap
        .into_iter()
        .map(|Reverse((size, mtime, path))| TopFile { path, size, mtime })
        .collect();
    top_files.sort_by_key(|f| Reverse(f.size));

    Ok(Tree {
        root: root.to_path_buf(),
        nodes,
        top_files,
        denied: shared.denied.into_inner().unwrap_or_default(),
        skipped_mounts: shared.skipped.into_inner().unwrap_or_default(),
        errors: progress.errors.load(Relaxed),
    })
}

fn take(sh: &Shared) -> Option<Task> {
    let mut q = sh.queue.lock().unwrap();
    loop {
        if let Some(t) = q.pop() {
            return Some(t);
        }
        if sh.done.load(Relaxed) {
            return None;
        }
        let idle = sh.idle.fetch_add(1, Relaxed) + 1;
        if idle == sh.workers {
            sh.done.store(true, Relaxed);
            sh.idle.fetch_sub(1, Relaxed);
            sh.cv.notify_all();
            return None;
        }
        q = sh.cv.wait(q).unwrap();
        sh.idle.fetch_sub(1, Relaxed);
    }
}

fn worker(sh: &Shared) -> WorkerOut {
    let mut out = WorkerOut::default();
    let mut local: Vec<Task> = Vec::with_capacity(256);
    while let Some(task) = local.pop().or_else(|| take(sh)) {
        if sh.cancel.load(Relaxed) {
            local.clear();
            continue;
        }
        process(task, sh, &mut local, &mut out);
        // Depth-first locally (good for the disk), give work away only when someone is waiting.
        if local.len() > 1 && sh.idle.load(Relaxed) > 0 {
            let give = local.len().div_ceil(2);
            let mut q = sh.queue.lock().unwrap();
            q.extend(local.drain(..give));
            drop(q);
            sh.cv.notify_all();
        }
    }
    out
}

fn artefact_for_name(name: &[u8]) -> u8 {
    match name {
        b"__pycache__" | b".pytest_cache" | b".mypy_cache" | b".ruff_cache" | b".tox" => 3,
        b".next" | b".nuxt" | b".turbo" | b".svelte-kit" | b".parcel-cache" | b".angular" | b".astro" => 4,
        b".dart_tool" | b".terraform" => 6,
        _ => 0,
    }
}

fn bytes_of(name: &OsStr) -> &[u8] {
    name.as_encoded_bytes()
}

fn process(task: Task, sh: &Shared, local: &mut Vec<Task>, out: &mut WorkerOut) {
    let p = sh.progress;
    let mut own_bytes = task.self_bytes;
    let mut own_files = 0u64;
    let mut mtime = task.mtime;
    let mut denied = false;
    let mut artefact = task.artefact;
    let is_root = task.parent == NONE;
    let start = local.len();

    match fs::read_dir(&task.path) {
        Err(_) => {
            denied = true;
            p.errors.fetch_add(1, Relaxed);
            let mut d = sh.denied.lock().unwrap();
            if d.len() < MAX_SAMPLES {
                d.push(task.path.clone());
            }
        }
        Ok(rd) => {
            let mut has_cargo = false;
            let mut has_pkg = false;
            let mut has_gradle = false;
            let mut has_podfile = false;
            for ent in rd {
                let Ok(ent) = ent else {
                    p.errors.fetch_add(1, Relaxed);
                    continue;
                };
                let Ok(md) = ent.metadata() else {
                    p.errors.fetch_add(1, Relaxed);
                    continue;
                };
                let name = ent.file_name();
                if md.is_dir() {
                    let child_path = task.path.join(&name);
                    let dev = meta::dev(&md);
                    if dev != task.dev && sh.mounts.is_foreign(&child_path) {
                        let mut s = sh.skipped.lock().unwrap();
                        if s.len() < MAX_SAMPLES {
                            s.push(child_path);
                        }
                        continue;
                    }
                    let branch = if is_root {
                        let mut names = p.branch_names.lock().unwrap();
                        if names.len() < p.branch_bytes.len() {
                            names.push(name.to_string_lossy().into_owned());
                            (names.len() - 1) as u32
                        } else {
                            NONE
                        }
                    } else {
                        task.branch
                    };
                    let art = if task.in_artefact { 0 } else { artefact_for_name(bytes_of(&name)) };
                    local.push(Task {
                        id: sh.next_id.fetch_add(1, Relaxed),
                        parent: task.id,
                        path: child_path,
                        name: name.into_boxed_os_str(),
                        dev,
                        branch,
                        self_bytes: meta::alloc(&md),
                        mtime: meta::mtime(&md),
                        artefact: art,
                        hidden: task.hidden,
                        in_artefact: task.in_artefact || art != 0,
                    });
                } else {
                    let raw = bytes_of(&name);
                    match raw {
                        b"Cargo.toml" => has_cargo = true,
                        b"package.json" => has_pkg = true,
                        b"build.gradle" | b"build.gradle.kts" | b"settings.gradle" | b"settings.gradle.kts" => has_gradle = true,
                        b"Podfile" => has_podfile = true,
                        b"pyvenv.cfg" if !task.in_artefact => artefact = 3,
                        _ => {}
                    }
                    let mut size = meta::alloc(&md);
                    if size > 0 && meta::nlink(&md) > 1 {
                        let key = (meta::dev(&md), meta::ino(&md));
                        let shard = (key.1 as usize) % SEEN_SHARDS;
                        if !sh.seen[shard].lock().unwrap().insert(key) {
                            size = 0;
                        }
                    }
                    let mt = meta::mtime(&md);
                    own_bytes += size;
                    own_files += 1;
                    mtime = mtime.max(mt);
                    if sh.collect && size >= 1 << 20 {
                        let keep = out.heap.len() < TOP_FILES
                            || out.heap.peek().is_some_and(|Reverse(t)| t.0 < size);
                        if keep {
                            out.heap.push(Reverse((size, mt, task.path.join(&name))));
                            if out.heap.len() > TOP_FILES {
                                out.heap.pop();
                            }
                        }
                    }
                }
            }
            // Directories that only count as rebuildable when the project that owns them is next to them.
            if !task.in_artefact {
                for t in &mut local[start..] {
                    let n = bytes_of(&t.name);
                    let kind = match n {
                        b"node_modules" if has_pkg => 1,
                        b"target" if has_cargo => 2,
                        b".gradle" | b"build" if has_gradle => 5,
                        b"Pods" if has_podfile => 6,
                        _ => 0,
                    };
                    if kind != 0 {
                        t.artefact = kind;
                        t.in_artefact = true;
                    }
                }
            }
        }
    }

    // Hidden folders hold applications' private data: what is inside one is never offered
    // as a project clean-up, and a whole hidden folder only counts when it is a known kind.
    let self_hidden = !is_root && bytes_of(&task.name).first() == Some(&b'.');
    if task.hidden {
        artefact = 0;
    }
    if self_hidden || task.hidden || artefact != 0 {
        for t in &mut local[start..] {
            t.hidden = t.hidden || self_hidden;
            if artefact != 0 {
                t.artefact = 0;
                t.in_artefact = true;
            }
        }
    }

    let dirs_done = p.dirs.fetch_add(1, Relaxed);
    p.files.fetch_add(own_files, Relaxed);
    p.bytes.fetch_add(own_bytes, Relaxed);
    if task.branch != NONE {
        p.branch_bytes[task.branch as usize].fetch_add(own_bytes, Relaxed);
    }
    if dirs_done & 0x7f == 0 {
        if let Ok(mut c) = p.current.try_lock() {
            c.clear();
            c.push_str(&task.path.to_string_lossy());
        }
    }

    if sh.collect {
        out.recs.push(Rec {
            id: task.id,
            node: Node {
                name: task.name,
                parent: task.parent,
                first_child: NONE,
                next_sibling: NONE,
                own_bytes,
                own_files: own_files.min(u32::MAX as u64) as u32,
                bytes: own_bytes,
                files: own_files,
                dirs: 0,
                mtime,
                denied,
                artefact,
            },
        });
    }
}

impl Tree {
    pub fn path_of(&self, id: u32) -> PathBuf {
        let mut parts: Vec<&OsStr> = Vec::new();
        let mut cur = id;
        while cur != 0 && cur != NONE {
            let n = &self.nodes[cur as usize];
            parts.push(&n.name);
            cur = n.parent;
        }
        let mut p = self.root.clone();
        for part in parts.iter().rev() {
            p.push(part);
        }
        p
    }

    pub fn is_lossy(&self, id: u32) -> bool {
        let mut cur = id;
        while cur != 0 && cur != NONE {
            let n = &self.nodes[cur as usize];
            if n.name.to_str().is_none() {
                return true;
            }
            cur = n.parent;
        }
        self.root.to_str().is_none()
    }

    pub fn children(&self, id: u32) -> Vec<u32> {
        let mut v = Vec::new();
        let mut cur = self.nodes[id as usize].first_child;
        while cur != NONE {
            v.push(cur);
            cur = self.nodes[cur as usize].next_sibling;
        }
        v
    }

    /// Finds the directory at `path`, or None.
    pub fn locate(&self, path: &Path) -> Option<u32> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let mut cur = 0u32;
        for comp in rel.components() {
            let name = comp.as_os_str();
            let mut child = self.nodes[cur as usize].first_child;
            loop {
                if child == NONE {
                    return None;
                }
                if &*self.nodes[child as usize].name == name {
                    break;
                }
                child = self.nodes[child as usize].next_sibling;
            }
            cur = child;
        }
        Some(cur)
    }

    fn subtract_up(&mut self, from: u32, bytes: u64, files: u64, dirs: u32) {
        let mut cur = from;
        while cur != NONE {
            let n = &mut self.nodes[cur as usize];
            n.bytes = n.bytes.saturating_sub(bytes);
            n.files = n.files.saturating_sub(files);
            n.dirs = n.dirs.saturating_sub(dirs);
            cur = n.parent;
        }
    }

    /// Removes a deleted path from the tree so totals stay right without scanning again.
    pub fn forget(&mut self, path: &Path, file_bytes: u64) -> bool {
        self.top_files.retain(|f| !f.path.starts_with(path));
        if let Some(id) = self.locate(path) {
            if id == 0 {
                return false;
            }
            let (bytes, files, dirs, parent) = {
                let n = &self.nodes[id as usize];
                (n.bytes, n.files, n.dirs + 1, n.parent)
            };
            self.subtract_up(parent, bytes, files, dirs);
            let next = self.nodes[id as usize].next_sibling;
            let first = self.nodes[parent as usize].first_child;
            if first == id {
                self.nodes[parent as usize].first_child = next;
            } else {
                let mut c = first;
                while c != NONE {
                    if self.nodes[c as usize].next_sibling == id {
                        self.nodes[c as usize].next_sibling = next;
                        break;
                    }
                    c = self.nodes[c as usize].next_sibling;
                }
            }
            return true;
        }
        let Some(parent) = path.parent().and_then(|p| self.locate(p)) else {
            return false;
        };
        {
            let n = &mut self.nodes[parent as usize];
            n.own_bytes = n.own_bytes.saturating_sub(file_bytes);
            n.own_files = n.own_files.saturating_sub(1);
        }
        self.subtract_up(parent, file_bytes, 1, 0);
        true
    }

    /// Rebuildable project folders found by the walk, biggest first.
    pub fn artefacts(&self) -> Vec<u32> {
        let mut v: Vec<u32> = (0..self.nodes.len() as u32)
            .filter(|&i| self.nodes[i as usize].artefact != 0 && self.nodes[i as usize].bytes >= 1 << 20)
            .filter(|&i| self.is_attached(i))
            .collect();
        v.sort_by_key(|&i| Reverse(self.nodes[i as usize].bytes));
        v.truncate(500);
        v
    }

    fn is_attached(&self, id: u32) -> bool {
        let n = &self.nodes[id as usize];
        if n.parent == NONE {
            return true;
        }
        let mut c = self.nodes[n.parent as usize].first_child;
        while c != NONE {
            if c == id {
                return true;
            }
            c = self.nodes[c as usize].next_sibling;
        }
        false
    }
}
