//! File metadata helpers (Linux).
use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;

pub fn alloc(m: &Metadata) -> u64 {
    m.blocks() * 512
}
pub fn dev(m: &Metadata) -> u64 {
    m.dev()
}
pub fn ino(m: &Metadata) -> u64 {
    m.ino()
}
pub fn nlink(m: &Metadata) -> u64 {
    m.nlink()
}
pub fn mtime(m: &Metadata) -> i64 {
    m.mtime()
}
