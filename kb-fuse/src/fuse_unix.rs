use std::ffi::OsStr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory,
    ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow,
};

use crate::config::Config;
use crate::vfs::{EntryKind, NodeAttr, VfsCore, VfsError};

const TTL: Duration = Duration::from_secs(0);

pub struct KbFuseFs {
    vfs: Arc<VfsCore>,
    uid: u32,
    gid: u32,
}

impl KbFuseFs {
    pub fn new(vfs: Arc<VfsCore>) -> Self {
        let uid = unsafe { libc::getuid() as u32 };
        let gid = unsafe { libc::getgid() as u32 };
        Self { vfs, uid, gid }
    }

    fn to_file_attr(&self, attr: &NodeAttr) -> FileAttr {
        let kind = match attr.kind {
            EntryKind::Directory => FileType::Directory,
            EntryKind::RegularFile => FileType::RegularFile,
        };
        let blocks = attr.size.div_ceil(512);
        FileAttr {
            ino: attr.ino,
            size: attr.size,
            blocks,
            atime: attr.mtime,
            mtime: attr.mtime,
            ctime: attr.mtime,
            crtime: UNIX_EPOCH,
            kind,
            perm: attr.perm,
            nlink: attr.nlink,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 4096,
            flags: 0,
        }
    }
}

fn to_errno(err: VfsError) -> i32 {
    match err {
        VfsError::NotFound => libc::ENOENT,
        VfsError::NotDir => libc::ENOTDIR,
        VfsError::IsDir => libc::EISDIR,
        VfsError::ReadOnly => libc::EROFS,
        VfsError::BadFd => libc::EBADF,
        VfsError::NeedsLogin => libc::EACCES,
        VfsError::Io => libc::EIO,
    }
}

impl Filesystem for KbFuseFs {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let Some(name_str) = name.to_str() else {
            reply.error(libc::ENOENT);
            return;
        };
        match self.vfs.lookup(parent, name_str) {
            Ok(attr) => reply.entry(&TTL, &self.to_file_attr(&attr), 0),
            Err(err) => reply.error(to_errno(err)),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        match self.vfs.getattr(ino) {
            Ok(attr) => reply.attr(&TTL, &self.to_file_attr(&attr)),
            Err(err) => reply.error(to_errno(err)),
        }
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        match self.vfs.readdir(ino, offset) {
            Ok(entries) => {
                for item in entries {
                    let kind = match item.kind {
                        EntryKind::Directory => FileType::Directory,
                        EntryKind::RegularFile => FileType::RegularFile,
                    };
                    if reply.add(item.ino, item.offset, kind, item.name) {
                        break;
                    }
                }
                reply.ok();
            }
            Err(err) => reply.error(to_errno(err)),
        }
    }

    fn open(&mut self, _req: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        let acc_mode = flags & libc::O_ACCMODE;
        let is_write = acc_mode == libc::O_WRONLY || acc_mode == libc::O_RDWR;
        match self.vfs.open(ino, is_write) {
            Ok(fh) => reply.opened(fh, 0),
            Err(err) => reply.error(to_errno(err)),
        }
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyData,
    ) {
        match self.vfs.read(fh, offset, size) {
            Ok(data) => reply.data(&data),
            Err(err) => reply.error(to_errno(err)),
        }
    }

    fn release(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        _flags: i32,
        _lock_owner: Option<u64>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        self.vfs.release(fh);
        reply.ok();
    }

    fn access(&mut self, _req: &Request<'_>, ino: u64, mask: i32, reply: ReplyEmpty) {
        if (mask & libc::W_OK) != 0 {
            reply.error(libc::EROFS);
            return;
        }
        match self.vfs.getattr(ino) {
            Ok(_) => reply.ok(),
            Err(err) => reply.error(to_errno(err)),
        }
    }

    fn statfs(&mut self, _req: &Request<'_>, _ino: u64, reply: ReplyStatfs) {
        let files = self.vfs.doc_count() as u64;
        reply.statfs(1_048_576, 0, 0, files, 0, 4096, 255, 4096);
    }

    fn setattr(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        _size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<std::time::SystemTime>,
        _fh: Option<u64>,
        _crtime: Option<std::time::SystemTime>,
        _chgtime: Option<std::time::SystemTime>,
        _bkuptime: Option<std::time::SystemTime>,
        _flags: Option<u32>,
        reply: ReplyAttr,
    ) {
        reply.error(libc::EROFS);
    }

    fn mkdir(
        &mut self,
        _req: &Request<'_>,
        _parent: u64,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        reply.error(libc::EROFS);
    }

    fn unlink(&mut self, _req: &Request<'_>, _parent: u64, _name: &OsStr, reply: ReplyEmpty) {
        reply.error(libc::EROFS);
    }

    fn rmdir(&mut self, _req: &Request<'_>, _parent: u64, _name: &OsStr, reply: ReplyEmpty) {
        reply.error(libc::EROFS);
    }

    fn rename(
        &mut self,
        _req: &Request<'_>,
        _parent: u64,
        _name: &OsStr,
        _newparent: u64,
        _newname: &OsStr,
        _flags: u32,
        reply: ReplyEmpty,
    ) {
        reply.error(libc::EROFS);
    }

    fn create(
        &mut self,
        _req: &Request<'_>,
        _parent: u64,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        reply.error(libc::EROFS);
    }

    fn write(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        _fh: u64,
        _offset: i64,
        _data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyWrite,
    ) {
        reply.error(libc::EROFS);
    }
}

pub fn spawn_mount(
    vfs: Arc<VfsCore>,
    config: &Config,
) -> anyhow::Result<fuser::BackgroundSession> {
    std::fs::create_dir_all(&config.mount_point)?;
    let mut options = vec![
        MountOption::RO,
        MountOption::FSName("kb-fuse".to_string()),
        MountOption::Subtype("kb-fuse".to_string()),
        MountOption::DefaultPermissions,
    ];
    if config.allow_other {
        options.push(MountOption::AllowOther);
    }

    let session = fuser::spawn_mount2(KbFuseFs::new(vfs), &config.mount_point, &options)?;
    Ok(session)
}

pub fn unmount_path(mount_point: &Path) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    let candidates = [
        ("fusermount3", vec!["-u".to_string(), mount_point.display().to_string()]),
        ("fusermount", vec!["-u".to_string(), mount_point.display().to_string()]),
        ("umount", vec![mount_point.display().to_string()]),
    ];
    #[cfg(not(target_os = "linux"))]
    let candidates = [("umount", vec![mount_point.display().to_string()])];

    let mut last_err = String::new();
    for (bin, args) in candidates {
        match std::process::Command::new(bin).args(&args).status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => last_err = format!("{bin} exited with {status}"),
            Err(err) => last_err = format!("{bin}: {err}"),
        }
    }
    anyhow::bail!("failed to unmount {}: {last_err}", mount_point.display())
}
