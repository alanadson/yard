//! Workspace snapshot/restore, with a **monotonic revision guard**.
//!
//! The scenario this prevents: the UI reloads (HMR, WebView crash) holding
//! an old state in memory, an autosave fires, and the new state — with the
//! terminals you just opened — is overwritten by the old one. Every write
//! carries a revision; the backend **rejects** any that is smaller than the current.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::db;

const REV_KEY: &str = "workspace_rev";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub color: Option<String>,
    /// Name of an icon from the front-end registry (`lib/projectStyle.ts`).
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    /// The project this group belongs to — `None` makes it a **board**: the
    /// canvas as its own container, holding cards from several projects at
    /// once, so there is no single project it could point at. Nullable in the
    /// schema since v7.
    #[serde(default)]
    pub project_id: Option<String>,
    pub name: String,
    #[serde(default = "empty_json")]
    pub layout_json: String,
    #[serde(default)]
    pub suspended: bool,
    #[serde(default)]
    pub sort: i64,
}

fn empty_json() -> String {
    "{}".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub id: String,
    pub group_id: String,
    #[serde(default)]
    pub slot: i64,
    /// Which of the group's two surfaces draws this terminal: `grid` (a tab of
    /// a pane) or `canvas` (a card on the board). They used to draw the same
    /// pool, so a CLI was both at once; now it is one or the other, and this
    /// is the only thing that says which.
    ///
    /// `None` means "written before the split, nobody has decided yet". This
    /// layer deliberately does **not** decide: which surface a pre-split
    /// terminal belongs to is the surface its group was showing, and the group
    /// layout is JSON parsed in the front end (`stampSurfaces`), which stamps
    /// these on the first load and saves them back. Defaulting to `"grid"`
    /// here would look harmless and quietly send every card of every canvas
    /// group to a pane, since a stamped row is never stamped again.
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "shell_kind")]
    pub kind: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    /// How to resume (e.g. `["--resume","<id>"]`), serialized as JSON.
    #[serde(default)]
    pub resume: Option<Vec<String>>,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub alive: bool,
    #[serde(default)]
    pub created_at: i64,
    /// Kept at the front of its bar, and out of every crowd close. The pane's
    /// files carry the same flag in the front end's own store; a CLI is a row
    /// here, so it is a column (schema v8).
    #[serde(default)]
    pub pinned: bool,
}

fn shell_kind() -> String {
    "shell".to_string()
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub terminals: Vec<Terminal>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub rev: i64,
    /// `false` when the write was rejected for being older than the current state.
    pub accepted: bool,
}

pub fn current_rev(conn: &Connection) -> i64 {
    db::kv_get(conn, REV_KEY)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

/// Writes the entire snapshot in a transaction. Rejects stale revisions.
pub fn save(conn: &mut Connection, snap: &WorkspaceSnapshot) -> anyhow::Result<SaveResult> {
    let current = current_rev(conn);
    if snap.rev < current {
        tracing::warn!(
            received = snap.rev,
            current,
            "snapshot atrasado recusado"
        );
        return Ok(SaveResult {
            rev: current,
            accepted: false,
        });
    }
    let next = current.max(snap.rev) + 1;

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM terminals", [])?;
    tx.execute("DELETE FROM groups", [])?;
    tx.execute("DELETE FROM projects", [])?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO projects(id, name, path, color, icon, sort, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for p in &snap.projects {
            stmt.execute(rusqlite::params![
                p.id,
                p.name,
                p.path,
                p.color,
                p.icon,
                p.sort,
                p.created_at
            ])?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO groups(id, project_id, name, layout_json, suspended, sort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for g in &snap.groups {
            stmt.execute(rusqlite::params![
                g.id,
                g.project_id,
                g.name,
                g.layout_json,
                g.suspended as i64,
                g.sort
            ])?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO terminals(id, group_id, slot, surface, title, kind, agent_id, program,
                                   args_json, cwd, resume_json, sort, alive, created_at, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for t in &snap.terminals {
            let args = serde_json::to_string(&t.args).unwrap_or_else(|_| "[]".into());
            let resume = t
                .resume
                .as_ref()
                .map(|r| serde_json::to_string(r).unwrap_or_else(|_| "[]".into()));
            stmt.execute(rusqlite::params![
                t.id,
                t.group_id,
                t.slot,
                t.surface,
                t.title,
                t.kind,
                t.agent_id,
                t.program,
                args,
                t.cwd,
                resume,
                t.sort,
                t.alive as i64,
                t.created_at,
                t.pinned as i64
            ])?;
        }
    }

    tx.execute(
        "INSERT INTO kv(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![REV_KEY, next.to_string()],
    )?;
    tx.commit()?;

    Ok(SaveResult {
        rev: next,
        accepted: true,
    })
}

pub fn load(conn: &Connection) -> anyhow::Result<WorkspaceSnapshot> {
    let mut snap = WorkspaceSnapshot {
        rev: current_rev(conn),
        projects: Vec::new(),
        groups: Vec::new(),
        terminals: Vec::new(),
    };

    {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, color, icon, sort, created_at FROM projects ORDER BY sort, name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                path: r.get(2)?,
                color: r.get(3)?,
                icon: r.get(4)?,
                sort: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        for p in rows {
            snap.projects.push(p?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, layout_json, suspended, sort FROM groups ORDER BY sort",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Group {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                layout_json: r.get(3)?,
                suspended: r.get::<_, i64>(4)? != 0,
                sort: r.get(5)?,
            })
        })?;
        for g in rows {
            snap.groups.push(g?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id, group_id, slot, surface, title, kind, agent_id, program, args_json, cwd,
                    resume_json, sort, alive, created_at, pinned
             FROM terminals ORDER BY sort",
        )?;
        let rows = stmt.query_map([], |r| {
            let args_json: String = r.get(8)?;
            let resume_json: Option<String> = r.get(10)?;
            Ok(Terminal {
                id: r.get(0)?,
                group_id: r.get(1)?,
                slot: r.get(2)?,
                surface: r.get(3)?,
                title: r.get(4)?,
                kind: r.get(5)?,
                agent_id: r.get(6)?,
                program: r.get(7)?,
                args: serde_json::from_str(&args_json).unwrap_or_default(),
                cwd: r.get(9)?,
                resume: resume_json.and_then(|s| serde_json::from_str(&s).ok()),
                sort: r.get(11)?,
                alive: r.get::<_, i64>(12)? != 0,
                created_at: r.get(13)?,
                pinned: r.get::<_, i64>(14)? != 0,
            })
        })?;
        for t in rows {
            snap.terminals.push(t?);
        }
    }

    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, color TEXT, icon TEXT, sort INTEGER, created_at INTEGER);
             CREATE TABLE groups (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, layout_json TEXT, suspended INTEGER, sort INTEGER);
             CREATE TABLE terminals (id TEXT PRIMARY KEY, group_id TEXT, slot INTEGER, surface TEXT, title TEXT, kind TEXT, agent_id TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER, created_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        conn
    }

    fn snap(rev: i64, project_name: &str) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            rev,
            projects: vec![Project {
                id: "p1".into(),
                name: project_name.into(),
                path: "C:/x".into(),
                color: None,
                icon: None,
                sort: 0,
                created_at: 0,
            }],
            groups: vec![],
            terminals: vec![],
        }
    }

    fn a_terminal(id: &str, surface: &str) -> Terminal {
        Terminal {
            id: id.into(),
            group_id: "g1".into(),
            slot: 0,
            surface: Some(surface.into()),
            title: None,
            kind: "shell".into(),
            agent_id: None,
            program: "pwsh".into(),
            args: vec![],
            cwd: "C:/x".into(),
            resume: None,
            sort: 0,
            alive: false,
            created_at: 0,
            pinned: false,
        }
    }

    /// The pin is the one thing about a CLI tab that only matters *between*
    /// sessions: a tab you kept at the front of the bar and out of "fechar as
    /// outras" is worth nothing if the next boot forgets it.
    #[test]
    fn a_pinned_terminal_comes_back_pinned() {
        let mut conn = mem_db();
        let mut snapshot = snap(0, "p");
        snapshot.groups = vec![Group {
            id: "g1".into(),
            project_id: Some("p1".into()),
            name: "g".into(),
            layout_json: "{}".into(),
            suspended: false,
            sort: 0,
        }];
        let mut fixed = a_terminal("fixa", "grid");
        fixed.pinned = true;
        snapshot.terminals = vec![fixed, a_terminal("solta", "grid")];

        save(&mut conn, &snapshot).unwrap();
        let back = load(&conn).unwrap();

        let pinned_of = |id: &str| {
            back.terminals
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.pinned)
                .unwrap()
        };
        assert!(pinned_of("fixa"));
        assert!(!pinned_of("solta"));
    }

    /// The regression this locks down: the canvas and the pane grid stopped
    /// sharing their CLIs, so which of the two a terminal belongs to is the
    /// only thing that decides whether it is ever drawn again. Dropping it on
    /// the way to disk turned every card back into a tab on the next boot.
    #[test]
    fn the_surface_of_each_terminal_survives_the_round_trip() {
        let mut conn = mem_db();
        let mut snapshot = snap(0, "p");
        snapshot.groups = vec![Group {
            id: "g1".into(),
            project_id: Some("p1".into()),
            name: "g".into(),
            layout_json: "{}".into(),
            suspended: false,
            sort: 0,
        }];
        snapshot.terminals = vec![a_terminal("card", "canvas"), a_terminal("tab", "grid")];

        assert!(save(&mut conn, &snapshot).unwrap().accepted);

        let loaded = load(&conn).unwrap();
        let surface_of = |id: &str| {
            loaded
                .terminals
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.surface.clone())
                .unwrap()
        };
        assert_eq!(surface_of("card").as_deref(), Some("canvas"));
        assert_eq!(surface_of("tab").as_deref(), Some("grid"));
    }

    /// A row that predates the split carries no surface, and this layer does
    /// not invent one: which of the two it belongs to depends on the group's
    /// `layout_json`, which is parsed in the front end. Guessing here would
    /// stamp the row and stop `stampSurfaces` from ever looking at it.
    #[test]
    fn a_terminal_with_no_surface_stays_undecided_through_the_round_trip() {
        let sent: Terminal = serde_json::from_str(
            r#"{"id":"t1","groupId":"g1","program":"pwsh","cwd":"C:/x"}"#,
        )
        .unwrap();
        assert_eq!(sent.surface, None);

        let mut conn = mem_db();
        let mut snapshot = snap(0, "p");
        snapshot.groups = vec![Group {
            id: "g1".into(),
            project_id: Some("p1".into()),
            name: "g".into(),
            layout_json: "{}".into(),
            suspended: false,
            sort: 0,
        }];
        snapshot.terminals = vec![sent];
        assert!(save(&mut conn, &snapshot).unwrap().accepted);

        assert_eq!(load(&conn).unwrap().terminals[0].surface, None);
    }

    /// A board is a group with no project: the canvas as its own container,
    /// holding cards from several projects at once. If this layer coerced the
    /// absent project into something (an empty string, the first project), the
    /// board would come back owned by a project it never belonged to.
    #[test]
    fn a_board_round_trips_as_a_group_with_no_project() {
        let mut conn = mem_db();
        let mut snapshot = snap(0, "p");
        snapshot.groups = vec![
            Group {
                id: "g1".into(),
                project_id: Some("p1".into()),
                name: "Principal".into(),
                layout_json: "{}".into(),
                suspended: false,
                sort: 0,
            },
            Group {
                id: "b1".into(),
                project_id: None,
                name: "Refatoracao do PTY".into(),
                layout_json: r#"{"surface":"canvas"}"#.into(),
                suspended: false,
                sort: 1,
            },
        ];

        assert!(save(&mut conn, &snapshot).unwrap().accepted);

        let loaded = load(&conn).unwrap();
        let project_of = |id: &str| {
            loaded
                .groups
                .iter()
                .find(|g| g.id == id)
                .map(|g| g.project_id.clone())
                .unwrap()
        };
        assert_eq!(project_of("g1").as_deref(), Some("p1"));
        assert_eq!(project_of("b1"), None);
    }

    /// A front end that predates boards sends every group with a project.
    #[test]
    fn a_group_sent_without_a_project_is_a_board_not_an_error() {
        let sent: Group =
            serde_json::from_str(r#"{"id":"b1","name":"Quadro","layoutJson":"{}"}"#).unwrap();
        assert_eq!(sent.project_id, None);
    }

    #[test]
    fn stale_revision_is_rejected_without_erasing_the_new_state() {
        let mut conn = mem_db();
        let r1 = save(&mut conn, &snap(0, "novo")).unwrap();
        assert!(r1.accepted);
        assert_eq!(r1.rev, 1);

        // Stale UI tries to write with rev 0 again.
        let r2 = save(&mut conn, &snap(0, "antigo")).unwrap();
        assert!(!r2.accepted);
        assert_eq!(r2.rev, 1);

        let loaded = load(&conn).unwrap();
        assert_eq!(loaded.projects[0].name, "novo");
    }

    #[test]
    fn current_revision_is_accepted_and_increments() {
        let mut conn = mem_db();
        save(&mut conn, &snap(0, "a")).unwrap();
        let r = save(&mut conn, &snap(1, "b")).unwrap();
        assert!(r.accepted);
        assert_eq!(r.rev, 2);
        assert_eq!(load(&conn).unwrap().projects[0].name, "b");
    }
}
