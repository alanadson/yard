//! Workspace snapshot/restore, with a **monotonic revision guard**.
//!
//! The scenario this prevents: the UI reloads (HMR, WebView crash) holding
//! an old state in memory, an autosave fires, and the new state — with the
//! terminals you just opened — is overwritten by the old one. Every write
//! carries a revision; the backend **rejects** any that is smaller than the current.

use std::collections::HashSet;

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

/// Writes the snapshot in a transaction. Rejects stale revisions.
///
/// The three tables end up holding exactly the snapshot, in snapshot order,
/// as they did when every save deleted every row and inserted them all again.
/// That rewrite ran on each autosave (600 ms after any change), every group's
/// `layout_json` included, to record one renamed tab. Now only the rows that
/// differ are written (`save_in_place`); whatever that path cannot vouch for
/// still goes through the rewrite (`rewrite`), and gets its answer.
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
    if in_place_matches_rewrite(&tx, snap)? {
        save_in_place(&tx, snap)?;
    } else {
        rewrite(&tx, snap)?;
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

/// A table a save writes, with every column it writes, id first. The SQL
/// below is built from these lists, so an upsert can never set a column it
/// forgot to compare.
type Table = (&'static str, &'static [&'static str]);

const PROJECTS: Table = (
    "projects",
    &["id", "name", "path", "color", "icon", "sort", "created_at"],
);
const GROUPS: Table = (
    "groups",
    &["id", "project_id", "name", "layout_json", "suspended", "sort"],
);
const TERMINALS: Table = (
    "terminals",
    &[
        "id",
        "group_id",
        "slot",
        "surface",
        "title",
        "kind",
        "agent_id",
        "program",
        "args_json",
        "cwd",
        "resume_json",
        "sort",
        "alive",
        "created_at",
        "pinned",
    ],
);

/// The one way the old save ever wrote: every row out, every row back in.
/// Kept for the snapshots and databases `in_place_matches_rewrite` turns
/// away, so they get exactly the tables, and the error, they always got.
fn rewrite(tx: &Connection, snap: &WorkspaceSnapshot) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM terminals", [])?;
    tx.execute("DELETE FROM groups", [])?;
    tx.execute("DELETE FROM projects", [])?;
    write_projects(tx, &insert_sql(PROJECTS), &snap.projects)?;
    write_groups(tx, &insert_sql(GROUPS), &snap.groups)?;
    write_terminals(tx, &insert_sql(TERMINALS), &snap.terminals)
}

/// Writes only what differs, and leaves the tables the rewrite would leave.
///
/// Rows the snapshot dropped go first, children before parents: the cascades
/// take the children of a dropped parent along, as the rewrite's deletes did,
/// and a child that moved out of it in this same snapshot is written back
/// below. Then every table, parents before children, so each foreign key
/// finds its parent: an upsert that skips a row equal to the snapshot's.
///
/// The row **order** is the part an upsert can break. The rewrite left each
/// table in snapshot order, and that is the order `load` returns rows that
/// tie on `sort` in. A kept row keeps its place and a new one goes last, so
/// the order holds only when the rows already there are the snapshot's first
/// ones, in the same order; otherwise that table alone is rewritten.
fn save_in_place(tx: &Connection, snap: &WorkspaceSnapshot) -> rusqlite::Result<()> {
    let project_ids: Vec<&str> = snap.projects.iter().map(|p| p.id.as_str()).collect();
    let group_ids: Vec<&str> = snap.groups.iter().map(|g| g.id.as_str()).collect();
    let terminal_ids: Vec<&str> = snap.terminals.iter().map(|t| t.id.as_str()).collect();

    delete_missing(tx, TERMINALS.0, &terminal_ids)?;
    delete_missing(tx, GROUPS.0, &group_ids)?;
    delete_missing(tx, PROJECTS.0, &project_ids)?;

    let sql = write_sql(tx, PROJECTS, &project_ids)?;
    write_projects(tx, &sql, &snap.projects)?;
    let sql = write_sql(tx, GROUPS, &group_ids)?;
    write_groups(tx, &sql, &snap.groups)?;
    let sql = write_sql(tx, TERMINALS, &terminal_ids)?;
    write_terminals(tx, &sql, &snap.terminals)
}

/// Whether `save_in_place` is guaranteed to leave what `rewrite` leaves.
///
/// The snapshot first. A repeated id failed the rewrite on the primary key,
/// where an upsert would quietly merge it; a row whose parent is not in the
/// snapshot failed it on the foreign key, where a parent still on disk would
/// satisfy it in place. Both keep the rewrite, and its error.
///
/// Then the tables, which another build may have touched (see
/// `db::ensure_added_columns`): exactly the columns written here, since a
/// column this code does not know kept its value in place where the rewrite
/// reset it to its default; ordinary rowid tables, since the order argument
/// in `save_in_place` is about rowids; no trigger, which would see updates
/// where it used to see deletes and inserts; no unique index besides the id,
/// which a row-by-row upsert could trip over on a row the rewrite had already
/// deleted; and no foreign key touching these tables but the two cascades,
/// since any other reference lost its rows to the rewrite's deletes.
fn in_place_matches_rewrite(tx: &Connection, snap: &WorkspaceSnapshot) -> rusqlite::Result<bool> {
    fn unique<'a>(mut ids: impl Iterator<Item = &'a str>) -> Option<HashSet<&'a str>> {
        let mut seen = HashSet::new();
        ids.all(|id| seen.insert(id)).then_some(seen)
    }
    let Some(projects) = unique(snap.projects.iter().map(|p| p.id.as_str())) else {
        return Ok(false);
    };
    let Some(groups) = unique(snap.groups.iter().map(|g| g.id.as_str())) else {
        return Ok(false);
    };
    if unique(snap.terminals.iter().map(|t| t.id.as_str())).is_none() {
        return Ok(false);
    }
    let orphan_group = snap
        .groups
        .iter()
        .any(|g| g.project_id.as_deref().is_some_and(|p| !projects.contains(p)));
    let orphan_terminal = snap
        .terminals
        .iter()
        .any(|t| !groups.contains(t.group_id.as_str()));
    if orphan_group || orphan_terminal {
        return Ok(false);
    }

    for (table, columns) in [PROJECTS, GROUPS, TERMINALS] {
        let mut on_disk: Vec<String> = tx
            .prepare_cached("SELECT name FROM pragma_table_info(?1)")?
            .query_map([table], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        on_disk.sort();
        let mut known = columns.to_vec();
        known.sort();
        if on_disk != known {
            return Ok(false);
        }
        let odd: i64 = tx
            .prepare_cached(
                r#"SELECT (SELECT COUNT(*) FROM pragma_table_list
                            WHERE schema = 'main' AND name = ?1 AND wr)
                        + (SELECT COUNT(*) FROM sqlite_master
                            WHERE type = 'trigger' AND tbl_name = ?1)
                        + (SELECT COUNT(*) FROM pragma_index_list(?1)
                            WHERE "unique" AND origin <> 'pk')"#,
            )?
            .query_row([table], |r| r.get(0))?;
        if odd != 0 {
            return Ok(false);
        }
    }

    let written = [PROJECTS.0, GROUPS.0, TERMINALS.0];
    let mut stmt = tx.prepare_cached(
        r#"SELECT m.name, f."from", f."table", f."to", f.on_delete
           FROM sqlite_master m, pragma_foreign_key_list(m.name) f
           WHERE m.type = 'table'"#,
    )?;
    let mut keys = stmt.query([])?;
    while let Some(key) = keys.next()? {
        let child: String = key.get(0)?;
        let from: String = key.get(1)?;
        let parent: String = key.get(2)?;
        let to: Option<String> = key.get(3)?;
        let on_delete: String = key.get(4)?;
        if !written.contains(&child.as_str()) && !written.contains(&parent.as_str()) {
            continue;
        }
        let link = (child.as_str(), from.as_str(), parent.as_str());
        let expected = matches!(
            link,
            ("groups", "project_id", "projects") | ("terminals", "group_id", "groups")
        );
        // A reference without a column names the parent's primary key.
        let to_the_id = to.as_deref().is_none_or(|c| c == "id");
        if !(expected && to_the_id && on_delete == "CASCADE") {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Deletes the rows of `table` whose id the snapshot no longer has.
fn delete_missing(tx: &Connection, table: &str, keep: &[&str]) -> rusqlite::Result<()> {
    let keep: HashSet<&str> = keep.iter().copied().collect();
    let on_disk: Vec<String> = tx
        .prepare_cached(&format!("SELECT id FROM {table}"))?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut delete = tx.prepare_cached(&format!("DELETE FROM {table} WHERE id = ?1"))?;
    for id in on_disk.iter().filter(|id| !keep.contains(id.as_str())) {
        delete.execute([id])?;
    }
    Ok(())
}

/// The statement that writes `table` in snapshot order: the upsert when the
/// rows already there are the snapshot's first ones in the same order (a kept
/// row keeps its place, new ones go last), or else the plain insert after
/// emptying the table, which is what the rewrite did to it.
fn write_sql(tx: &Connection, (table, columns): Table, ids: &[&str]) -> rusqlite::Result<String> {
    let on_disk: Vec<String> = tx
        .prepare_cached(&format!("SELECT id FROM {table} ORDER BY rowid"))?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let in_order = on_disk.len() <= ids.len()
        && on_disk.iter().zip(ids).all(|(have, want)| have == want);
    if in_order {
        return Ok(upsert_sql((table, columns)));
    }
    tx.execute(&format!("DELETE FROM {table}"), [])?;
    Ok(insert_sql((table, columns)))
}

fn insert_sql((table, columns): Table) -> String {
    let marks: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
    format!(
        "INSERT INTO {table}({}) VALUES ({})",
        columns.join(", "),
        marks.join(", ")
    )
}

/// The insert, plus: on an id already there, update it, but only if some
/// column differs. `IS NOT`, so that NULL compares equal to NULL.
fn upsert_sql((table, columns): Table) -> String {
    let rest = &columns[1..];
    let set: Vec<String> = rest.iter().map(|c| format!("{c} = excluded.{c}")).collect();
    let differs: Vec<String> = rest
        .iter()
        .map(|c| format!("{table}.{c} IS NOT excluded.{c}"))
        .collect();
    format!(
        "{} ON CONFLICT(id) DO UPDATE SET {} WHERE {}",
        insert_sql((table, columns)),
        set.join(", "),
        differs.join(" OR ")
    )
}

fn write_projects(tx: &Connection, sql: &str, rows: &[Project]) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(sql)?;
    for p in rows {
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
    Ok(())
}

fn write_groups(tx: &Connection, sql: &str, rows: &[Group]) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(sql)?;
    for g in rows {
        stmt.execute(rusqlite::params![
            g.id,
            g.project_id,
            g.name,
            g.layout_json,
            g.suspended as i64,
            g.sort
        ])?;
    }
    Ok(())
}

fn write_terminals(tx: &Connection, sql: &str, rows: &[Terminal]) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(sql)?;
    for t in rows {
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
    Ok(())
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

    // --- Saving in place, held to the rewrite it replaced ------------------
    //
    // `save` used to delete every project, group and terminal and insert them
    // all again, each group's `layout_json` included, on every autosave. It
    // now writes only what changed. The old algorithm is kept below, verbatim,
    // as an oracle: every table of the real schema (foreign keys and cascades
    // on) must come out of both identical, row for row and in scan order,
    // because the order of rows that tie on `sort` is the order `load` hands
    // them back in.

    use rusqlite::types::Value;

    /// The old `save`, verbatim: delete everything, insert everything.
    fn save_by_rewrite(
        conn: &mut Connection,
        snap: &WorkspaceSnapshot,
    ) -> anyhow::Result<SaveResult> {
        let current = current_rev(conn);
        if snap.rev < current {
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

    /// The schema the app really runs on, with rows in the tables a workspace
    /// save must never touch.
    fn real_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        db::migrate(&c).unwrap();
        c.execute_batch(
            "INSERT INTO kv(key, value) VALUES ('theme', 'dark');
             INSERT INTO agent_sessions(id, agent, project_path, external_id, updated_at)
               VALUES ('s1', 'claude', 'C:/yard', 'ext-1', 5);
             INSERT INTO notebooks(id, name) VALUES ('nb1', 'Caderno');
             INSERT INTO notes(id, title, notebook_id) VALUES ('n1', 'Nota', 'nb1');",
        )
        .unwrap();
        c
    }

    fn rows_of(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| (0..n).map(|i| r.get::<_, Value>(i)).collect())
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// Every table and the schema itself, every column, in scan order. The
    /// rowid values are left out on purpose: nothing reads them, and a row
    /// kept in place keeps the one it had.
    fn dump(conn: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
        let mut out = vec![(
            "sqlite_master".to_string(),
            rows_of(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"),
        )];
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for t in tables {
            // A table without rowids scans in primary key order.
            let without_rowid: bool = conn
                .query_row("SELECT wr FROM pragma_table_list WHERE name = ?1", [&t], |r| {
                    r.get(0)
                })
                .unwrap();
            let order = if without_rowid { "" } else { " ORDER BY rowid" };
            let rows = rows_of(conn, &format!("SELECT * FROM {t}{order}"));
            out.push((t, rows));
        }
        out
    }

    fn outcome(r: &anyhow::Result<SaveResult>) -> Result<(i64, bool), String> {
        r.as_ref().map(|s| (s.rev, s.accepted)).map_err(|e| e.to_string())
    }

    fn project(id: &str, name: &str, sort: i64) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            path: format!("C:/{name}"),
            color: None,
            icon: None,
            sort,
            created_at: 10,
        }
    }

    fn group(id: &str, project: Option<&str>, sort: i64) -> Group {
        Group {
            id: id.into(),
            project_id: project.map(Into::into),
            name: format!("grupo {id}"),
            layout_json: format!(r#"{{"surface":"canvas","cards":["{id}"]}}"#),
            suspended: false,
            sort,
        }
    }

    fn terminal(id: &str, group: &str, sort: i64) -> Terminal {
        Terminal {
            group_id: group.into(),
            sort,
            ..a_terminal(id, "grid")
        }
    }

    /// Two projects and a board; terminals whose `sort` ties across groups,
    /// and every optional field of a terminal filled somewhere.
    fn workspace() -> WorkspaceSnapshot {
        let mut agent = terminal("t2", "g1", 1);
        agent.kind = "agent".into();
        agent.agent_id = Some("claude".into());
        agent.title = Some("Claude Code".into());
        agent.args = vec!["--model".into(), "opus".into()];
        agent.resume = Some(vec!["--resume".into(), "abc".into()]);
        agent.alive = true;
        let mut card = terminal("t5", "b1", 0);
        card.surface = Some("canvas".into());
        card.pinned = true;
        WorkspaceSnapshot {
            rev: 0,
            projects: vec![project("p1", "yard", 0), project("p2", "crm", 1)],
            groups: vec![
                group("g1", Some("p1"), 0),
                group("g2", Some("p1"), 1),
                group("g3", Some("p2"), 0),
                group("b1", None, 2),
            ],
            terminals: vec![
                terminal("t1", "g1", 0),
                agent,
                terminal("t3", "g2", 0),
                terminal("t4", "g3", 0),
                card,
                terminal("t6", "g1", 2),
            ],
        }
    }

    /// `base` at `rev`, with one change applied.
    fn changed(
        base: &WorkspaceSnapshot,
        rev: i64,
        change: impl FnOnce(&mut WorkspaceSnapshot),
    ) -> WorkspaceSnapshot {
        let mut next = base.clone();
        next.rev = rev;
        change(&mut next);
        next
    }

    enum Step {
        Save(WorkspaceSnapshot),
        /// Raw SQL run on both databases, for a state no snapshot produces.
        Sql(&'static str),
    }

    /// Runs the same steps on two identical databases, one saved by the
    /// rewrite and one by `save`, and demands the same answer, the same
    /// tables and the same `load` after every step. Returns the answers to
    /// the saves, so a test can also say which ones it expected to fail.
    fn assert_same_as_rewrite(steps: Vec<Step>) -> Vec<Result<(i64, bool), String>> {
        let mut by_rewrite = real_db();
        let mut in_place = real_db();
        let mut answers = Vec::new();
        for (i, step) in steps.into_iter().enumerate() {
            match step {
                Step::Sql(sql) => {
                    by_rewrite.execute_batch(sql).unwrap();
                    in_place.execute_batch(sql).unwrap();
                }
                Step::Save(snap) => {
                    let expected = save_by_rewrite(&mut by_rewrite, &snap);
                    let got = save(&mut in_place, &snap);
                    assert_eq!(outcome(&got), outcome(&expected), "step {i}: same answer");
                    answers.push(outcome(&expected));
                }
            }
            assert_eq!(dump(&in_place), dump(&by_rewrite), "step {i}: same tables");
            assert_eq!(
                format!("{:?}", load(&in_place).unwrap()),
                format!("{:?}", load(&by_rewrite).unwrap()),
                "step {i}: same load"
            );
        }
        answers
    }

    #[test]
    fn an_unchanged_workspace_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |_| {})),
            Step::Save(changed(&base, 2, |_| {})),
        ]);
    }

    #[test]
    fn one_changed_field_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals[1].title = Some("Renomeada".into()))),
            Step::Save(changed(&base, 2, |s| s.groups[0].layout_json = r#"{"surface":"grid"}"#.into())),
            Step::Save(changed(&base, 3, |s| s.projects[1].color = Some("#ff0000".into()))),
            Step::Save(changed(&base, 4, |s| s.terminals[1].resume = None)),
            Step::Save(changed(&base, 5, |s| s.terminals[4].pinned = false)),
            Step::Save(changed(&base, 6, |s| s.groups[3].suspended = true)),
            Step::Save(changed(&base, 7, |s| s.terminals[0].surface = None)),
        ]);
    }

    #[test]
    fn a_terminal_added_at_the_end_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals.push(terminal("t7", "g2", 1)))),
        ]);
    }

    /// A new row that does not go last in the snapshot: kept in place, it
    /// would scan after rows the snapshot put after it, and ties on `sort`
    /// would come back from `load` in a different order.
    #[test]
    fn a_terminal_added_in_the_middle_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals.insert(1, terminal("t7", "g1", 0)))),
            Step::Save(changed(&base, 2, |s| s.groups.insert(0, group("g0", Some("p2"), 0)))),
            Step::Save(changed(&base, 3, |s| s.projects.insert(0, project("p0", "novo", 0)))),
        ]);
    }

    #[test]
    fn a_terminal_removed_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| {
                s.terminals.retain(|t| t.id != "t3");
            })),
        ]);
    }

    #[test]
    fn a_group_removed_with_its_terminals_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| {
                s.groups.retain(|g| g.id != "g1");
                s.terminals.retain(|t| t.group_id != "g1");
            })),
        ]);
    }

    #[test]
    fn a_project_removed_with_its_groups_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| {
                s.projects.retain(|p| p.id != "p1");
                s.groups.retain(|g| g.project_id.as_deref() != Some("p1"));
                s.terminals.retain(|t| !["g1", "g2"].contains(&t.group_id.as_str()));
            })),
        ]);
    }

    #[test]
    fn a_reorder_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals.reverse())),
            Step::Save(changed(&base, 2, |s| s.groups.swap(0, 3))),
            Step::Save(changed(&base, 3, |s| {
                s.projects.reverse();
                s.projects[0].sort = 0;
                s.projects[1].sort = 1;
            })),
            Step::Save(changed(&base, 4, |s| s.terminals.rotate_left(2))),
        ]);
    }

    #[test]
    fn a_group_moved_between_projects_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.groups[1].project_id = Some("p2".into()))),
            Step::Save(changed(&base, 2, |s| s.groups[1].project_id = None)),
            Step::Save(changed(&base, 3, |_| {})),
        ]);
    }

    /// The case the cascades make interesting: the project goes away while one
    /// of its groups moves to another project. The rewrite drops it with the
    /// project and inserts it back; so must the in-place save.
    #[test]
    fn a_group_rescued_from_a_removed_project_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| {
                s.projects.retain(|p| p.id != "p1");
                s.groups.retain(|g| g.id != "g1");
                s.groups.iter_mut().for_each(|g| {
                    if g.id == "g2" {
                        g.project_id = Some("p2".into());
                    }
                });
                s.terminals.retain(|t| t.group_id != "g1");
            })),
        ]);
    }

    #[test]
    fn a_terminal_moved_between_groups_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals[1].group_id = "g3".into())),
            Step::Save(changed(&base, 2, |s| {
                // Out of a group that disappears in the same save.
                s.terminals[2].group_id = "g1".into();
                s.groups.retain(|g| g.id != "g2");
            })),
        ]);
    }

    #[test]
    fn closing_everything_saves_to_the_same_tables_as_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(WorkspaceSnapshot {
                rev: 1,
                projects: vec![],
                groups: vec![],
                terminals: vec![],
            }),
            Step::Save(changed(&base, 2, |_| {})),
        ]);
    }

    #[test]
    fn a_stale_revision_is_refused_by_both_and_touches_nothing() {
        let base = workspace();
        let answers = assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals.clear())),
            Step::Save(changed(&base, 0, |s| s.projects.clear())),
        ]);
        assert_eq!(answers[2], Ok((2, false)));
    }

    /// A snapshot the database refuses must be refused the same way: the
    /// rewrite hit the primary key on a repeated id, which an upsert would
    /// have quietly merged, and the foreign key on a row whose parent is not
    /// in the snapshot, which rows already on disk could have satisfied.
    #[test]
    fn a_snapshot_the_rewrite_refused_is_refused_with_the_same_error() {
        let base = workspace();
        let answers = assert_same_as_rewrite(vec![
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| {
                let twin = s.terminals[0].clone();
                s.terminals.push(twin);
            })),
            Step::Save(changed(&base, 1, |s| {
                let twin = s.groups[2].clone();
                s.groups.push(twin);
            })),
            Step::Save(changed(&base, 1, |s| {
                let mut twin = s.projects[0].clone();
                twin.name = "outro".into();
                s.projects.push(twin);
            })),
            // The group is still on disk, but no longer in the snapshot.
            Step::Save(changed(&base, 1, |s| s.groups.retain(|g| g.id != "g2"))),
            // The project is still on disk, but no longer in the snapshot.
            Step::Save(changed(&base, 1, |s| s.projects.retain(|p| p.id != "p2"))),
            Step::Save(changed(&base, 1, |s| s.terminals[0].group_id = "nenhum".into())),
            // And after all the refusals, a good save still lands.
            Step::Save(changed(&base, 1, |s| s.terminals[0].title = Some("ok".into()))),
        ]);
        for (i, answer) in answers.iter().enumerate().take(7).skip(1) {
            assert!(answer.is_err(), "save {i} must be refused: {answer:?}");
        }
        assert_eq!(answers[7], Ok((2, true)));
    }

    /// The real-world case from `db::ensure_added_columns`: a build from
    /// another branch left a column this code does not write. The rewrite put
    /// every row back with that column at its default; keeping the row in
    /// place would have kept the stale value.
    #[test]
    fn a_column_this_code_does_not_know_is_reset_as_the_rewrite_reset_it() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Sql("ALTER TABLE terminals ADD COLUMN chat INTEGER NOT NULL DEFAULT 0"),
            Step::Save(base.clone()),
            Step::Sql("UPDATE terminals SET chat = 1"),
            Step::Save(changed(&base, 1, |_| {})),
        ]);
    }

    /// No table references a terminal, group or project today; the day one
    /// does (a role or a routine keyed by terminal id, say) with a cascade,
    /// the rewrite's deletes took its rows on every save, and saving in place
    /// must not quietly start keeping them.
    #[test]
    fn a_table_referencing_the_workspace_loses_its_rows_as_it_did_to_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Sql(
                "CREATE TABLE roles (
                   terminal_id TEXT REFERENCES terminals(id) ON DELETE CASCADE,
                   role TEXT
                 )",
            ),
            Step::Save(base.clone()),
            Step::Sql("INSERT INTO roles VALUES ('t1', 'revisor'), ('t4', 'testes')"),
            Step::Save(changed(&base, 1, |_| {})),
        ]);
    }

    /// A trigger saw every row deleted and inserted again on each save.
    #[test]
    fn a_trigger_on_the_workspace_sees_what_it_saw_under_the_rewrite() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Sql(
                "CREATE TABLE seen (what TEXT);
                 CREATE TRIGGER seen_insert AFTER INSERT ON terminals
                 BEGIN INSERT INTO seen VALUES ('insert ' || NEW.id); END;",
            ),
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals[0].title = Some("x".into()))),
        ]);
    }

    /// With a unique index besides the id, swapping two values is fine when
    /// every row is deleted first, and a collision when rows change one by one.
    #[test]
    fn a_unique_index_besides_the_id_gets_the_rewrite_it_always_got() {
        let base = workspace();
        let answers = assert_same_as_rewrite(vec![
            Step::Sql("CREATE UNIQUE INDEX one_project_per_path ON projects(path)"),
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| {
                let first = s.projects[0].path.clone();
                s.projects[0].path = s.projects[1].path.clone();
                s.projects[1].path = first;
            })),
        ]);
        assert_eq!(answers[1], Ok((2, true)));
    }

    /// Scan order is rowid order only in a rowid table; one rebuilt without
    /// rowids scans by id, and the rewrite is the only path that knew nothing
    /// about rowids.
    #[test]
    fn a_table_without_rowids_gets_the_rewrite_it_always_got() {
        let base = workspace();
        assert_same_as_rewrite(vec![
            Step::Sql(
                "DROP TABLE terminals;
                 CREATE TABLE terminals (
                   id TEXT PRIMARY KEY,
                   group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                   slot INTEGER NOT NULL DEFAULT 0, surface TEXT, title TEXT,
                   kind TEXT NOT NULL DEFAULT 'shell', agent_id TEXT,
                   program TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '[]',
                   cwd TEXT NOT NULL, resume_json TEXT,
                   sort INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
                 ) WITHOUT ROWID;",
            ),
            Step::Save(base.clone()),
            Step::Save(changed(&base, 1, |s| s.terminals.push(terminal("a0", "g1", 3)))),
        ]);
    }

    /// A session's worth of autosaves, one after another on the same tables.
    #[test]
    fn a_session_of_saves_ends_in_the_same_tables_as_the_rewrite() {
        let base = workspace();
        let mut steps = vec![Step::Save(base.clone())];
        let mut cur = base;
        let edits: Vec<fn(&mut WorkspaceSnapshot)> = vec![
            |s| s.terminals.push(terminal("t7", "g1", 3)),
            |s| s.terminals[0].title = Some("dev".into()),
            |s| s.groups[0].layout_json = r#"{"cards":["t1","t7"]}"#.into(),
            |s| s.terminals.retain(|t| t.id != "t2"),
            |s| s.groups.push(group("g4", Some("p2"), 1)),
            |s| s.terminals.push(terminal("t8", "g4", 0)),
            |s| s.terminals.iter_mut().for_each(|t| t.alive = false),
            |s| s.projects.push(project("p3", "site", 2)),
            |s| s.terminals.swap(0, 1),
            |_| {},
        ];
        for (i, edit) in edits.iter().enumerate() {
            cur.rev = i as i64 + 1;
            edit(&mut cur);
            steps.push(Step::Save(cur.clone()));
        }
        assert_same_as_rewrite(steps);
    }

    /// What saving in place is for. The autosave fires 600 ms after every
    /// change, and rewriting every row (each group's `layout_json` among them)
    /// to record one renamed tab was nearly all of its cost. A row that did
    /// not change is not written at all: here only the revision is.
    #[test]
    fn saving_an_unchanged_workspace_writes_only_the_revision() {
        let mut conn = real_db();
        save(&mut conn, &workspace()).unwrap();
        let before = conn.total_changes();
        save(&mut conn, &changed(&workspace(), 1, |_| {})).unwrap();
        assert_eq!(conn.total_changes() - before, 1);
    }

    #[test]
    fn a_renamed_tab_writes_its_own_row_and_the_revision_only() {
        let mut conn = real_db();
        save(&mut conn, &workspace()).unwrap();
        let before = conn.total_changes();
        save(
            &mut conn,
            &changed(&workspace(), 1, |s| s.terminals[3].title = Some("build".into())),
        )
        .unwrap();
        assert_eq!(conn.total_changes() - before, 2);
    }

    #[test]
    fn a_new_tab_at_the_end_is_one_insert_and_the_revision() {
        let mut conn = real_db();
        save(&mut conn, &workspace()).unwrap();
        let before = conn.total_changes();
        save(
            &mut conn,
            &changed(&workspace(), 1, |s| s.terminals.push(terminal("t7", "g3", 1))),
        )
        .unwrap();
        assert_eq!(conn.total_changes() - before, 2);
    }

    #[test]
    fn a_closed_tab_is_one_delete_and_the_revision() {
        let mut conn = real_db();
        save(&mut conn, &workspace()).unwrap();
        let before = conn.total_changes();
        save(
            &mut conn,
            &changed(&workspace(), 1, |s| s.terminals.retain(|t| t.id != "t4")),
        )
        .unwrap();
        assert_eq!(conn.total_changes() - before, 2);
    }
}
