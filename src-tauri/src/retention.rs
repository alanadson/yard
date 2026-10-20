//! Age and count limits for folders that only ever grow: portal screenshots,
//! large `yard ask` prompts, unused portal profiles. The decision is pure (a
//! list of names with their age, the clock as a parameter); `prune_dir`
//! applies it to a real folder.

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// One file (or folder) as the decision sees it.
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    /// Last modification, in epoch milliseconds.
    pub modified_ms: i64,
}

/// What goes, oldest first: everything older than `max_age_ms`, and, when
/// `keep` is given, whatever is left past the newest `keep`.
pub fn to_prune(entries: &[Entry], now: i64, max_age_ms: i64, keep: Option<usize>) -> Vec<String> {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.name.cmp(&a.name)));
    let mut gone: Vec<String> = sorted
        .into_iter()
        .enumerate()
        .filter(|(index, entry)| now - entry.modified_ms > max_age_ms || keep.is_some_and(|keep| *index >= keep))
        .map(|(_, entry)| entry.name.clone())
        .collect();
    gone.reverse();
    gone
}

/// The regular files of `dir` whose name `matches`, with their age. A missing
/// or unreadable folder is an empty list.
pub fn files_in(dir: &std::path::Path, matches: impl Fn(&str) -> bool) -> Vec<Entry> {
    let Ok(listing) = std::fs::read_dir(dir) else { return Vec::new() };
    listing
        .flatten()
        .filter_map(|item| {
            let metadata = item.metadata().ok().filter(|metadata| metadata.is_file())?;
            let name = item.file_name().into_string().ok().filter(|name| matches(name))?;
            Some(Entry { name, modified_ms: modified_ms(&metadata)? })
        })
        .collect()
}

pub fn modified_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Applies `to_prune` to the matching files of `dir` and returns the names it
/// deleted. Housekeeping: a file that will not go is logged and left for the
/// next pass.
pub fn prune_dir(dir: &std::path::Path, matches: impl Fn(&str) -> bool, now: i64, max_age_ms: i64, keep: Option<usize>) -> Vec<String> {
    let mut removed = Vec::new();
    for name in to_prune(&files_in(dir, matches), now, max_age_ms, keep) {
        match std::fs::remove_file(dir.join(&name)) {
            Ok(()) => removed.push(name),
            Err(error) => tracing::warn!(%error, dir = %dir.display(), name, "old file could not be pruned"),
        }
    }
    removed
}

/// Test helpers shared by the modules that prune with these rules.
#[cfg(test)]
pub mod testing {
    /// Writes `path` and backdates its modification time by `age_days`.
    pub fn write_aged(path: &std::path::Path, now: std::time::SystemTime, age_days: u64) {
        std::fs::write(path, b"content").unwrap();
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(now - std::time::Duration::from_secs(age_days * 24 * 60 * 60)).unwrap();
    }

    pub fn millis(time: std::time::SystemTime) -> i64 {
        time.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{millis, write_aged};
    // These folders hold files the app wrote for itself; the rules below are
    // the only thing between them and an ever-growing data directory, and the
    // only thing that keeps a still-useful file from being deleted.
    use super::*;

    const NOW: i64 = 100 * DAY_MS;

    fn entry(name: &str, age_days: i64) -> Entry {
        Entry { name: name.into(), modified_ms: NOW - age_days * DAY_MS }
    }

    #[test]
    fn files_older_than_the_age_limit_are_pruned_oldest_first() {
        let entries = [entry("recent.png", 1), entry("oldest.png", 30), entry("old.png", 8)];
        assert_eq!(to_prune(&entries, NOW, 7 * DAY_MS, None), ["oldest.png", "old.png"]);
    }

    #[test]
    fn pruning_a_folder_deletes_only_the_matching_files_the_decision_names() {
        let dir = std::env::temp_dir().join(format!("yard-retention-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("folder.png")).unwrap();
        let now = std::time::SystemTime::now();
        for (name, age_days) in [("old.png", 9), ("new.png", 1), ("old.txt", 9)] {
            write_aged(&dir.join(name), now, age_days);
        }
        let removed = prune_dir(&dir, |name| name.ends_with(".png"), millis(now), 7 * DAY_MS, None);
        assert_eq!(removed, ["old.png"]);
        assert!(dir.join("new.png").exists() && dir.join("old.txt").exists() && dir.join("folder.png").is_dir());
        assert!(prune_dir(&dir.join("missing"), |_| true, millis(now), 0, None).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn past_the_count_limit_the_oldest_files_go_even_when_they_are_recent() {
        let entries = [entry("c.png", 0), entry("a.png", 2), entry("b.png", 1)];
        assert_eq!(to_prune(&entries, NOW, 7 * DAY_MS, Some(2)), ["a.png"]);
        assert!(to_prune(&entries, NOW, 7 * DAY_MS, Some(3)).is_empty());
    }
}
