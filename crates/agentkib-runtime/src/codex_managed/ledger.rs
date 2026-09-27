//! Managed execution is durable state, deliberately separate from the disposable index.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    pub id: String,
    pub workspace_id: String,
    pub workspace: PathBuf,
    pub home: PathBuf,
    pub native_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub service_tier: Option<String>,
    #[serde(default = "default_policy")]
    pub policy_id: String,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub default_service_tier: Option<String>,
    #[serde(default)]
    pub token_usage: Option<Value>,
    #[serde(default)]
    pub goal: Option<Value>,
    #[serde(default)]
    pub native_settings: Option<Value>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub source_session_id: Option<String>,
    pub title: String,
    pub created_at: String,
    pub released: bool,
    pub adopted: bool,
    pub snapshot: Value,
}

fn default_policy() -> String {
    "workspace-write-on-request".into()
}
#[derive(Clone)]
pub(crate) struct Ledger {
    path: PathBuf,
}
impl Ledger {
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        let this = Self { path };
        let conn = this.connection()?;
        conn.execute_batch("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS managed_sessions(id TEXT PRIMARY KEY, record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS managed_commands(request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, phase TEXT NOT NULL, result TEXT);
          CREATE TABLE IF NOT EXISTS managed_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, UNIQUE(session_id,event_id));")?;
        let has_evidence = conn
            .prepare("PRAGMA table_info(managed_commands)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|s| s == "evidence");
        if !has_evidence {
            conn.execute_batch("ALTER TABLE managed_commands ADD COLUMN evidence TEXT")?;
        }
        let has_device = conn
            .prepare("PRAGMA table_info(managed_commands)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "device_id");
        if !has_device {
            conn.execute_batch(
                "ALTER TABLE managed_commands ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
            )?;
        }
        conn.execute_batch("COMMIT")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&this.path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(this)
    }
    fn connection(&self) -> Result<Connection> {
        let c = Connection::open(&self.path)?;
        c.busy_timeout(Duration::from_secs(3))?;
        Ok(c)
    }
    pub fn save(&self, record: &Record) -> Result<()> {
        self.connection()?.execute("INSERT INTO managed_sessions VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET record=excluded.record", params![record.id,serde_json::to_string(record)?])?;
        Ok(())
    }
    pub fn get(&self, id: &str) -> Result<Option<Record>> {
        let text: Option<String> = self
            .connection()?
            .query_row(
                "SELECT record FROM managed_sessions WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        text.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn list(&self) -> Result<Vec<Record>> {
        let conn = self.connection()?;
        let mut stmt =
            conn.prepare("SELECT record FROM managed_sessions ORDER BY rowid DESC LIMIT 20000")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|s| Ok(serde_json::from_str(&s?)?)).collect()
    }
    /// A duplicate request never dispatches again, including after a runtime restart.
    pub fn replay(&self, request: &str, fingerprint: &str) -> Result<Option<Value>> {
        let prior: Option<(String, String, Option<String>)> = self
            .connection()?
            .query_row(
                "SELECT fingerprint,phase,result FROM managed_commands WHERE request_id=?1",
                [request],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match prior {
            None => Ok(None),
            Some((hash, phase, result)) => {
                ensure!(
                    hash == fingerprint,
                    "request-id-reused-with-different-input"
                );
                Ok(Some(match result {
                    Some(s) => serde_json::from_str(&s)?,
                    None => {
                        json!({"accepted":false,"completed":false,"requestId":request,"controlOutcome":"unknown","reason":if phase=="prepared" {"request-interrupted"} else {"control-outcome-unconfirmed"}})
                    }
                }))
            }
        }
    }
    pub fn claim(&self, request: &str, session: &str, fingerprint: &str) -> Result<Option<Value>> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let prior: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT fingerprint,phase,result FROM managed_commands WHERE request_id=?1",
                [request],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((hash, phase, result)) = prior {
            ensure!(
                hash == fingerprint,
                "request-id-reused-with-different-input"
            );
            return Ok(Some(match result {
                Some(v) => serde_json::from_str(&v)?,
                None => {
                    json!({"accepted":false,"completed":false,"requestId":request,"controlOutcome":"unknown","reason":if phase=="prepared" {"request-interrupted"} else {"control-outcome-unconfirmed"}})
                }
            }));
        }
        tx.execute("INSERT INTO managed_commands(request_id,session_id,fingerprint,phase,result) VALUES(?1,?2,?3,'prepared',NULL)",params![request,session,fingerprint])?;
        tx.commit()?;
        Ok(None)
    }
    pub fn bind_device(&self, request: &str, device: Option<&str>) -> Result<()> {
        self.connection()?.execute(
            "UPDATE managed_commands SET device_id=?2 WHERE request_id=?1 AND phase='prepared'",
            params![request, device.unwrap_or("")],
        )?;
        Ok(())
    }
    pub fn is_dispatched(&self, request: &str) -> Result<bool> {
        Ok(self.connection()?.query_row("SELECT EXISTS(SELECT 1 FROM managed_commands WHERE request_id=?1 AND phase='dispatched')",[request],|r|r.get(0))?)
    }
    pub fn receipt(&self, request: &str, device: &str) -> Result<Value> {
        let prior:Option<(String,String,Option<String>,Option<String>)>=self.connection()?.query_row("SELECT session_id,phase,result,evidence FROM managed_commands WHERE request_id=?1 AND device_id=?2",params![request,device],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((session, phase, result, evidence)) = prior else {
            return Ok(json!({"found":false,"requestId":request}));
        };
        let ack: Value = result
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null);
        let evidence: Value = evidence
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null);
        let status = if phase == "dispatched" {
            "unknown"
        } else if ack["accepted"] == true {
            "accepted"
        } else {
            "not-dispatched"
        };
        Ok(
            json!({"found":true,"requestId":request,"sessionId":session,"workspaceId":evidence["workspaceId"],"operation":evidence["operation"],"executionMode":evidence["executionMode"],"runtimeBootId":evidence["runtimeBootId"],"expectedRevision":evidence["expectedRevision"],"turnId":evidence["turnId"],"status":status,"ack":ack,"completionObserved":false}),
        )
    }
    pub fn dispatch(&self, request: &str) -> Result<()> {
        let changed=self.connection()?.execute("UPDATE managed_commands SET phase='dispatched' WHERE request_id=?1 AND phase='prepared'",[request])?;
        ensure!(changed == 1, "control-ledger-not-prepared");
        Ok(())
    }
    pub fn annotate(&self, request: &str, evidence: &Value) -> Result<()> {
        self.connection()?.execute(
            "UPDATE managed_commands SET evidence=?2 WHERE request_id=?1 AND phase='prepared'",
            params![request, serde_json::to_string(evidence)?],
        )?;
        Ok(())
    }
    pub fn unknown(&self, session: &str) -> Result<Vec<(String, Value)>> {
        let conn = self.connection()?;
        let mut stmt=conn.prepare("SELECT request_id,evidence FROM managed_commands WHERE session_id=?1 AND phase='dispatched'")?;
        let rows = stmt.query_map([session], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        rows.map(|r| {
            let (id, e) = r?;
            Ok((
                id,
                e.map(|s| serde_json::from_str(&s))
                    .transpose()?
                    .unwrap_or(Value::Null),
            ))
        })
        .collect()
    }
    pub fn finish(&self, request: &str, result: &Value) -> Result<()> {
        self.connection()?.execute(
            "UPDATE managed_commands SET phase='resolved',result=?2 WHERE request_id=?1",
            params![request, serde_json::to_string(result)?],
        )?;
        Ok(())
    }
    pub fn has_unknown(&self, session: &str) -> Result<bool> {
        Ok(self.connection()?.query_row("SELECT EXISTS(SELECT 1 FROM managed_commands WHERE session_id=?1 AND phase='dispatched')",[session],|r|r.get(0))?)
    }
    pub fn event(&self, session: &str, event: &Value) -> Result<()> {
        let id = event["id"].as_str().context("missing event identity")?;
        self.connection()?.execute("INSERT INTO managed_events(session_id,event_id,event) VALUES(?1,?2,?3) ON CONFLICT(session_id,event_id) DO UPDATE SET event=excluded.event",params![session,id,serde_json::to_string(event)?])?;
        Ok(())
    }
    pub fn events(&self, session: &str, cursor: Option<&str>, limit: usize) -> Result<Value> {
        let before = cursor
            .map(str::parse::<u64>)
            .transpose()
            .context("invalid-cursor")?
            .unwrap_or(i64::MAX as u64);
        let limit = limit.clamp(1, 100);
        let conn = self.connection()?;
        let mut stmt=conn.prepare("SELECT sequence,event FROM managed_events WHERE session_id=?1 AND sequence<?2 ORDER BY sequence DESC LIMIT ?3")?;
        let rows = stmt.query_map(params![session, before, limit + 1], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut values: Vec<(u64, Value)> = rows
            .map(|r| {
                let (n, s) = r?;
                Ok((n, serde_json::from_str(&s)?))
            })
            .collect::<Result<_>>()?;
        let more = values.len() > limit;
        values.truncate(limit);
        let cursor = if more {
            values.last().map(|v| v.0.to_string())
        } else {
            None
        };
        values.reverse();
        Ok(
            json!({"events":values.into_iter().map(|v|v.1).collect::<Vec<_>>(),"next_cursor":cursor,"warnings":[]}),
        )
    }
    pub fn lock_path(&self, id: &str) -> PathBuf {
        self.path
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!("managed-{id}.lock"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_survive_reopen_without_redispatch() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("managed.db");
        let l = Ledger::open(path.clone()).unwrap();
        assert!(l.claim("req", "s", "hash").unwrap().is_none());
        l.dispatch("req").unwrap();
        drop(l);
        let l = Ledger::open(path).unwrap();
        assert!(l.has_unknown("s").unwrap());
        assert_eq!(
            l.claim("req", "s", "hash").unwrap().unwrap()["controlOutcome"],
            "unknown"
        );
        assert!(l.claim("req", "s", "other").is_err());
        l.finish("req", &json!({"accepted":true})).unwrap();
        assert_eq!(
            l.claim("req", "s", "hash").unwrap().unwrap()["accepted"],
            true
        );
    }
    #[test]
    fn migrates_prior_ledger_and_restricts_directory_permissions() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("managed");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("executions.sqlite");
        let old = Connection::open(&path).unwrap();
        old.execute_batch("CREATE TABLE managed_commands(request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, phase TEXT NOT NULL, result TEXT); INSERT INTO managed_commands VALUES('old','session','hash','resolved','{\"accepted\":true}')").unwrap();
        drop(old);
        let ledger = Ledger::open(path.clone()).unwrap();
        assert_eq!(
            ledger.replay("old", "hash").unwrap().unwrap()["accepted"],
            true
        );
        assert!(ledger.claim("new", "session", "hash2").unwrap().is_none());
        ledger
            .annotate("new", &json!({"operation":"send"}))
            .unwrap();
        ledger.dispatch("new").unwrap();
        assert_eq!(ledger.unknown("session").unwrap()[0].1["operation"], "send");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn receipts_are_device_scoped_and_unknown_survives_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("commands.db");
        let ledger = Ledger::open(path.clone()).unwrap();
        ledger.claim("request", "session", "fingerprint").unwrap();
        ledger.bind_device("request", Some("device-a")).unwrap();
        ledger.annotate("request",&json!({"operation":"approve","executionMode":"codex-follower","runtimeBootId":"original-boot","expectedRevision":7,"workspaceId":"workspace","turnId":"turn"})).unwrap();
        assert_eq!(
            ledger.receipt("request", "device-a").unwrap()["status"],
            "not-dispatched"
        );
        assert_eq!(
            ledger.receipt("request", "device-b").unwrap(),
            json!({"found":false,"requestId":"request"})
        );
        ledger.dispatch("request").unwrap();
        assert!(ledger.dispatch("missing").is_err());
        drop(ledger);
        let ledger = Ledger::open(path).unwrap();
        assert!(ledger.has_unknown("session").unwrap());
        let receipt = ledger.receipt("request", "device-a").unwrap();
        assert_eq!(receipt["status"], "unknown");
        assert_eq!(receipt["runtimeBootId"], "original-boot");
        assert_eq!(receipt["expectedRevision"], 7);
        ledger
            .finish(
                "request",
                &json!({"accepted":true,"completed":false,"requestId":"request"}),
            )
            .unwrap();
        let receipt = ledger.receipt("request", "device-a").unwrap();
        assert_eq!(receipt["status"], "accepted");
        assert_eq!(receipt["completionObserved"], false);
        assert!(!ledger.has_unknown("session").unwrap());
    }
    #[test]
    fn event_replay_is_deduplicated_and_paginated() {
        let t = tempfile::tempdir().unwrap();
        let l = Ledger::open(t.path().join("managed.db")).unwrap();
        for id in ["a", "a", "b"] {
            l.event("s", &json!({"id":id})).unwrap();
        }
        let page = l.events("s", None, 1).unwrap();
        assert_eq!(page["events"][0]["id"], "b");
        assert_eq!(
            l.events("s", page["next_cursor"].as_str(), 1).unwrap()["events"][0]["id"],
            "a"
        );
    }
}
