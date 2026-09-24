/// The shared generated-directory policy; explicit indexing exclusions preserve live watches.
const COMMON: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vs",
];
const INDEX_ONLY: &[&str] = &[
    ".svelte-kit",
    ".gradle",
    "obj",
    "vendor",
    "Pods",
    ".dart_tool",
    "coverage",
];

pub(crate) enum DirectoryUse {
    Watch,
    Index,
}

pub(crate) fn excluded_directory(name: &str, operation: DirectoryUse) -> bool {
    match operation {
        DirectoryUse::Watch => COMMON.iter().any(|entry| name.eq_ignore_ascii_case(entry)),
        DirectoryUse::Index => COMMON
            .iter()
            .chain(INDEX_ONLY)
            .any(|entry| name.eq_ignore_ascii_case(entry)),
    }
}
