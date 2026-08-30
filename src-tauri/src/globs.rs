//! Path filters for the project search: the "incluir" and "excluir" fields.
//!
//! A glob here is deliberately small. It answers the questions people actually
//! type into those two boxes, `*.ts`, `src/**`, `**/*.test.ts`, `docs`, and
//! nothing else. No brace expansion, no character classes, no negation: the
//! exclude field *is* the negation, and a second syntax for it inside the
//! include field would be two ways to say one thing.
//!
//! The rules, whole:
//!
//! - a list is comma separated, and blank entries are ignored;
//! - a pattern with **no `/`** is matched against the file's **name**, which
//!   is what makes `*.rs` mean what everyone expects it to mean;
//! - a pattern **with** a `/` is matched against the path relative to the
//!   project root, always spelled with forward slashes;
//! - `*` is any run of characters inside one segment, `?` is one such
//!   character, and `**` crosses segments.
//!
//! Matching is case-insensitive. This is a Windows app: `SRC/Main.rs` and
//! `src/main.rs` are the same file, and a filter that disagreed with the file
//! system would be a filter that silently hides files.

/// A parsed list of patterns. An empty set means "no opinion", which the
/// caller reads as *everything* for an include and *nothing* for an exclude.
#[derive(Debug, Default, Clone)]
pub struct GlobSet {
    patterns: Vec<Glob>,
}

#[derive(Debug, Clone)]
struct Glob {
    /// Lowercased pattern.
    pattern: String,
    /// Matched against the file name alone rather than the whole path.
    name_only: bool,
}

impl GlobSet {
    /// Parses a comma separated list. Never fails: an unparseable entry is
    /// simply a pattern nothing matches, and a search box is no place for an
    /// error dialog.
    pub fn parse(list: &str) -> Self {
        let mut patterns = Vec::new();
        for raw in list.split(',') {
            let trimmed = raw.trim().trim_matches('/');
            if trimmed.is_empty() {
                continue;
            }
            let pattern = trimmed.replace('\\', "/").to_lowercase();
            let name_only = !pattern.contains('/');
            patterns.push(Glob {
                pattern,
                name_only,
            });
        }
        Self { patterns }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// Does any pattern take this path? `rel` is relative to the root, with `/`.
    pub fn matches(&self, rel: &str) -> bool {
        let lowered = rel.replace('\\', "/").to_lowercase();
        let name = lowered.rsplit('/').next().unwrap_or(&lowered).to_owned();
        self.patterns.iter().any(|glob| {
            let subject = if glob.name_only { &name } else { &lowered };
            matches_glob(&glob.pattern, subject)
        })
    }
}

/// The matcher itself, on bytes so the recursion is over indices and not over
/// cloned strings. Both sides are already lowercase ASCII-folded by the caller.
fn matches_glob(pattern: &str, subject: &str) -> bool {
    glob_here(pattern.as_bytes(), subject.as_bytes())
}

fn glob_here(pattern: &[u8], subject: &[u8]) -> bool {
    // `**` is the only construct allowed to cross a `/`, so it is peeled off
    // first: everything after it may start at any position of the subject.
    if pattern.starts_with(b"**") {
        let rest = strip_double_star(pattern);
        if rest.is_empty() {
            return true;
        }
        for at in 0..=subject.len() {
            if glob_here(rest, &subject[at..]) {
                return true;
            }
        }
        return false;
    }

    match pattern.first() {
        None => subject.is_empty(),
        Some(b'*') => {
            // One segment only: stop at the next `/`.
            let rest = &pattern[1..];
            let mut at = 0;
            loop {
                if glob_here(rest, &subject[at..]) {
                    return true;
                }
                if at >= subject.len() || subject[at] == b'/' {
                    return false;
                }
                at += 1;
            }
        }
        Some(b'?') => {
            if subject.is_empty() || subject[0] == b'/' {
                return false;
            }
            glob_here(&pattern[1..], &subject[1..])
        }
        Some(c) => {
            if subject.first() != Some(c) {
                return false;
            }
            glob_here(&pattern[1..], &subject[1..])
        }
    }
}

/// Everything after a `**` and the `/` that usually follows it, so that
/// `src/**/x` also matches `src/x`, the reading everyone expects.
fn strip_double_star(pattern: &[u8]) -> &[u8] {
    let mut rest = &pattern[2..];
    while rest.first() == Some(&b'*') {
        rest = &rest[1..];
    }
    if rest.first() == Some(&b'/') {
        rest = &rest[1..];
    }
    rest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn takes(list: &str, path: &str) -> bool {
        GlobSet::parse(list).matches(path)
    }

    #[test]
    fn an_empty_list_has_no_patterns_at_all() {
        // The caller decides what "no opinion" means; the set only reports it.
        assert!(GlobSet::parse("").is_empty());
        assert!(GlobSet::parse("  ,  , ").is_empty());
    }

    #[test]
    fn a_bare_extension_matches_the_file_name_anywhere() {
        // The whole reason `name_only` exists: nobody types `**/*.rs`.
        assert!(takes("*.rs", "src/pty/mod.rs"));
        assert!(takes("*.rs", "main.rs"));
        assert!(!takes("*.rs", "src/main.ts"));
    }

    #[test]
    fn a_pattern_with_a_slash_is_about_the_whole_path() {
        assert!(takes("src/*.ts", "src/app.ts"));
        assert!(!takes("src/*.ts", "lib/app.ts"));
        // And a single star does not cross a folder boundary.
        assert!(!takes("src/*.ts", "src/lib/app.ts"));
    }

    #[test]
    fn double_star_crosses_folders() {
        assert!(takes("src/**/*.ts", "src/lib/deep/app.ts"));
        assert!(takes("src/**", "src/lib/deep/app.ts"));
    }

    #[test]
    fn double_star_also_matches_no_folder_at_all() {
        // `src/**/x.ts` reading as "x.ts anywhere under src, including
        // directly in it" is what every editor does and what people mean.
        assert!(takes("src/**/app.ts", "src/app.ts"));
    }

    #[test]
    fn question_mark_is_one_character_and_not_a_separator() {
        assert!(takes("a?c.ts", "abc.ts"));
        assert!(!takes("a?c.ts", "ac.ts"));
        assert!(!takes("src/a?c.ts", "src/a/c.ts"));
    }

    #[test]
    fn the_list_is_comma_separated() {
        assert!(takes("*.ts, *.rs", "main.rs"));
        assert!(takes("*.ts, *.rs", "app.ts"));
        assert!(!takes("*.ts, *.rs", "notes.md"));
    }

    #[test]
    fn case_never_decides() {
        // On Windows `SRC/Main.rs` and `src/main.rs` are the same file, and a
        // filter that disagreed with the file system would hide files with no
        // way for the user to tell why.
        assert!(takes("src/*.rs", "SRC/Main.rs"));
        assert!(takes("*.RS", "src/main.rs"));
    }

    #[test]
    fn a_windows_separator_is_read_as_a_separator() {
        assert!(takes("src\\lib\\*.ts", "src/lib/app.ts"));
        assert!(takes("src/lib/*.ts", "src\\lib\\app.ts"));
    }

    #[test]
    fn a_bare_folder_name_matches_that_folder_by_name() {
        // `docs` in the exclude box means the folder called docs. It reads
        // against the *name*, so it takes the folder's own files.
        assert!(takes("docs/**", "docs/specs/06-tdd.md"));
        assert!(!takes("docs/**", "src/docs.ts"));
    }

    #[test]
    fn a_half_typed_pattern_matches_nothing_instead_of_failing() {
        // A half-written pattern is the normal state of a search box. There
        // is no syntax error to report here, only a filter that takes no file
        // yet: `[` and a bare prefix are ordinary text to this matcher.
        assert!(!takes("src/[", "src/main.rs"));
        assert!(!takes("src/ma", "src/main.rs"));
        // ...and a pattern that is only separators takes nothing either,
        // rather than every file in the project.
        assert!(!takes("/", "src/main.rs"));
    }
}
