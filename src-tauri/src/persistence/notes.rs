//! The notebook: markdown notes, notebooks and labels (schema v5).
//!
//! Unlike the workspace snapshot — one blob rewritten wholesale on a debounce —
//! every operation here is row-sized: typing in a note upserts that note and
//! nothing else. The front end keeps the whole set in memory (search, counters
//! and filters live there), so the backend's contract is small: load
//! everything at boot, persist one row at a time.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub notebook_id: Option<String>,
    /// Tag ids, not names — renaming a tag must not touch every note.
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "status_none")]
    pub status: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// Set = the note is in the trash (soft delete).
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

fn status_none() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// A short glyph (emoji) chosen by the user; `None` = the default book icon.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTag {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesData {
    pub notes: Vec<Note>,
    pub notebooks: Vec<Notebook>,
    pub tags: Vec<NoteTag>,
}

pub fn load(conn: &Connection) -> anyhow::Result<NotesData> {
    let mut notes = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, body, notebook_id, tags_json, status, pinned,
                    created_at, updated_at, deleted_at
             FROM notes",
        )?;
        let rows = stmt.query_map([], |r| {
            let tags_json: String = r.get(4)?;
            Ok(Note {
                id: r.get(0)?,
                title: r.get(1)?,
                body: r.get(2)?,
                notebook_id: r.get(3)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                status: r.get(5)?,
                pinned: r.get::<_, i64>(6)? != 0,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                deleted_at: r.get(9)?,
            })
        })?;
        for row in rows {
            notes.push(row?);
        }
    }

    let mut notebooks = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, parent_id, icon, sort FROM notebooks ORDER BY sort, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(Notebook {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                icon: r.get(3)?,
                sort: r.get(4)?,
            })
        })?;
        for row in rows {
            notebooks.push(row?);
        }
    }

    let mut tags = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT id, name, color, sort FROM note_tags ORDER BY sort, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(NoteTag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                sort: r.get(3)?,
            })
        })?;
        for row in rows {
            tags.push(row?);
        }
    }

    Ok(NotesData {
        notes,
        notebooks,
        tags,
    })
}

pub fn save_note(conn: &Connection, note: &Note) -> anyhow::Result<()> {
    let tags_json = serde_json::to_string(&note.tags)?;
    conn.execute(
        "INSERT INTO notes (id, title, body, notebook_id, tags_json, status, pinned,
                            created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           notebook_id = excluded.notebook_id,
           tags_json = excluded.tags_json,
           status = excluded.status,
           pinned = excluded.pinned,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at",
        params![
            note.id,
            note.title,
            note.body,
            note.notebook_id,
            tags_json,
            note.status,
            note.pinned as i64,
            note.created_at,
            note.updated_at,
            note.deleted_at,
        ],
    )?;
    Ok(())
}

pub fn delete_note(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

pub fn save_notebook(conn: &Connection, notebook: &Notebook) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO notebooks (id, name, parent_id, icon, sort)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           parent_id = excluded.parent_id,
           icon = excluded.icon,
           sort = excluded.sort",
        params![
            notebook.id,
            notebook.name,
            notebook.parent_id,
            notebook.icon,
            notebook.sort
        ],
    )?;
    Ok(())
}

/// Removes the row only. Re-homing children and notes is the front end's
/// decision (it knows whether they climb to the grandparent or go loose), and
/// it sends those as ordinary upserts.
pub fn delete_notebook(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM notebooks WHERE id = ?1", [id])?;
    Ok(())
}

pub fn save_tag(conn: &Connection, tag: &NoteTag) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO note_tags (id, name, color, sort)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           color = excluded.color,
           sort = excluded.sort",
        params![tag.id, tag.name, tag.color, tag.sort],
    )?;
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM note_tags WHERE id = ?1", [id])?;
    Ok(())
}

/// Does the note exist? Used by tests and by callers that must tell
/// "saved nothing" apart from "saved over".
pub fn note_exists(conn: &Connection, id: &str) -> anyhow::Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM notes WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE notebooks (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
              icon TEXT, sort INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE note_tags (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
              sort INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE notes (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
              notebook_id TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
              status TEXT NOT NULL DEFAULT 'none',
              pinned INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              deleted_at INTEGER
            );
            "#,
        )
        .unwrap();
        c
    }

    fn note(id: &str) -> Note {
        Note {
            id: id.into(),
            title: "Plano da semana".into(),
            body: "- [ ] revisar o parser\n- [x] abrir o PR".into(),
            notebook_id: Some("nb1".into()),
            tags: vec!["t1".into(), "t2".into()],
            status: "active".into(),
            pinned: true,
            created_at: 10,
            updated_at: 20,
            deleted_at: None,
        }
    }

    #[test]
    fn note_round_trips_completely() {
        let c = conn();
        save_note(&c, &note("n1")).unwrap();

        let data = load(&c).unwrap();
        assert_eq!(data.notes.len(), 1);
        let n = &data.notes[0];
        assert_eq!(n.title, "Plano da semana");
        assert_eq!(n.tags, vec!["t1", "t2"]);
        assert_eq!(n.status, "active");
        assert!(n.pinned);
        assert_eq!(n.deleted_at, None);
    }

    #[test]
    fn upsert_updates_without_duplicating() {
        let c = conn();
        save_note(&c, &note("n1")).unwrap();
        let mut edited = note("n1");
        edited.title = "Outro título".into();
        edited.deleted_at = Some(99);
        save_note(&c, &edited).unwrap();

        let data = load(&c).unwrap();
        assert_eq!(data.notes.len(), 1);
        assert_eq!(data.notes[0].title, "Outro título");
        assert_eq!(data.notes[0].deleted_at, Some(99));
    }

    #[test]
    fn corrupted_tags_json_becomes_an_empty_list() {
        let c = conn();
        save_note(&c, &note("n1")).unwrap();
        c.execute(
            "UPDATE notes SET tags_json = '{quebrado' WHERE id = 'n1'",
            [],
        )
        .unwrap();
        let data = load(&c).unwrap();
        assert!(data.notes[0].tags.is_empty());
    }

    #[test]
    fn notebooks_and_tags_order_by_sort_then_name() {
        let c = conn();
        save_notebook(
            &c,
            &Notebook {
                id: "b".into(),
                name: "Bravo".into(),
                parent_id: None,
                icon: None,
                sort: 1,
            },
        )
        .unwrap();
        save_notebook(
            &c,
            &Notebook {
                id: "a".into(),
                name: "Alfa".into(),
                parent_id: Some("b".into()),
                icon: Some("📚".into()),
                sort: 0,
            },
        )
        .unwrap();
        save_tag(
            &c,
            &NoteTag {
                id: "t1".into(),
                name: "rust".into(),
                color: "#5fa8ff".into(),
                sort: 0,
            },
        )
        .unwrap();

        let data = load(&c).unwrap();
        assert_eq!(data.notebooks[0].id, "a");
        assert_eq!(data.notebooks[0].icon.as_deref(), Some("📚"));
        assert_eq!(data.notebooks[1].parent_id, None);
        assert_eq!(data.tags[0].color, "#5fa8ff");
    }

    #[test]
    fn delete_really_removes() {
        let c = conn();
        save_note(&c, &note("n1")).unwrap();
        assert!(note_exists(&c, "n1").unwrap());
        delete_note(&c, "n1").unwrap();
        assert!(!note_exists(&c, "n1").unwrap());

        save_notebook(
            &c,
            &Notebook {
                id: "nb".into(),
                name: "X".into(),
                parent_id: None,
                icon: None,
                sort: 0,
            },
        )
        .unwrap();
        delete_notebook(&c, "nb").unwrap();
        save_tag(
            &c,
            &NoteTag {
                id: "t".into(),
                name: "x".into(),
                color: "#fff".into(),
                sort: 0,
            },
        )
        .unwrap();
        delete_tag(&c, "t").unwrap();
        let data = load(&c).unwrap();
        assert!(data.notebooks.is_empty());
        assert!(data.tags.is_empty());
    }
}
