//! On-disk state: SQLite for the structure, `.bin` for scrollback,
//! `.zip` for backup.

pub mod autobackup;
pub mod backup;
pub mod db;
pub mod notes;
pub mod workspace;
