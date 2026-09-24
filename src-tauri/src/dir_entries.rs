//! Asking a directory listing what its entries are, without opening them.
//!
//! `Path::is_dir` on an entry that `read_dir` just returned is one more open
//! of that entry: a `fs::metadata`, which follows links. On Windows the
//! enumeration already carries each entry's attributes, so
//! `DirEntry::metadata` and `DirEntry::file_type` cost no system call at all
//! (the standard library documents both as free there), and for a plain
//! entry they give the same answer. They do **not** follow links, though, so
//! a link, or any other reparse point, still asks the path: that is the one
//! case where following it changes what the walk sees.

use std::fs::{DirEntry, FileType};

/// Whether a listed entry is a folder, with exactly the answer
/// `entry.path().is_dir()` would give, links followed.
pub(crate) fn is_dir(entry: &DirEntry) -> bool {
    match plain_file_type(entry) {
        Some(kind) => kind.is_dir(),
        None => entry.path().is_dir(),
    }
}

/// The entry's type as the listing reports it, or `None` when the listing
/// cannot be trusted to stand in for a followed `fs::metadata`: the entry is
/// a link or another reparse point, or the listing did not say.
fn plain_file_type(entry: &DirEntry) -> Option<FileType> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Any reparse point, not only the name-surrogate ones `is_symlink`
        // recognises: a cloud placeholder or a deduplicated file is resolved
        // by a filter driver on open, and the open is the old answer.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let meta = entry.metadata().ok()?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return None;
        }
        Some(meta.file_type())
    }
    #[cfg(not(windows))]
    {
        let kind = entry.file_type().ok()?;
        if kind.is_symlink() {
            return None;
        }
        Some(kind)
    }
}

/// Folder links for the tests of the walks that use this module.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::Path;

    /// A directory link the test process is always allowed to create: a
    /// junction needs no privilege on Windows, unlike `symlink_dir`, so the
    /// link cases always run instead of quietly returning early.
    pub(crate) fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }
}

#[cfg(test)]
mod tests {
    //! The walks over the agents' session folders (`costs.rs`,
    //! `agents/sessions.rs`) used to ask `Path::is_dir` about every entry, one
    //! extra open per file. The listing already carries the answer for a
    //! plain entry; these tests hold the cheaper question to the old answer
    //! for every kind of entry, links included, because a link is where the
    //! two could disagree (a junction to a folder is a folder to those walks).
    use super::testing::link_dir;
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yard-dir-entries-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test folder");
        dir
    }

    fn answers(dir: &Path) -> Vec<(String, bool, bool)> {
        let mut out: Vec<(String, bool, bool)> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                (name, is_dir(&e), e.path().is_dir())
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_listed_entry_is_a_folder_exactly_when_path_is_dir_says_so() {
        let root = temp_dir("kinds");
        let target = temp_dir("kinds-target");
        std::fs::create_dir_all(root.join("pasta")).unwrap();
        std::fs::write(root.join("arquivo.jsonl"), "{}\n").unwrap();
        // A folder whose name looks like a file: the walks must still enter it.
        std::fs::create_dir_all(root.join("parece.jsonl")).unwrap();
        assert!(link_dir(&target, &root.join("atalho")), "a junction needs no privilege");
        let gone = temp_dir("kinds-gone");
        assert!(link_dir(&gone, &root.join("quebrado")), "a junction needs no privilege");
        std::fs::remove_dir_all(&gone).unwrap();

        let seen = answers(&root);
        for (name, cheap, followed) in &seen {
            assert_eq!(cheap, followed, "{name}: the listing and Path::is_dir disagree");
        }
        let folders: Vec<&str> = seen
            .iter()
            .filter(|(_, cheap, _)| *cheap)
            .map(|(name, _, _)| name.as_str())
            .collect();
        // The junction to a live folder counts as a folder (it is followed);
        // the one whose target is gone does not, and neither does the file.
        assert_eq!(folders, vec!["atalho", "parece.jsonl", "pasta"]);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&target);
    }
}
