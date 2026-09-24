//! The folder the opt-in probes of the local machine copy real sessions into.
//!
//! Those probes (`#[ignore]`, run by hand with `cargo test -- --ignored`)
//! freeze each live transcript in a scratch file before comparing parsers.
//! A transcript is the user's own conversation with an agent: a copy of it
//! must never outlive the probe, not even when an assertion fails halfway
//! through the run.

use std::path::{Path, PathBuf};

/// An empty folder that is removed with everything in it when the guard
/// drops, which also happens while a failed assertion unwinds.
pub(crate) struct ProbeScratch(PathBuf);

impl ProbeScratch {
    pub(crate) fn new(dir: &Path) -> Self {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        Self(dir.to_path_buf())
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ProbeScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("yard-probe-scratch-{}-{name}", std::process::id()))
    }

    /// The regression that motivated the guard: every probe run left the
    /// last session it had copied in %TEMP%, one folder per run.
    #[test]
    fn a_finished_probe_leaves_no_copy_of_a_session_behind() {
        let dir = root("finished");
        {
            let scratch = ProbeScratch::new(&dir);
            std::fs::write(scratch.path().join("snapshot.jsonl"), b"a copied transcript").unwrap();
            assert!(dir.join("snapshot.jsonl").exists());
        }
        assert!(!dir.exists(), "the copy outlived the probe");
    }

    #[test]
    fn a_probe_that_fails_halfway_leaves_no_copy_of_a_session_behind() {
        let dir = root("failed");
        let run = std::panic::catch_unwind(|| {
            let scratch = ProbeScratch::new(&dir);
            std::fs::write(scratch.path().join("grown.jsonl"), b"a copied transcript").unwrap();
            panic!("an assertion failed mid-run");
        });
        assert!(run.is_err());
        assert!(!dir.exists(), "the copy outlived the failed probe");
    }

    #[test]
    fn a_probe_starts_from_an_empty_folder() {
        let dir = root("stale");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("left-by-an-older-run.jsonl"), b"old").unwrap();
        let scratch = ProbeScratch::new(&dir);
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
    }
}
