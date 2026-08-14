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
    pub project_id: String,
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
            recebida = snap.rev,
            atual = current,
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
            "INSERT INTO terminals(id, group_id, slot, title, kind, agent_id, program,
                                   args_json, cwd, resume_json, sort, alive, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                t.title,
                t.kind,
                t.agent_id,
                t.program,
                args,
                t.cwd,
                resume,
                t.sort,
                t.alive as i64,
                t.created_at
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
            "SELECT id, group_id, slot, title, kind, agent_id, program, args_json, cwd,
                    resume_json, sort, alive, created_at
             FROM terminals ORDER BY sort",
        )?;
        let rows = stmt.query_map([], |r| {
            let args_json: String = r.get(7)?;
            let resume_json: Option<String> = r.get(9)?;
            Ok(Terminal {
                id: r.get(0)?,
                group_id: r.get(1)?,
                slot: r.get(2)?,
                title: r.get(3)?,
                kind: r.get(4)?,
                agent_id: r.get(5)?,
                program: r.get(6)?,
                args: serde_json::from_str(&args_json).unwrap_or_default(),
                cwd: r.get(8)?,
                resume: resume_json.and_then(|s| serde_json::from_str(&s).ok()),
                sort: r.get(10)?,
                alive: r.get::<_, i64>(11)? != 0,
                created_at: r.get(12)?,
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
             CREATE TABLE terminals (id TEXT PRIMARY KEY, group_id TEXT, slot INTEGER, title TEXT, kind TEXT, agent_id TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER, created_at INTEGER);",
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

    #[test]
    fn revisao_atrasada_e_recusada_sem_apagar_o_estado_novo() {
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
    fn revisao_atual_e_aceita_e_incrementa() {
        let mut conn = mem_db();
        save(&mut conn, &snap(0, "a")).unwrap();
        let r = save(&mut conn, &snap(1, "b")).unwrap();
        assert!(r.accepted);
        assert_eq!(r.rev, 2);
        assert_eq!(load(&conn).unwrap().projects[0].name, "b");
    }
}
