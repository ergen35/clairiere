//! File metadata helpers: the same questions, answered the way each system can.

#[cfg(unix)]
mod imp {
    use std::fs::Metadata;
    use std::os::unix::fs::MetadataExt;

    /// Space really taken on the disk (sparse and compressed files count for what they use).
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
}

#[cfg(windows)]
mod imp {
    use std::fs::Metadata;
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    /// Most NTFS disks use 4 KB clusters: a small file still takes a whole one.
    const CLUSTER: u64 = 4096;

    /// Space taken on the disk. Files kept only in the cloud (OneDrive and the like) take none.
    pub fn alloc(m: &Metadata) -> u64 {
        if m.is_dir() {
            return 0;
        }
        let attrs = m.file_attributes();
        if attrs & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0 {
            return 0;
        }
        m.file_size().div_ceil(CLUSTER) * CLUSTER
    }
    /// Junctions and mounted folders are links, never followed: one walk stays on one disk.
    pub fn dev(_: &Metadata) -> u64 {
        0
    }
    pub fn ino(_: &Metadata) -> u64 {
        0
    }
    pub fn nlink(_: &Metadata) -> u64 {
        1
    }
    /// From 100 ns steps since 1601 to seconds since 1970.
    pub fn mtime(m: &Metadata) -> i64 {
        (m.last_write_time() / 10_000_000) as i64 - 11_644_473_600
    }
}

pub use imp::*;
