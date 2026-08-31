//! SQLite: opening, PRAGMAs, and versioned migrations (§4.4).
//!
//! WAL is enabled on purpose: Windows antivirus and indexers hold the
//! main file for moments, and in rollback mode that becomes "database is
//! locked" in the middle of an autosave (§9.10).

use rusqlite::{Connection, OptionalExtension};

/// Schema version. Every new migration increments this and gets a block in
/// `migrate`. Never rewrite a migration that has already shipped.
const SCHEMA_VERSION: i64 = 8;

pub fn open() -> anyhow::Result<Connection> {
    crate::paths::ensure_dirs()?;

    // A backup restored in the previous session is only swapped in here:
    // before any connection exists. Failing to adopt must not stop the app
    // from booting on the database it already has.
    match super::backup::adopt_pending() {
        Ok(true) => tracing::info!("backup restaurado aplicado"),
        Ok(false) => {}
        Err(e) => tracing::error!(error = %e, "nao consegui aplicar o backup restaurado"),
    }

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
    ensure_added_columns(conn)?;

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
              -- Nullable since v7: a group with no project is a canvas board.
              project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
              name        TEXT NOT NULL,
              layout_json TEXT NOT NULL DEFAULT '{}',
              suspended   INTEGER NOT NULL DEFAULT 0,
              sort        INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS terminals (
              id          TEXT PRIMARY KEY,
              group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
              slot        INTEGER NOT NULL DEFAULT 0,
              surface     TEXT,
              title       TEXT,
              kind        TEXT NOT NULL DEFAULT 'shell',
              agent_id    TEXT,
              program     TEXT NOT NULL,
              args_json   TEXT NOT NULL DEFAULT '[]',
              cwd         TEXT NOT NULL,
              resume_json TEXT,
              sort        INTEGER NOT NULL DEFAULT 0,
              alive       INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT 0,
              pinned      INTEGER NOT NULL DEFAULT 0
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

    if current < 5 {
        // The notebook (persistence/notes.rs): markdown notes with notebooks,
        // labels, statuses and a trash. `tags_json` is a JSON array of tag ids;
        // `notebook_id` has no FK on purpose — deleting a notebook re-homes its
        // notes from the front end, and a constraint here would make that a
        // two-phase dance for nothing.
        conn.execute_batch(
            r#"
            BEGIN;

            CREATE TABLE IF NOT EXISTS notebooks (
              id        TEXT PRIMARY KEY,
              name      TEXT NOT NULL,
              parent_id TEXT,
              icon      TEXT,
              sort      INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS note_tags (
              id    TEXT PRIMARY KEY,
              name  TEXT NOT NULL,
              color TEXT NOT NULL,
              sort  INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS notes (
              id          TEXT PRIMARY KEY,
              title       TEXT NOT NULL DEFAULT '',
              body        TEXT NOT NULL DEFAULT '',
              notebook_id TEXT,
              tags_json   TEXT NOT NULL DEFAULT '[]',
              status      TEXT NOT NULL DEFAULT 'none',
              pinned      INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT 0,
              updated_at  INTEGER NOT NULL DEFAULT 0,
              deleted_at  INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id);

            PRAGMA user_version = 5;
            COMMIT;
            "#,
        )?;
        tracing::info!("migracao aplicada: schema v5");
    }

    if current < 6 {
        // The canvas and the pane grid stopped drawing the same terminals
        // (`src/lib/surface.ts`): each row now says which of the two draws it.
        // Existing rows are left **null** on purpose. Which surface a
        // pre-split terminal belongs to is the one its group was showing, and
        // that lives in `groups.layout_json` — parsed in the front end, which
        // stamps them on the first load and saves them back
        // (`stampSurfaces`). A default here would stamp every row with
        // `'grid'` before that code ever ran, and a stamped row is never
        // looked at again: every card of every canvas group would silently
        // become a tab.
        if !has_column(conn, "terminals", "surface")? {
            conn.execute("ALTER TABLE terminals ADD COLUMN surface TEXT", [])?;
        }
        conn.pragma_update(None, "user_version", 6)?;
        tracing::info!("migracao aplicada: schema v6");
    }

    if current < 7 {
        rebuild_groups_without_project_constraint(conn)?;
        conn.pragma_update(None, "user_version", 7)?;
        tracing::info!("migracao aplicada: schema v7");
    }

    if current < 8 {
        // The pin the tab bar already gave files, now for the CLIs: a tab kept
        // at the front of its bar that "fechar as outras" does not take. The
        // column itself is put in place by `ensure_added_columns`, which runs
        // whatever the stamp says; this step only moves the stamp.
        conn.pragma_update(None, "user_version", 8)?;
        tracing::info!("migracao aplicada: schema v8");
    }

    Ok(())
}

/// v7: `groups.project_id` becomes nullable, so a **board** can exist.
///
/// A board ("quadro") is the canvas as its own container: it holds cards from
/// several projects at once, so there is no single project it could point at.
/// A group with `project_id IS NULL` *is* a board — one rule, no second flag
/// that could disagree with it.
///
/// `project_id` was declared `NOT NULL` in v1 and SQLite cannot drop a column
/// constraint with `ALTER TABLE`, so the table is rebuilt. This follows the
/// documented 12-step procedure: foreign keys off **outside** the transaction
/// (the pragma is a no-op inside one), rebuild, then on again and check. The
/// `ON DELETE CASCADE` is recreated verbatim — deleting a project still has to
/// take its groups and their terminals, and a board must survive it.
fn rebuild_groups_without_project_constraint(conn: &Connection) -> anyhow::Result<()> {
    // Already nullable (a database created by a v7-or-later `CREATE TABLE`):
    // rebuilding would only risk the data for nothing.
    if !column_is_not_null(conn, "groups", "project_id")? {
        return Ok(());
    }
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let outcome = conn.execute_batch(
        r#"
        BEGIN;

        CREATE TABLE groups_v7 (
          id          TEXT PRIMARY KEY,
          project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          layout_json TEXT NOT NULL DEFAULT '{}',
          suspended   INTEGER NOT NULL DEFAULT 0,
          sort        INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO groups_v7(id, project_id, name, layout_json, suspended, sort)
          SELECT id, project_id, name, layout_json, suspended, sort FROM groups;

        DROP TABLE groups;
        ALTER TABLE groups_v7 RENAME TO groups;

        CREATE INDEX IF NOT EXISTS idx_groups_project ON groups(project_id);

        COMMIT;
        "#,
    );
    // The pragma goes back on whatever happened: leaving the connection with
    // foreign keys off would silently accept orphan rows for the rest of the
    // session, which is far worse than the failed migration.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    outcome?;
    Ok(())
}

/// Whether a column carries `NOT NULL` — read from `PRAGMA table_info`, so it
/// answers for the table that is actually on disk.
fn column_is_not_null(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(row.get::<_, i64>(3)? != 0);
        }
    }
    Ok(false)
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
    for idx in [
        "idx_groups_project",
        "idx_terminals_group",
        "idx_sessions_project",
    ] {
        conn.execute(&format!("DROP INDEX IF EXISTS {idx}"), [])?;
    }
    for table in ["terminals", "groups", "projects", "agent_sessions"] {
        if has_table(conn, table)? {
            conn.execute(
                &format!("ALTER TABLE {table} RENAME TO {table}_prototipo"),
                [],
            )?;
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

/// Columns that are only ever *added*, checked on every boot instead of being
/// hung off the version ladder.
///
/// `user_version` is one integer, and this repository is worked on by several
/// agents at once: two branches both called their next step "8", one adding
/// `terminals.chat` and the other `terminals.pinned`. Whichever built first
/// stamped the database 8, and `if current < 8` was false from then on. The
/// other column was never added and the next boot could not read the
/// workspace at all.
///
/// The ladder stays for what genuinely needs an order (rebuilding a table,
/// moving data between them). A column that is simply missing needs no order:
/// it is declared here, and put back whenever it is not there. A database the
/// ladder has not created yet has nothing to repair: its `CREATE TABLE`
/// already names every column.
fn ensure_added_columns(conn: &Connection) -> rusqlite::Result<()> {
    const ADDED: &[(&str, &str, &str)] = &[(
        "terminals",
        "pinned",
        "ALTER TABLE terminals ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    )];
    for (table, column, ddl) in ADDED {
        if !has_table(conn, table)? {
            continue;
        }
        if !has_column(conn, table, column)? {
            conn.execute(ddl, [])?;
            tracing::info!("coluna reposta: {table}.{column}");
        }
    }
    Ok(())
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
    fn v3_readopts_prototype_projects_and_terminals() {
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
            .query_row("SELECT layout_json FROM groups WHERE id = 'g1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(layout, "{}");
        let (slot, alive): (i64, i64) = c
            .query_row(
                "SELECT slot, alive FROM terminals WHERE id = 't1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(slot, 0);
        assert_eq!(alive, 1);
        assert!(!has_table(&c, "projects_prototipo").unwrap());
    }

    /// The canvas and the pane grid stopped drawing the same terminals, so
    /// every row needs to say which of the two it belongs to. A database that
    /// stopped at v5 has no such column, and the migration must leave those
    /// rows **empty** rather than guessing: which surface a pre-split terminal
    /// belongs to depends on the group's `layout_json`, and the front end is
    /// where that is parsed (`stampSurfaces`). Filling them with `'grid'` here
    /// looked harmless and silently sent every card of every canvas group to a
    /// pane, because a stamped row is never stamped again.
    #[test]
    fn v6_adds_the_surface_column_and_leaves_old_rows_for_the_front_end() {
        let c = conn();
        c.execute_batch(
            r#"
            CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, color TEXT, icon TEXT, sort INTEGER, created_at INTEGER);
            CREATE TABLE groups (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, layout_json TEXT, suspended INTEGER, sort INTEGER);
            CREATE TABLE terminals (id TEXT PRIMARY KEY, group_id TEXT, slot INTEGER, title TEXT, kind TEXT, agent_id TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER, created_at INTEGER);
            INSERT INTO projects VALUES ('p1', 'yard', 'C:\Workspace\Code\yard', NULL, NULL, 0, 0);
            INSERT INTO groups VALUES ('g1', 'p1', 'Principal', '{"mode":"canvas"}', 0, 0);
            INSERT INTO terminals VALUES ('t1', 'g1', 0, NULL, 'agent', 'claude', 'claude.exe', '[]', 'C:\Workspace\Code\yard', NULL, 0, 0, 0);
            PRAGMA user_version = 5;
            "#,
        )
        .unwrap();

        migrate(&c).unwrap();

        assert!(has_column(&c, "terminals", "surface").unwrap());
        let surface: Option<String> = c
            .query_row("SELECT surface FROM terminals WHERE id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(surface, None);
    }

    /// A pinned tab sits at the front of its bar and survives "fechar as
    /// outras". Files had the pin in the front end's own store; CLIs are rows
    /// here, so the flag has to be a column, and an old row has to read as
    /// **not** pinned rather than as missing.
    #[test]
    fn v8_adds_the_pinned_column_and_old_terminals_read_as_loose() {
        let c = conn();
        c.execute_batch(
            r#"
            CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, color TEXT, icon TEXT, sort INTEGER, created_at INTEGER);
            CREATE TABLE groups (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, layout_json TEXT, suspended INTEGER, sort INTEGER);
            CREATE TABLE terminals (id TEXT PRIMARY KEY, group_id TEXT, slot INTEGER, surface TEXT, title TEXT, kind TEXT, agent_id TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER, created_at INTEGER);
            INSERT INTO projects VALUES ('p1', 'yard', 'C:\Workspace\Code\yard', NULL, NULL, 0, 0);
            INSERT INTO groups VALUES ('g1', 'p1', 'Principal', '{}', 0, 0);
            INSERT INTO terminals VALUES ('t1', 'g1', 0, 'grid', NULL, 'agent', 'claude', 'claude.exe', '[]', 'C:\Workspace\Code\yard', NULL, 0, 0, 0);
            PRAGMA user_version = 7;
            "#,
        )
        .unwrap();

        migrate(&c).unwrap();

        assert!(has_column(&c, "terminals", "pinned").unwrap());
        let pinned: i64 = c
            .query_row("SELECT pinned FROM terminals WHERE id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pinned, 0);
    }

    /// The bug this locks down, seen on a real machine.
    ///
    /// `user_version` is a single integer, and two branches of this repository
    /// both called their next step "8": one added `terminals.chat`, the other
    /// `terminals.pinned`. The `chat` build ran first, stamped the database 8,
    /// and from then on `if current < 8` was false forever. The `pinned`
    /// column was never added, and the very next boot died on
    /// `no such column: pinned` with the whole workspace unreadable.
    ///
    /// So adding a column may not depend on the stamp being behind. The
    /// version ladder stays for structural work (rebuilding a table, moving
    /// data); a column that is merely *missing* is put back on every boot.
    #[test]
    fn a_column_missing_from_a_database_already_stamped_current_is_still_added() {
        let c = conn();
        c.execute_batch(
            r#"
            CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, color TEXT, icon TEXT, sort INTEGER, created_at INTEGER);
            CREATE TABLE groups (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, layout_json TEXT, suspended INTEGER, sort INTEGER);
            CREATE TABLE terminals (id TEXT PRIMARY KEY, group_id TEXT, slot INTEGER, surface TEXT, title TEXT, kind TEXT, agent_id TEXT, program TEXT, args_json TEXT, cwd TEXT, resume_json TEXT, sort INTEGER, alive INTEGER, created_at INTEGER, chat INTEGER NOT NULL DEFAULT 0);
            INSERT INTO projects VALUES ('p1', 'yard', 'C:\Workspace\Code\yard', NULL, NULL, 0, 0);
            INSERT INTO groups VALUES ('g1', 'p1', 'Principal', '{}', 0, 0);
            INSERT INTO terminals VALUES ('t1', 'g1', 0, 'grid', NULL, 'agent', 'claude', 'claude.exe', '[]', 'C:\Workspace\Code\yard', NULL, 0, 0, 0, 0);
            "#,
        )
        .unwrap();
        // Stamped as up to date by the other branch, and the ladder will not
        // look at it again.
        c.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();

        migrate(&c).unwrap();

        assert!(has_column(&c, "terminals", "pinned").unwrap());
        let pinned: i64 = c
            .query_row("SELECT pinned FROM terminals WHERE id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pinned, 0);
        // The column the other branch added is left exactly where it was.
        assert!(has_column(&c, "terminals", "chat").unwrap());
    }

    /// A canvas board ("quadro") is a group that belongs to **no** project:
    /// it holds cards from several at once, so there is no single project it
    /// could point at. `project_id` was `NOT NULL` since v1, and SQLite cannot
    /// drop that with an `ALTER` — v7 rebuilds the table, which must keep every
    /// row and leave the `terminals` foreign key intact.
    #[test]
    fn v7_lets_a_group_exist_with_no_project_and_keeps_the_old_ones() {
        let c = conn();
        migrate(&c).unwrap();
        c.execute_batch(
            r#"
            INSERT INTO projects(id, name, path, sort, created_at)
              VALUES ('p1', 'yard', 'C:\Workspace\Code\yard', 0, 0);
            INSERT INTO groups(id, project_id, name, layout_json, suspended, sort)
              VALUES ('g1', 'p1', 'Principal', '{}', 0, 3);
            INSERT INTO terminals(id, group_id, program, cwd, created_at)
              VALUES ('t1', 'g1', 'pwsh', 'C:\Workspace\Code\yard', 0);
            "#,
        )
        .unwrap();

        // The board: no project, and it must be accepted.
        c.execute(
            "INSERT INTO groups(id, project_id, name, layout_json, suspended, sort)
             VALUES ('b1', NULL, 'Refatoracao do PTY', '{}', 0, 0)",
            [],
        )
        .unwrap();

        // The group that does have a project kept everything it had...
        let (project, name, sort): (Option<String>, String, i64) = c
            .query_row(
                "SELECT project_id, name, sort FROM groups WHERE id = 'g1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(project.as_deref(), Some("p1"));
        assert_eq!(name, "Principal");
        assert_eq!(sort, 3);
        // ...and its terminal is still tied to it, which is what proves the
        // rebuilt table did not take the foreign key down with it.
        let orphans: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM terminals t
                 LEFT JOIN groups g ON g.id = t.group_id WHERE g.id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
        // Deleting the project still takes its groups (the CASCADE survived),
        // and leaves the board alone.
        c.execute("DELETE FROM projects WHERE id = 'p1'", []).unwrap();
        let left: Vec<String> = c
            .prepare("SELECT id FROM groups ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(left, vec!["b1".to_string()]);
    }

    /// Path already re-registered: the new project stays, and the old
    /// groups/terminals become owned by it.
    #[test]
    fn v3_reuses_a_project_reregistered_by_path() {
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
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE path = 'C:\\Workspace\\Code\\crm-ia'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        // …but its group and terminal reappear under the new project.
        let owner: String = c
            .query_row("SELECT project_id FROM groups WHERE id = 'gv'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(owner, "novo");
        let alive: i64 = c
            .query_row("SELECT alive FROM terminals WHERE id = 'tv'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(alive, 1);
    }

    /// Fresh database, no prototype traces: v3 is a silent no-op.
    #[test]
    fn v3_without_a_prototype_does_nothing() {
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
