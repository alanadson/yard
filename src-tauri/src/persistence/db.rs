//! SQLite: opening, PRAGMAs, and versioned migrations (§4.4).
//!
//! WAL is enabled on purpose: Windows antivirus and indexers hold the
//! main file for moments, and in rollback mode that becomes "database is
//! locked" in the middle of an autosave (§9.10).

use rusqlite::{Connection, OptionalExtension};

/// Schema version. Every new migration increments this and gets a block in
/// `migrate`. Never rewrite a migration that has already shipped.
const SCHEMA_VERSION: i64 = 4;

pub fn open() -> anyhow::Result<Connection> {
    crate::paths::ensure_dirs()?;
    let path = crate::paths::db_path();
    let conn = Connection::open(&path)?;

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    migrate(&conn)?;
    tracing::info!(path = %path.display(), "sqlite pronto");
    Ok(conn)
}

fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

fn migrate(conn: &Connection) -> anyhow::Result<()> {
    quarantine_prototype(conn)?;

    let current = user_version(conn)?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    if current < 1 {
        conn.execute_batch(
            r#"
            BEGIN;

            CREATE TABLE IF NOT EXISTS kv (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
              id         TEXT PRIMARY KEY,
              name       TEXT NOT NULL,
              path       TEXT NOT NULL,
              color      TEXT,
              sort       INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS groups (
              id          TEXT PRIMARY KEY,
              project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              name        TEXT NOT NULL,
              layout_json TEXT NOT NULL DEFAULT '{}',
              suspended   INTEGER NOT NULL DEFAULT 0,
              sort        INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS terminals (
              id          TEXT PRIMARY KEY,
              group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
              slot        INTEGER NOT NULL DEFAULT 0,
              title       TEXT,
              kind        TEXT NOT NULL DEFAULT 'shell',
              agent_id    TEXT,
              program     TEXT NOT NULL,
              args_json   TEXT NOT NULL DEFAULT '[]',
              cwd         TEXT NOT NULL,
              resume_json TEXT,
              sort        INTEGER NOT NULL DEFAULT 0,
              alive       INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS agent_sessions (
              id           TEXT PRIMARY KEY,
              agent        TEXT NOT NULL,
              project_path TEXT NOT NULL,
              external_id  TEXT NOT NULL,
              title        TEXT,
              updated_at   INTEGER NOT NULL,
              cost_usd     REAL
            );

            CREATE INDEX IF NOT EXISTS idx_groups_project   ON groups(project_id);
            CREATE INDEX IF NOT EXISTS idx_terminals_group  ON terminals(group_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_project ON agent_sessions(project_path);

            PRAGMA user_version = 1;
            COMMIT;
            "#,
        )?;
        tracing::info!("migracao aplicada: schema v1");
    }

    if current < 2 {
        // `projects.color` was added to v1 *after* it had already
        // run on existing databases — and an applied migration does not run
        // again, so those databases were left without the column and every
        // `load_workspace` died with "no such column: color". A database created
        // by today's v1 already has it; hence the check before the ALTER.
        if !has_column(conn, "projects", "color")? {
            conn.execute("ALTER TABLE projects ADD COLUMN color TEXT", [])?;
        }
        conn.pragma_update(None, "user_version", 2)?;
        tracing::info!("migracao aplicada: schema v2");
    }

    if current < 3 {
        adopt_prototype_rows(conn)?;
        conn.pragma_update(None, "user_version", 3)?;
        tracing::info!("migracao aplicada: schema v3");
    }

    if current < 4 {
        // Project icon (picker from "New project"/"Customize…"). Same
        // defensive pattern as v2: v1 does not create the column, so every
        // database goes through this ALTER — the check avoids repeating it on
        // a database that already has it.
        if !has_column(conn, "projects", "icon")? {
            conn.execute("ALTER TABLE projects ADD COLUMN icon TEXT", [])?;
        }
        conn.pragma_update(None, "user_version", 4)?;
        tracing::info!("migracao aplicada: schema v4");
    }

    Ok(())
}

/// v3: returns to the workspace what the prototype quarantine took off stage.
///
/// The quarantine (below) renames the old tables to `*_prototipo` and
/// recreates the empty schema — correct for the schema, but the visible effect
/// was "my projects and CLIs disappeared". Here that data comes back into the
/// new tables: missing projects are readopted with their own id, projects the
/// user already re-registered (same `path`) receive the old groups/terminals
/// underneath. In the end the `*_prototipo` tables are dropped — the content
/// now lives in the real schema.
fn adopt_prototype_rows(conn: &Connection) -> anyhow::Result<()> {
    if !has_table(conn, "projects_prototipo")? {
        return Ok(());
    }
    tracing::info!("readotando dados do prototipo para o schema atual");

    // Columns added late may not exist in every prototype database;
    // if they are missing, NULL is used.
    let color = if has_column(conn, "projects_prototipo", "color")? {
        "p.color"
    } else {
        "NULL"
    };

    conn.execute_batch("BEGIN")?;
    let result: anyhow::Result<()> = (|| {
        // Projects: readopt by id the paths that were not registered again;
        // sort continues after the current ones so the sidebar is not shuffled.
        conn.execute(
            &format!(
                "INSERT OR IGNORE INTO projects(id, name, path, color, sort, created_at)
                 SELECT p.id, p.name, p.path, {color},
                        p.sort + (SELECT COALESCE(MAX(sort), -1) + 1 FROM projects),
                        p.created_at
                 FROM projects_prototipo p
                 WHERE p.path NOT IN (SELECT path FROM projects)
                   AND p.id  NOT IN (SELECT id FROM projects)"
            ),
            [],
        )?;

        if has_table(conn, "groups_prototipo")? {
            // Groups follow the owner: the old project_id is translated via
            // `path` to the live project (the readopted or the re-registered one).
            // The old layout had a different JSON format; '{}' lets the front
            // rebuild with today's defaults.
            conn.execute(
                "INSERT OR IGNORE INTO groups(id, project_id, name, layout_json, suspended, sort)
                 SELECT g.id, np.id, g.name, '{}', g.suspended,
                        g.sort + 100
                 FROM groups_prototipo g
                 JOIN projects_prototipo pp ON pp.id = g.project_id
                 JOIN projects np ON np.path = pp.path
                 WHERE g.id NOT IN (SELECT id FROM groups)",
                [],
            )?;
        }

        if has_table(conn, "terminals_prototipo")? {
            let resume = if has_column(conn, "terminals_prototipo", "resume_json")? {
                "t.resume_json"
            } else {
                "NULL"
            };
            // The prototype had neither `slot` nor `agent_id`: everything becomes
            // a tab of panel 0, which is today's default layout.
            conn.execute(
                &format!(
                    "INSERT OR IGNORE INTO terminals(id, group_id, slot, title, kind, agent_id,
                                           program, args_json, cwd, resume_json, sort,
                                           alive, created_at)
                     SELECT t.id, t.group_id, 0, t.title, t.kind, NULL,
                            t.program, t.args_json, t.cwd, {resume}, t.sort,
                            t.alive, 0
                     FROM terminals_prototipo t
                     WHERE t.group_id IN (SELECT id FROM groups)
                       AND t.id NOT IN (SELECT id FROM terminals)"
                ),
                [],
            )?;
        }

        for table in [
            "terminals_prototipo",
            "groups_prototipo",
            "projects_prototipo",
            "agent_sessions_prototipo",
        ] {
            conn.execute(&format!("DROP TABLE IF EXISTS {table}"), [])?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Gets the prototype schema (pre-v1) out of the way.
///
/// That design tracked version in a `schema_migrations` table and had
/// different columns — `terminals` without `slot`, `projects` without `color`.
/// Because v1 creates everything with `CREATE TABLE IF NOT EXISTS`, it
/// **adopted** those tables without touching them and still stamped
/// `user_version = 1`: no error on boot, and the first workspace `SELECT`
/// died with "no such column".
///
/// Here the old tables get a `_prototipo` suffix (nothing is deleted; the
/// data stays there for anyone who wants to mine it) and the version goes
/// back to zero, so the migrations build the schema the right way. `kv`
/// stays: its shape never changed and it is where preferences live.
fn quarantine_prototype(conn: &Connection) -> anyhow::Result<()> {
    if !has_table(conn, "schema_migrations")? {
        return Ok(());
    }
    tracing::warn!("banco do prototipo detectado: tabelas viram *_prototipo e o schema e refeito");

    // Index names are global in SQLite: if the old one survived, v1's
    // `CREATE INDEX IF NOT EXISTS` would find the name taken and the new
    // table would have no index at all.
    for idx in ["idx_groups_project", "idx_terminals_group", "idx_sessions_project"] {
        conn.execute(&format!("DROP INDEX IF EXISTS {idx}"), [])?;
    }
    for table in ["terminals", "groups", "projects", "agent_sessions"] {
        if has_table(conn, table)? {
            conn.execute(&format!("ALTER TABLE {table} RENAME TO {table}_prototipo"), [])?;
        }
    }
    conn.execute("DROP TABLE schema_migrations", [])?;
    conn.pragma_update(None, "user_version", 0)?;
    Ok(())
}

fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    // `PRAGMA` does not accept a bound parameter; `table` here is always a
    // literal from our own code, never user input.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c
    }

    /// Pure prototype database: quarantine + v1..v3 must readopt everything.
    #[test]
    fn v3_readota_projetos_e_terminais_do_prototipo() {
        let c = conn();
        // Old schema: no `color` on projects, no `slot` on terminals.
        c.execute_batch(
            r#"
            CREATE TABLE schema_migrations (version INTEGER);
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, sort INTEGER, created_at INTEGER);
            CREATE TABLE groups (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, layout_json TEXT, suspended INTEGER, sort INTEGER);
            CREATE TABLE terminals (id TEXT PRIMARY KEY, group_id TEXT, title TEXT, kind TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER);
            INSERT INTO projects VALUES ('p1', 'yard', 'C:\Workspace\Code\yard', 0, 42);
            INSERT INTO groups VALUES ('g1', 'p1', 'Principal', '{"mode":"auto","slots":[]}', 0, 0);
            INSERT INTO terminals VALUES ('t1', 'g1', 'Claude Code', 'agent', 'claude.exe', '[]', 'C:\Workspace\Code\yard', NULL, 0, 1);
            "#,
        )
        .unwrap();

        migrate(&c).unwrap();

        assert_eq!(user_version(&c).unwrap(), SCHEMA_VERSION);
        let (name, sort): (String, i64) = c
            .query_row("SELECT name, sort FROM projects WHERE id = 'p1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "yard");
        assert_eq!(sort, 0);
        let layout: String = c
            .query_row("SELECT layout_json FROM groups WHERE id = 'g1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(layout, "{}");
        let (slot, alive): (i64, i64) = c
            .query_row("SELECT slot, alive FROM terminals WHERE id = 't1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(slot, 0);
        assert_eq!(alive, 1);
        assert!(!has_table(&c, "projects_prototipo").unwrap());
    }

    /// Path already re-registered: the new project stays, and the old
    /// groups/terminals become owned by it.
    #[test]
    fn v3_reaproveita_projeto_recadastrado_pelo_caminho() {
        let c = conn();
        migrate(&c).unwrap(); // current schema, empty

        c.execute_batch(
            r#"
            CREATE TABLE projects_prototipo (id TEXT, name TEXT, path TEXT, color TEXT, sort INTEGER, created_at INTEGER);
            CREATE TABLE groups_prototipo (id TEXT, project_id TEXT, name TEXT, layout_json TEXT, suspended INTEGER, sort INTEGER);
            CREATE TABLE terminals_prototipo (id TEXT, group_id TEXT, title TEXT, kind TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER);
            INSERT INTO projects_prototipo VALUES ('velho', 'crm-ia', 'C:\Workspace\Code\crm-ia', NULL, 0, 1);
            INSERT INTO groups_prototipo VALUES ('gv', 'velho', 'Principal', '{}', 0, 0);
            INSERT INTO terminals_prototipo VALUES ('tv', 'gv', 'Claude Code', 'agent', 'claude.exe', '[]', 'C:\Workspace\Code\crm-ia', NULL, 0, 1);
            INSERT INTO projects(id, name, path, color, sort, created_at)
              VALUES ('novo', 'crm-ia', 'C:\Workspace\Code\crm-ia', NULL, 0, 2);
            "#,
        )
        .unwrap();
        c.pragma_update(None, "user_version", 2).unwrap();

        migrate(&c).unwrap();

        // The old project does not come back as a duplicate…
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM projects WHERE path = 'C:\\Workspace\\Code\\crm-ia'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        // …but its group and terminal reappear under the new project.
        let dono: String = c
            .query_row("SELECT project_id FROM groups WHERE id = 'gv'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dono, "novo");
        let vivo: i64 = c
            .query_row("SELECT alive FROM terminals WHERE id = 'tv'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vivo, 1);
    }

    /// Fresh database, no prototype traces: v3 is a silent no-op.
    #[test]
    fn v3_sem_prototipo_nao_faz_nada() {
        let c = conn();
        migrate(&c).unwrap();
        assert_eq!(user_version(&c).unwrap(), SCHEMA_VERSION);
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}

// --- kv (preferences) -----------------------------------------------------

pub fn kv_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

pub fn kv_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO kv(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

pub fn kv_all(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM kv")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn kv_delete(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM kv WHERE key = ?1", [key])?;
    Ok(())
}
