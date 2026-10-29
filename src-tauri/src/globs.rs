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

use regex::{Regex, RegexBuilder};

/// A parsed list of patterns. An empty set means "no opinion", which the
/// caller reads as *everything* for an include and *nothing* for an exclude.
#[derive(Debug, Default, Clone)]
pub struct GlobSet {
    patterns: Vec<Glob>,
}

#[derive(Debug, Clone)]
struct Glob {
    /// Compiled once per query. Oversized patterns match nothing.
    pattern: Option<Regex>,
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
                pattern: compile_glob(&pattern),
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
        let name = lowered.rsplit('/').next().unwrap_or(&lowered);
        self.patterns.iter().any(|glob| {
            let subject = if glob.name_only { name } else { &lowered };
            glob.pattern
                .as_ref()
                .is_some_and(|pattern| pattern.is_match(subject))
        })
    }
}

/// Compile the small glob language to the existing regex engine, avoiding
/// recursive backtracking for every file in a project. `?` consumes a Unicode
/// character, and every non-glob character stays literal.
fn compile_glob(pattern: &str) -> Option<Regex> {
    let mut expression = String::from("\\A");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' if chars.peek() == Some(&'*') => {
                while chars.peek() == Some(&'*') {
                    chars.next();
                }
                // Preserve the zero-folder case of `src/**/app.ts`.
                if chars.peek() == Some(&'/') {
                    chars.next();
                }
                expression.push_str(".*");
            }
            '*' => expression.push_str("[^/]*"),
            '?' => expression.push_str("[^/]"),
            literal => expression.push_str(&regex::escape(&literal.to_string())),
        }
    }
    expression.push_str("\\z");
    RegexBuilder::new(&expression)
        .dot_matches_new_line(true)
        .build()
        .ok()
}

#[cfg(test)]
mod tests {
    // File filters must stay responsive and preserve path boundaries and literal names.
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

    /// Byte recursion split accented letters and emoji, hiding valid files from search.
    #[test]
    fn a_question_mark_matches_one_unicode_character() {
        assert!(takes("caf?.ts", "café.ts"));
        assert!(takes("?.ts", "🦀.ts"));
        assert!(!takes("?.ts", "ab.ts"));
    }

    #[test]
    fn a_long_repeated_name_does_not_match_a_missing_wildcard_suffix() {
        let filter = GlobSet::parse("*a*a*a*a*a*a*b.ts");
        assert!(!filter.matches(&format!("{}c.ts", "a".repeat(200))));
    }

    #[test]
    fn regex_metacharacters_in_file_names_stay_literal() {
        for name in [
            "[draft].ts",
            "app(1).ts",
            "a+b.ts",
            "cost$.ts",
            "a^b.ts",
            "{draft}.ts",
        ] {
            let filter = GlobSet::parse(name);
            assert!(filter.matches(name));
            assert!(!filter.matches("other.ts"));
        }
        assert!(!takes("app.ts", "appXts"));
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
