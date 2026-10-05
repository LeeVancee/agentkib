//! Event-driven, bounded session projections. Replay is transient; the command
//! ledger and native history remain the authority for execution and recovery.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

const MAX_EVENTS: usize = 256;
const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCES: usize = 128;
const MAX_SUBSCRIPTIONS: usize = 128;
pub(super) const MAX_ITEMS_BYTES: usize = 1024 * 1024;
const MAX_COMPLETE_ITEMS: usize = 4096;
const MAX_REMOVED_IDENTITIES: usize = 4096;
const MAX_REMOVED_BYTES: usize = 256 * 1024;
const TEXT_BATCH_DELAY: Duration = Duration::from_millis(20);
const MAX_TEXT_BATCH_BYTES: usize = 32 * 1024;
pub(super) const MAX_ITEM_TEXT_BYTES: usize = 128 * 1024;

pub(super) fn bounded_text(text: &str) -> (&str, bool) {
    let mut end = text.len().min(MAX_ITEM_TEXT_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], end < text.len())
}

#[derive(Clone)]
pub(crate) struct Hub(Arc<Inner>);
struct Inner {
    boot: String,
    state: Mutex<HubState>,
    wake: mpsc::SyncSender<()>,
    batch_wake: mpsc::SyncSender<()>,
}
#[derive(Default)]
struct HubState {
    sources: BTreeMap<String, Source>,
    subscriptions: BTreeMap<String, Subscription>,
    last_subscription: String,
}
impl HubState {
    fn source(&mut self, session: &str) -> Option<&mut Source> {
        if !self.sources.contains_key(session) && self.sources.len() >= MAX_SOURCES {
            let retired = self
                .sources
                .iter()
                .find(|(id, source)| {
                    !id.is_empty()
                        && !matches!(
                            source.live["status"].as_str(),
                            Some(
                                "running"
                                    | "awaiting-approval"
                                    | "waiting-input"
                                    | "waiting-approval"
                            )
                        )
                        && !self.subscriptions.values().any(|sub| &sub.session == *id)
                })
                .map(|(id, _)| id.clone());
            self.sources.remove(&retired?);
        }
        Some(
            self.sources
                .entry(session.into())
                .or_insert_with(Source::new),
        )
    }
}
struct Source {
    epoch: String,
    seq: u64,
    live: Value,
    items: BTreeMap<String, Value>,
    item_order: VecDeque<String>,
    item_bytes: usize,
    complete_items: bool,
    coverage_changed: bool,
    authoritative_turns: Vec<String>,
    preserve_items_outside_coverage: bool,
    removed_turns: BTreeSet<String>,
    removed_items: BTreeSet<String>,
    history_cache_epoch: Option<String>,
    // Managed hydration knows the full native turn list independently of the
    // bounded item tail, so rollback can delete previously paged old turns.
    hydrated_turns: BTreeSet<String>,
    hydrated_turn_bytes: usize,
    hydrated_turns_overflow: bool,
    replay: VecDeque<(Value, usize)>,
    bytes: usize,
    pending_text: Option<TextBatch>,
}
struct TextBatch {
    item: String,
    turn: Option<String>,
    text: String,
    offset: usize,
    ephemeral: bool,
    deadline: Instant,
    revision: Option<Value>,
}
struct Subscription {
    session: String,
    delivered: u64,
}
#[derive(Clone)]
pub(crate) struct Publisher {
    hub: Hub,
    session: String,
    mode: &'static str,
}

impl Hub {
    pub fn new(boot: String, notify: impl Fn(Value) -> bool + Send + 'static) -> Self {
        let (wake, receiver) = mpsc::sync_channel(1);
        let (batch_wake, batch_receiver) = mpsc::sync_channel(1);
        let mut state = HubState::default();
        let mut catalog = Source::new();
        catalog.live = json!({"status":"idle","executionMode":"catalog"});
        state.sources.insert(String::new(), catalog);
        let hub = Self(Arc::new(Inner {
            boot,
            state: Mutex::new(state),
            wake,
            batch_wake,
        }));
        let weak = Arc::downgrade(&hub.0);
        std::thread::spawn(move || {
            while receiver.recv().is_ok() {
                let Some(inner) = weak.upgrade() else { break };
                let hub = Hub(inner);
                while let Some(event) = hub.next_notification() {
                    // The transport may block here, never on a native reader/state lock.
                    if !notify(event) {
                        return;
                    }
                }
            }
        });
        // A slow stdout sink must not extend the coalescing deadline or block
        // native readers. This timer commits batches independently of delivery.
        let weak = Arc::downgrade(&hub.0);
        std::thread::spawn(move || {
            loop {
                let Some(inner) = weak.upgrade() else { break };
                let delay = Hub(inner).flush_due_text(Instant::now());
                match delay {
                    Some(delay) => match batch_receiver.recv_timeout(delay) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    },
                    None if batch_receiver.recv().is_err() => break,
                    None => {}
                }
            }
        });
        hub
    }

    pub fn publisher(&self, session: &str, mode: &'static str) -> Publisher {
        Publisher {
            hub: self.clone(),
            session: session.into(),
            mode,
        }
    }

    #[cfg(test)]
    pub fn contains(&self, session: &str) -> bool {
        self.0
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sources
            .contains_key(session)
    }

    #[cfg(any(target_os = "macos", test))]
    pub fn has_subscribers(&self, session: &str) -> bool {
        self.0
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .subscriptions
            .values()
            .any(|subscription| subscription.session == session)
    }

    pub fn subscribe(&self, session: &str, after: Option<&str>) -> Result<Value> {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            state.subscriptions.len() < MAX_SUBSCRIPTIONS,
            "session-subscription-limit"
        );
        let source = state
            .sources
            .get_mut(session)
            .context("session-stream-unavailable")?;
        // The projection already includes buffered text. Commit it before
        // capturing the baseline/cursor so a resumed reader cannot miss it and
        // a new reader cannot receive it twice after the baseline.
        let flushed = source.flush_text(&self.0.boot, session);
        let id = uuid::Uuid::new_v4().to_string();
        let cursor = source.cursor();
        let replay_from = after.and_then(|cursor| source.parse_cursor(cursor));
        let earliest = source
            .replay
            .front()
            .and_then(|(event, _)| event["seq"].as_u64())
            .unwrap_or(source.seq + 1);
        let events: Vec<Value> = if let Some(seq) =
            replay_from.filter(|seq| *seq <= source.seq && seq.saturating_add(1) >= earliest)
        {
            source
                .replay
                .iter()
                .filter(|(event, _)| event["seq"].as_u64().unwrap_or(0) > seq)
                .map(|(event, _)| with_subscription(event.clone(), &id))
                .collect()
        } else {
            vec![with_subscription(
                source.envelope(
                    &self.0.boot,
                    session,
                    "snapshot",
                    source.snapshot_payload(false),
                ),
                &id,
            )]
        };
        let delivered = source.seq;
        state.subscriptions.insert(
            id.clone(),
            Subscription {
                session: session.into(),
                delivered,
            },
        );
        let response = json!({"subscriptionId":id,"events":events,"cursor":cursor});
        drop(state);
        if flushed {
            let _ = self.0.wake.try_send(());
        }
        Ok(response)
    }

    pub fn pending_interaction(&self, session: &str) -> Option<bool> {
        let state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let source = state.sources.get(session)?;
        Some(["approvals", "questions"].iter().any(|key| {
            source.live[*key]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        }))
    }

    pub fn unsubscribe(&self, id: &str) -> Value {
        let removed = self
            .0
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .subscriptions
            .remove(id)
            .is_some();
        json!({"removed":removed})
    }

    fn next_notification(&self) -> Option<Value> {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let (id, session, delivered) = state
            .subscriptions
            .iter()
            .filter(|(id, _)| *id > &state.last_subscription)
            .chain(
                state
                    .subscriptions
                    .iter()
                    .filter(|(id, _)| *id <= &state.last_subscription),
            )
            .find_map(|(id, sub)| {
                state
                    .sources
                    .get(&sub.session)
                    .filter(|source| source.seq > sub.delivered)
                    .map(|_| (id.clone(), sub.session.clone(), sub.delivered))
            })?;
        state.last_subscription = id.clone();
        let source = state.sources.get(&session)?;
        let event = if let Some((event, _)) = source
            .replay
            .iter()
            .find(|(event, _)| event["seq"] == delivered + 1)
        {
            event.clone()
        } else {
            source.envelope(
                &self.0.boot,
                &session,
                "resync-required",
                json!({"reason":"replay-expired"}),
            )
        };
        state.subscriptions.get_mut(&id)?.delivered = event["seq"].as_u64()?;
        Some(with_subscription(event, &id))
    }

    fn flush_due_text(&self, now: Instant) -> Option<Duration> {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut published = false;
        let mut deadline = None;
        for (session, source) in &mut state.sources {
            if source
                .pending_text
                .as_ref()
                .is_some_and(|batch| batch.deadline <= now)
            {
                published |= source.flush_text(&self.0.boot, session);
            }
            if let Some(batch) = &source.pending_text {
                deadline =
                    Some(deadline.map_or(batch.deadline, |next: Instant| next.min(batch.deadline)));
            }
        }
        drop(state);
        if published {
            let _ = self.0.wake.try_send(());
        }
        deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }
}

impl Source {
    fn new() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            seq: 0,
            live: Value::Null,
            items: BTreeMap::new(),
            item_order: VecDeque::new(),
            item_bytes: 0,
            complete_items: false,
            coverage_changed: false,
            authoritative_turns: Vec::new(),
            preserve_items_outside_coverage: false,
            removed_turns: BTreeSet::new(),
            removed_items: BTreeSet::new(),
            history_cache_epoch: None,
            hydrated_turns: BTreeSet::new(),
            hydrated_turn_bytes: 0,
            hydrated_turns_overflow: false,
            replay: VecDeque::new(),
            bytes: 0,
            pending_text: None,
        }
    }
    fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.seq)
    }
    fn snapshot_payload(&self, replace: bool) -> Value {
        let mut payload = json!({"live":self.live,"items":self.item_order.iter().filter_map(|id|self.items.get(id)).collect::<Vec<_>>(),"replaceItems":replace || (self.complete_items && !self.preserve_items_outside_coverage),"authoritativeTurnIds":self.authoritative_turns});
        if self.preserve_items_outside_coverage {
            payload["preserveItemsOutsideCoverage"] = json!(true);
        }
        if !self.removed_turns.is_empty() {
            payload["removedTurnIds"] = json!(self.removed_turns);
        }
        if !self.removed_items.is_empty() {
            payload["removedItemIds"] = json!(self.removed_items);
        }
        if let Some(epoch) = &self.history_cache_epoch {
            payload["historyCacheEpoch"] = json!(epoch);
        }
        payload
    }
    fn record_removed(&mut self, turns: &[String], items: &[String]) {
        self.removed_turns.extend(turns.iter().cloned());
        self.removed_items.extend(items.iter().cloned());
        let bytes = serde_json::to_vec(&(&self.removed_turns, &self.removed_items))
            .map_or(MAX_REMOVED_BYTES + 1, |value| value.len());
        if self.removed_turns.len() + self.removed_items.len() > MAX_REMOVED_IDENTITIES
            || bytes > MAX_REMOVED_BYTES
        {
            // A subscriber may have missed any of these deletions. Forgetting
            // identities is safe only with an explicit cache-reset generation,
            // retained in every subsequent baseline until the next overflow.
            self.history_cache_epoch = Some(uuid::Uuid::new_v4().to_string());
            self.removed_turns.clear();
            self.removed_items.clear();
        }
    }
    fn retain_item(&mut self, id: &str, mut item: Value) {
        if let Some(content) = item["content"]
            .as_str()
            .filter(|content| !self.complete_items && content.len() > MAX_ITEM_TEXT_BYTES)
        {
            let text = bounded_text(content).0.to_owned();
            item["content"] = json!(text);
            item["truncated"] = json!(true);
        }
        if let Some(previous) = self.items.insert(id.into(), item.clone()) {
            self.item_bytes -= serde_json::to_vec(&previous).map_or(0, |v| v.len());
        } else {
            self.item_order.push_back(id.into());
        }
        self.item_bytes += serde_json::to_vec(&item).map_or(0, |v| v.len());
        self.removed_items.remove(id);
        if let Some(turn) = item["turn_id"].as_str() {
            self.removed_turns.remove(turn);
            self.remember_hydrated_turn(turn);
            if item["truncated"] == true {
                self.forget_complete_turn(Some(turn));
            }
        }
        if self.complete_items
            && (self.items.len() > MAX_COMPLETE_ITEMS || self.item_bytes > MAX_ITEMS_BYTES)
        {
            self.complete_items = false;
            self.preserve_items_outside_coverage = true;
            self.history_cache_epoch = Some(uuid::Uuid::new_v4().to_string());
            self.coverage_changed = true;
        }
        let limit = if self.complete_items {
            MAX_COMPLETE_ITEMS
        } else {
            100
        };
        while self.items.len() > limit || self.item_bytes > MAX_ITEMS_BYTES {
            let Some(first) = self.item_order.pop_front() else {
                break;
            };
            if let Some(previous) = self.items.remove(&first) {
                self.item_bytes -= serde_json::to_vec(&previous).map_or(0, |v| v.len());
                self.forget_complete_turn(previous["turn_id"].as_str());
            }
        }
    }
    fn forget_complete_turn(&mut self, removed: Option<&str>) {
        let before = self.authoritative_turns.len();
        self.authoritative_turns
            .retain(|turn| Some(turn.as_str()) != removed);
        self.coverage_changed |= before != self.authoritative_turns.len();
    }
    fn remember_hydrated_turn(&mut self, turn: &str) {
        if self.hydrated_turns.contains(turn) {
            return;
        }
        if self.hydrated_turns.len() >= MAX_REMOVED_IDENTITIES
            || self.hydrated_turn_bytes + turn.len() > MAX_REMOVED_BYTES
        {
            self.hydrated_turns_overflow = true;
            return;
        }
        self.hydrated_turn_bytes += turn.len();
        self.hydrated_turns.insert(turn.to_owned());
    }
    fn parse_cursor(&self, cursor: &str) -> Option<u64> {
        let (epoch, seq) = cursor.rsplit_once(':')?;
        (epoch == self.epoch).then(|| seq.parse().ok()).flatten()
    }
    fn complete_turns(&self, turns: &[(String, Vec<String>)]) -> Vec<String> {
        turns
            .iter()
            .filter(|(_, ids)| {
                !ids.is_empty()
                    && ids.iter().all(|id| {
                        self.items
                            .get(id)
                            .is_some_and(|item| item["truncated"] != true)
                    })
            })
            .map(|(turn, _)| turn.clone())
            .collect()
    }
    fn envelope(&self, boot: &str, session: &str, kind: &str, payload: Value) -> Value {
        serde_json::to_value(agentkib_protocol::SessionStreamEvent {
            protocol_version: agentkib_protocol::CONVERSATION_PROTOCOL_VERSION,
            subscription_id: String::new(),
            session_id: session.into(),
            runtime_boot_id: boot.into(),
            epoch: self.epoch.clone(),
            seq: self.seq,
            cursor: self.cursor(),
            event_type: kind.into(),
            payload,
        })
        .expect("session event is JSON serializable")
    }
    fn push(&mut self, boot: &str, session: &str, kind: &str, payload: Value) {
        self.flush_text(boot, session);
        self.push_event(boot, session, kind, payload);
        if std::mem::take(&mut self.coverage_changed) && kind != "snapshot" {
            self.push_event(boot, session, "snapshot", self.snapshot_payload(true));
        }
    }
    fn push_event(&mut self, boot: &str, session: &str, kind: &str, payload: Value) {
        self.seq += 1;
        let event = self.envelope(boot, session, kind, payload);
        let size = serde_json::to_vec(&event).map_or(MAX_REPLAY_BYTES + 1, |bytes| bytes.len());
        self.bytes += size;
        self.replay.push_back((event, size));
        while self.replay.len() > MAX_EVENTS || self.bytes > MAX_REPLAY_BYTES {
            if let Some((_, size)) = self.replay.pop_front() {
                self.bytes -= size;
            } else {
                break;
            }
        }
    }
    fn flush_text(&mut self, boot: &str, session: &str) -> bool {
        let Some(batch) = self.pending_text.take() else {
            return false;
        };
        self.push_event(boot, session, "text-delta", json!({"itemId":batch.item,"turnId":batch.turn,"text":batch.text,"offset":batch.offset,"ephemeral":batch.ephemeral}));
        if let Some(revision) = batch.revision {
            self.push_event(boot, session, "state", json!({"revision":revision}));
        }
        true
    }
    fn queue_text(&mut self, boot: &str, session: &str, batch: TextBatch) {
        if let Some(pending) = &mut self.pending_text
            && pending.item == batch.item
            && pending.turn == batch.turn
            && pending.ephemeral == batch.ephemeral
            && pending.offset + pending.text.encode_utf16().count() == batch.offset
            && pending.text.len() + batch.text.len() <= MAX_TEXT_BATCH_BYTES
            && pending.deadline > Instant::now()
            && !self.coverage_changed
        {
            pending.text.push_str(&batch.text);
            return;
        }
        // Different items and replacements are barriers between append batches.
        // Each batch keeps the deadline established by its first fragment.
        self.flush_text(boot, session);
        self.pending_text = Some(batch);
        if self.coverage_changed
            || self
                .pending_text
                .as_ref()
                .is_some_and(|pending| pending.text.len() >= MAX_TEXT_BATCH_BYTES)
        {
            self.flush_text(boot, session);
            if std::mem::take(&mut self.coverage_changed) {
                self.push_event(boot, session, "snapshot", self.snapshot_payload(true));
            }
        }
    }
}

fn with_subscription(mut event: Value, id: &str) -> Value {
    event["subscriptionId"] = json!(id);
    event
}

impl Publisher {
    /// A recovered native connection starts a new projection epoch. Keep the
    /// delivery sequence monotonic so existing subscriptions receive the baseline.
    pub fn restart(
        &self,
        live: Value,
        items: Vec<Value>,
        turns: &[(String, Vec<String>)],
        removed: &[String],
    ) {
        self.restart_inner(live, items, turns, removed, None);
    }

    /// A full native read replaces the live projection once, without replaying
    /// old items as newly completed output or discarding paged history.
    pub fn hydrate(
        &self,
        live: Value,
        items: Vec<Value>,
        turns: &[(String, Vec<String>)],
        retained: &[String],
    ) {
        self.restart_inner(live, items, turns, &[], Some(retained));
    }

    fn restart_inner(
        &self,
        mut live: Value,
        items: Vec<Value>,
        turns: &[(String, Vec<String>)],
        removed: &[String],
        retained: Option<&[String]>,
    ) {
        live["sessionId"] = json!(self.session);
        live["runtimeBootId"] = json!(self.hub.0.boot);
        live["executionMode"] = json!(self.mode);
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.source(&self.session) else {
            return;
        };
        let seq = source.seq;
        let removed_turns = std::mem::take(&mut source.removed_turns);
        let removed_items = std::mem::take(&mut source.removed_items);
        let history_cache_epoch = source.history_cache_epoch.take();
        let mut removed = removed.to_vec();
        let mut history_reset = false;
        if let Some(retained) = retained {
            let retained: BTreeSet<_> = retained.iter().collect();
            removed.extend(
                source
                    .hydrated_turns
                    .iter()
                    .filter(|turn| !retained.contains(turn))
                    .cloned(),
            );
            history_reset = source.hydrated_turns_overflow
                || retained.len() > MAX_REMOVED_IDENTITIES
                || retained.iter().map(|turn| turn.len()).sum::<usize>() > MAX_REMOVED_BYTES;
        }
        *source = Source::new();
        source.seq = seq;
        source.removed_turns = removed_turns;
        source.removed_items = removed_items;
        source.history_cache_epoch = history_cache_epoch;
        if history_reset {
            // Turn identity tracking is bounded too. Once it overflows, a
            // fresh history read is required rather than silently losing a
            // deletion outside the retained item tail.
            source.history_cache_epoch = Some(uuid::Uuid::new_v4().to_string());
        }
        source.live = live;
        for item in items {
            if let Some(id) = item["id"].as_str() {
                source.retain_item(id, item.clone());
            }
        }
        source.authoritative_turns = source.complete_turns(turns);
        if let Some(retained) = retained {
            for turn in retained {
                source.remember_hydrated_turn(turn);
                source.removed_turns.remove(turn);
            }
            // hydrate() accepts coverage only from explicit native item arrays.
            source.authoritative_turns.extend(
                turns
                    .iter()
                    .filter(|(turn, ids)| ids.is_empty() && source.hydrated_turns.contains(turn))
                    .map(|(turn, _)| turn.clone()),
            );
        }
        source.preserve_items_outside_coverage = true;
        source.record_removed(&removed, &[]);
        source.push(
            &self.hub.0.boot,
            &self.session,
            "snapshot",
            source.snapshot_payload(true),
        );
        if retained.is_some()
            && !self.session.is_empty()
            && let Some(catalog) = state.sources.get_mut("")
        {
            catalog.push(
                &self.hub.0.boot,
                "",
                "invalidate",
                json!({"domains":["catalog"]}),
            );
        }
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }

    // Source state and its sequence are committed under one small in-memory lock.
    // No native I/O, stdout write, or callback runs under this lock.
    pub fn observe(&self, live: Value) {
        self.observe_inner(live, false);
    }

    pub fn observe_if_absent(&self, live: Value) {
        self.observe_inner(live, true);
    }

    fn observe_inner(&self, mut live: Value, only_if_absent: bool) {
        live["sessionId"] = json!(self.session);
        live["runtimeBootId"] = json!(self.hub.0.boot);
        if !self.mode.is_empty() {
            live["executionMode"] = json!(self.mode);
        }
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if only_if_absent && state.sources.contains_key(&self.session) {
            return;
        }
        let Some(source) = state.source(&self.session) else {
            return;
        };
        let old = &source.live;
        let mut changed = serde_json::Map::new();
        if let Some(fields) = live.as_object() {
            for (key, value) in fields {
                if old.get(key) != Some(value) {
                    changed.insert(key.clone(), value.clone());
                }
            }
        }
        let previous_text = old["streamText"].as_str().unwrap_or("");
        let next_text = live["streamText"].as_str().unwrap_or("");
        if old["turnId"] == live["turnId"]
            && next_text.starts_with(previous_text)
            && next_text.len() > previous_text.len()
        {
            // Native adapters publish append events with a stable item identity.
            // Keep the aggregate only for bootstrap/legacy snapshot recovery.
            changed.remove("streamText");
        }
        let completed = old["status"] != "idle" && live["status"] == "idle";
        let catalog_changed = [
            "status",
            "title",
            "approvals",
            "questions",
            "reason",
            "executionMode",
            "sendEnabled",
            "stopEnabled",
        ]
        .iter()
        .any(|key| old[*key] != live[*key]);
        if let Some(fields) = old.as_object() {
            for key in fields.keys().filter(|key| live.get(*key).is_none()) {
                changed.insert(key.clone(), Value::Null);
            }
        }
        source.live = live;
        if !changed.is_empty() {
            // Native adapters publish a revision around every text update.
            // Retain its actual latest value in that short batch; approvals,
            // failures, completion and all other state changes flush at once.
            if changed.len() == 1
                && let Some(revision) = changed.get("revision")
                && let Some(batch) = &mut source.pending_text
            {
                batch.revision = Some(revision.clone());
            } else {
                source.push(
                    &self.hub.0.boot,
                    &self.session,
                    "state",
                    Value::Object(changed),
                );
            }
        }
        if completed {
            source.push(
                &self.hub.0.boot,
                &self.session,
                "invalidate",
                json!({"domains":["history","catalog","queue","usage","goal","settings"]}),
            );
        }
        if catalog_changed
            && !self.session.is_empty()
            && let Some(catalog) = state.sources.get_mut("")
        {
            catalog.push(
                &self.hub.0.boot,
                "",
                "invalidate",
                json!({"domains":["catalog"]}),
            );
        }
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }

    pub fn item(&self, mut item: Value) {
        if item["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("live:"))
        {
            item["ephemeral"] = json!(true);
        }
        if let Some(content) = item["content"]
            .as_str()
            .filter(|content| content.len() > MAX_ITEM_TEXT_BYTES)
        {
            let bounded = bounded_text(content).0.to_owned();
            item["content"] = json!(bounded);
            item["truncated"] = json!(true);
        }
        let Some(id) = item["id"].as_str() else {
            return;
        };
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.source(&self.session) else {
            return;
        };
        if source.items.get(id) == Some(&item) {
            return;
        }
        source.retain_item(id, item.clone());
        source.push(&self.hub.0.boot, &self.session, "item-upsert", item);
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }

    /// Native item identity survives partial text, completion and reconnect.
    /// Offset is UTF-16 code units, matching JavaScript string slicing.
    pub fn item_text(&self, id: &str, turn: Option<&str>, text: &str) {
        self.item_text_with_identity(id, turn, text, id.starts_with("live:"));
    }
    pub fn item_text_with_identity(
        &self,
        id: &str,
        turn: Option<&str>,
        text: &str,
        ephemeral: bool,
    ) {
        if text.is_empty() {
            return;
        }
        let (bounded, truncated) = bounded_text(text);
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.source(&self.session) else {
            return;
        };
        let previous = source
            .items
            .get(id)
            .and_then(|item| item["content"].as_str())
            .unwrap_or("");
        let previous_truncated = source
            .items
            .get(id)
            .is_some_and(|item| item["truncated"] == true);
        if previous == bounded && previous_truncated == truncated {
            return;
        }
        let event = (!truncated || previous_truncated)
            .then(|| bounded.strip_prefix(previous))
            .flatten()
            .map(|delta| TextBatch {
                item: id.into(),
                turn: turn.map(str::to_owned),
                text: delta.into(),
                offset: previous.encode_utf16().count(),
                ephemeral,
                deadline: Instant::now() + TEXT_BATCH_DELAY,
                revision: None,
            });
        let item = json!({"id":id,"kind":"agent-message","turn_id":turn,"content":bounded,"attachment_count":0,"truncated":truncated,"ephemeral":ephemeral});
        let previous_seq = source.seq;
        let previous_deadline = source.pending_text.as_ref().map(|batch| batch.deadline);
        source.retain_item(id, item.clone());
        if let Some(delta) = event {
            source.queue_text(&self.hub.0.boot, &self.session, delta);
        } else {
            source.push(&self.hub.0.boot, &self.session, "item-upsert", item);
        }
        let published = previous_seq != source.seq;
        let scheduled =
            source.pending_text.as_ref().map(|batch| batch.deadline) != previous_deadline;
        drop(state);
        if published {
            let _ = self.hub.0.wake.try_send(());
        }
        if scheduled {
            let _ = self.hub.0.batch_wake.try_send(());
        }
    }

    /// An acknowledged native replay is complete within this explicit budget.
    /// Never turn an over-budget replay into a falsely complete truncated tail.
    pub fn replace_items(&self, items: Vec<Value>) -> Result<()> {
        ensure!(
            items.len() <= MAX_COMPLETE_ITEMS,
            "native-replay-item-limit"
        );
        ensure!(
            serde_json::to_vec(&items)?.len() <= MAX_ITEMS_BYTES,
            "native-replay-byte-limit"
        );
        let mut ids = BTreeSet::new();
        for item in &items {
            let id = item["id"].as_str().context("native-replay-item-id")?;
            ensure!(ids.insert(id), "native-replay-duplicate-item");
        }
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let source = state
            .source(&self.session)
            .context("session-stream-unavailable")?;
        source.items.clear();
        source.item_order.clear();
        source.item_bytes = 0;
        source.complete_items = true;
        source.authoritative_turns.clear();
        source.preserve_items_outside_coverage = false;
        for item in items {
            let id = item["id"].as_str().expect("validated item ID").to_owned();
            source.item_bytes += serde_json::to_vec(&item)?.len();
            source.item_order.push_back(id.clone());
            source.removed_items.remove(&id);
            if let Some(turn) = item["turn_id"].as_str() {
                source.removed_turns.remove(turn);
            }
            source.items.insert(id, item);
        }
        source.push(
            &self.hub.0.boot,
            &self.session,
            "snapshot",
            source.snapshot_payload(true),
        );
        drop(state);
        let _ = self.hub.0.wake.try_send(());
        Ok(())
    }

    pub fn alias_item(&self, previous: &str, native: &str) {
        if previous == native {
            return;
        }
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.sources.get_mut(&self.session) else {
            return;
        };
        if !source.items.contains_key(previous) {
            return;
        }
        let items = source
            .item_order
            .iter()
            .filter_map(|id| source.items.get(id))
            .map(|item| {
                let mut item = item.clone();
                if item["id"] == previous {
                    item["id"] = json!(native);
                    item["ephemeral"] = json!(false);
                }
                item
            })
            .collect();
        self.replace_locked(source, items, None, Some(&[previous.into()]));
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }

    fn replace_locked(
        &self,
        source: &mut Source,
        items: Vec<Value>,
        removed: Option<&[String]>,
        removed_items: Option<&[String]>,
    ) {
        source.items.clear();
        source.item_order.clear();
        source.item_bytes = 0;
        for item in items {
            if let Some(id) = item["id"].as_str() {
                source.retain_item(id, item.clone());
            }
        }
        source.preserve_items_outside_coverage =
            !source.complete_items && (removed.is_some() || removed_items.is_some());
        source.record_removed(
            removed.unwrap_or_default(),
            removed_items.unwrap_or_default(),
        );
        let payload = source.snapshot_payload(true);
        source.push(&self.hub.0.boot, &self.session, "snapshot", payload);
    }

    pub fn retain_turns(&self, turns: &[&str]) {
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.sources.get_mut(&self.session) else {
            return;
        };
        source
            .authoritative_turns
            .retain(|turn| turns.contains(&turn.as_str()));
        let mut removed: Vec<String> = source
            .items
            .values()
            .filter_map(|item| item["turn_id"].as_str())
            .filter(|turn| !turns.contains(turn))
            .map(str::to_owned)
            .collect();
        removed.sort();
        removed.dedup();
        let items: Vec<_> = source
            .item_order
            .iter()
            .filter_map(|id| source.items.get(id))
            .filter(|item| {
                item["turn_id"]
                    .as_str()
                    .is_none_or(|id| turns.contains(&id))
            })
            .cloned()
            .collect();
        if items.len() == source.items.len() {
            return;
        }
        self.replace_locked(source, items, Some(&removed), None);
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }
    pub fn remove_turns(&self, turns: &[String]) {
        if turns.is_empty() {
            return;
        }
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.source(&self.session) else {
            return;
        };
        let items: Vec<_> = source
            .item_order
            .iter()
            .filter_map(|id| source.items.get(id))
            .filter(|item| {
                item["turn_id"]
                    .as_str()
                    .is_none_or(|id| !turns.iter().any(|removed| removed == id))
            })
            .cloned()
            .collect();
        source.items.clear();
        source.item_order.clear();
        source.item_bytes = 0;
        for item in items {
            if let Some(id) = item["id"].as_str() {
                source.retain_item(id, item.clone());
            }
        }
        source
            .authoritative_turns
            .retain(|turn| !turns.contains(turn));
        source.preserve_items_outside_coverage = !source.complete_items;
        source.record_removed(turns, &[]);
        source.push(
            &self.hub.0.boot,
            &self.session,
            "snapshot",
            source.snapshot_payload(true),
        );
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }

    pub fn authoritative_turns(&self, turns: &[(String, Vec<String>)]) {
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = state.sources.get_mut(&self.session) else {
            return;
        };
        let complete = source.complete_turns(turns);
        if source.authoritative_turns == complete && source.preserve_items_outside_coverage {
            return;
        }
        source.authoritative_turns = complete;
        // Cache eviction and text truncation are not native deletions. Only
        // complete turns may replace the reader's fuller persisted history.
        source.preserve_items_outside_coverage = true;
        source.push(
            &self.hub.0.boot,
            &self.session,
            "snapshot",
            source.snapshot_payload(true),
        );
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }

    pub fn invalidate(&self, domains: &[&str]) {
        let mut state = self.hub.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(source) = state.sources.get_mut(&self.session) {
            source.push(
                &self.hub.0.boot,
                &self.session,
                "invalidate",
                json!({"domains":domains}),
            );
        }
        if domains.contains(&"catalog")
            && !self.session.is_empty()
            && let Some(catalog) = state.sources.get_mut("")
        {
            catalog.push(
                &self.hub.0.boot,
                "",
                "invalidate",
                json!({"domains":["catalog"]}),
            );
        }
        drop(state);
        let _ = self.hub.0.wake.try_send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_revision_updates_coalesce_with_contiguous_item_text_in_both_call_orders() {
        for observe_first in [false, true] {
            let hub = Hub::new("boot".into(), |_| true);
            let publisher = hub.publisher("s", "test");
            publisher
                .observe(json!({"status":"running","revision":0,"turnId":"t","streamText":""}));
            let baseline = hub.subscribe("s", None).unwrap();
            let mut deadline = None;
            for (index, text) in ["🙂", "🙂好", "🙂好!"].into_iter().enumerate() {
                let live =
                    json!({"status":"running","revision":index + 1,"turnId":"t","streamText":text});
                if observe_first {
                    publisher.observe(live.clone());
                }
                publisher.item_text("message", Some("t"), text);
                if !observe_first {
                    publisher.observe(live);
                }
                let state = hub.0.state.lock().unwrap();
                let pending = state.sources["s"].pending_text.as_ref().unwrap();
                if let Some(first) = deadline {
                    assert_eq!(
                        pending.deadline, first,
                        "new tokens cannot extend the deadline"
                    );
                } else {
                    deadline = Some(pending.deadline);
                }
            }
            // Resumption is also an atomic flush barrier, without waiting for
            // the timer. Native control revisions retain their actual value.
            let replay = hub.subscribe("s", baseline["cursor"].as_str()).unwrap();
            let events = replay["events"].as_array().unwrap();
            let deltas: Vec<_> = events
                .iter()
                .filter(|event| event["type"] == "text-delta")
                .collect();
            assert_eq!(deltas.len(), 1);
            assert_eq!(deltas[0]["payload"]["text"], "🙂好!");
            assert_eq!(deltas[0]["payload"]["offset"], 0);
            assert_eq!(events.last().unwrap()["payload"]["revision"], 3);
            assert!(
                hub.0.state.lock().unwrap().sources["s"]
                    .pending_text
                    .is_none()
            );
            publisher.item_text("message", Some("t"), "🙂好!後");
            let next = hub.subscribe("s", replay["cursor"].as_str()).unwrap();
            assert_eq!(next["events"][0]["payload"]["offset"], 4);
            assert_eq!(next["events"][0]["payload"]["text"], "後");
        }
    }

    #[test]
    fn pending_text_flushes_before_approval_question_failure_and_completion() {
        for next in [
            json!({"status":"awaiting-approval","approvals":[{"requestId":"approval"}]}),
            json!({"status":"waiting-input","questions":[{"requestId":"question"}]}),
            json!({"status":"running","reason":"transport-disconnected"}),
            json!({"status":"idle"}),
        ] {
            let hub = Hub::new("boot".into(), |_| true);
            let publisher = hub.publisher("s", "test");
            publisher.observe(json!({"status":"running"}));
            let baseline = hub.subscribe("s", None).unwrap();
            publisher.item_text("message", Some("t"), "before interaction");
            publisher.observe(next.clone());
            {
                let state = hub.0.state.lock().unwrap();
                assert!(state.sources["s"].pending_text.is_none());
                assert!(state.sources["s"].seq > baseline["events"][0]["seq"].as_u64().unwrap());
            }
            let replay = hub.subscribe("s", baseline["cursor"].as_str()).unwrap();
            assert_eq!(replay["events"][0]["type"], "text-delta");
            assert_eq!(replay["events"][0]["payload"]["text"], "before interaction");
            assert_eq!(replay["events"][1]["type"], "state");
            if next["status"] != "running" {
                assert_eq!(replay["events"][1]["payload"]["status"], next["status"]);
            } else {
                assert_eq!(replay["events"][1]["payload"]["reason"], next["reason"]);
            }
            if next["status"] == "idle" {
                assert_eq!(replay["events"][2]["type"], "invalidate");
            }
        }
    }

    #[test]
    fn interleaved_items_and_completion_keep_their_native_order() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        let baseline = hub.subscribe("s", None).unwrap();
        publisher.item_text("a", Some("t"), "A");
        publisher.item_text("b", Some("t"), "B");
        publisher.item_text("a", Some("t"), "AA");
        publisher
            .item(json!({"id":"a","kind":"agent-message","turn_id":"t","content":"AA complete"}));
        let replay = hub.subscribe("s", baseline["cursor"].as_str()).unwrap();
        let events = replay["events"].as_array().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0]["payload"]["itemId"], "a");
        assert_eq!(events[1]["payload"]["itemId"], "b");
        assert_eq!(events[2]["payload"]["itemId"], "a");
        assert_eq!(events[2]["payload"]["offset"], 1);
        assert_eq!(events[3]["type"], "item-upsert");
        assert_eq!(events[3]["payload"]["content"], "AA complete");
        for adjacent in events.windows(2) {
            assert_eq!(
                adjacent[1]["seq"].as_u64().unwrap(),
                adjacent[0]["seq"].as_u64().unwrap() + 1
            );
        }
    }

    #[test]
    fn subscription_flush_is_an_atomic_baseline_and_replay_boundary() {
        let (tx, rx) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| tx.send(event).is_ok());
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        let existing = hub.subscribe("s", None).unwrap();
        publisher.item_text("message", Some("t"), "first");
        let joining = hub.subscribe("s", None).unwrap();
        assert_eq!(
            joining["events"][0]["payload"]["items"][0]["content"],
            "first"
        );
        let flushed = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(flushed["subscriptionId"], existing["subscriptionId"]);
        assert_eq!(flushed["cursor"], joining["cursor"]);
        publisher.item_text("message", Some("t"), "first second");
        for _ in 0..2 {
            let next = rx.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(next["payload"]["offset"], 5);
            assert_eq!(next["payload"]["text"], " second");
        }
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn batch_deadline_is_bounded_and_timer_flush_does_not_wait_for_a_slow_sink() {
        assert!(TEXT_BATCH_DELAY <= Duration::from_millis(50));
        let (entered, sink) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| {
            entered.send(event).is_ok() && wait.recv().is_ok()
        });
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        let subscription = hub.subscribe("s", None).unwrap();
        publisher.item(json!({"id":"tool","kind":"tool-summary"}));
        sink.recv_timeout(Duration::from_secs(1)).unwrap();
        publisher.item_text("message", Some("t"), "buffered while stdout is blocked");
        let deadline = hub.0.state.lock().unwrap().sources["s"]
            .pending_text
            .as_ref()
            .unwrap()
            .deadline;
        // Check publication separately from the intentionally blocked delivery.
        // A wide observation budget avoids asserting OS scheduler timing.
        while hub.0.state.lock().unwrap().sources["s"]
            .pending_text
            .is_some()
        {
            assert!(Instant::now() < deadline + Duration::from_secs(1));
            std::thread::sleep(Duration::from_millis(1));
        }
        let state = hub.0.state.lock().unwrap();
        assert_eq!(
            state.sources["s"].replay.back().unwrap().0["type"],
            "text-delta"
        );
        drop(state);
        hub.unsubscribe(subscription["subscriptionId"].as_str().unwrap());
        release.send(()).unwrap();
        publisher.item_text(
            "message",
            Some("t"),
            "buffered while stdout is blocked and continues",
        );
        let resumed = hub.subscribe("s", None).unwrap();
        assert_eq!(
            resumed["events"][0]["payload"]["items"][1]["content"],
            "buffered while stdout is blocked and continues"
        );
    }

    #[test]
    fn text_batch_byte_limit_flushes_without_losing_offsets() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        let baseline = hub.subscribe("s", None).unwrap();
        let first = "x".repeat(MAX_TEXT_BATCH_BYTES - 1);
        publisher.item_text("message", Some("t"), &first);
        publisher.item_text("message", Some("t"), &format!("{first}yz"));
        let state = hub.0.state.lock().unwrap();
        let source = &state.sources["s"];
        assert_eq!(source.pending_text.as_ref().unwrap().text, "yz");
        assert!(source.pending_text.as_ref().unwrap().text.len() <= MAX_TEXT_BATCH_BYTES);
        drop(state);
        let replay = hub.subscribe("s", baseline["cursor"].as_str()).unwrap();
        assert_eq!(replay["events"][0]["payload"]["text"], first);
        assert_eq!(replay["events"][1]["payload"]["text"], "yz");
        assert_eq!(
            replay["events"][1]["payload"]["offset"],
            MAX_TEXT_BATCH_BYTES - 1
        );
    }

    #[test]
    fn subscriptions_pin_only_their_session_until_the_last_cancellation() {
        let hub = Hub::new("boot".into(), |_| true);
        hub.subscribe("", None).unwrap();
        hub.publisher("session", "test")
            .observe(json!({"status":"idle"}));
        assert!(!hub.has_subscribers("session"));
        let first = hub.subscribe("session", None).unwrap();
        let second = hub.subscribe("session", None).unwrap();
        assert!(hub.has_subscribers("session"));
        assert!(!hub.has_subscribers("other-session"));
        hub.unsubscribe(first["subscriptionId"].as_str().unwrap());
        assert!(hub.has_subscribers("session"));
        hub.unsubscribe(second["subscriptionId"].as_str().unwrap());
        assert!(!hub.has_subscribers("session"));
        assert!(hub.has_subscribers(""));
    }
    #[test]
    fn recovered_epoch_replaces_existing_subscribers_and_old_cursors() {
        let (tx, rx) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| tx.send(event).is_ok());
        let publisher = hub.publisher("s", "codex-follower");
        publisher.observe(json!({"status":"running","revision":40}));
        publisher.item_text("old-item", Some("old-turn"), "old owner");
        let baseline = hub.subscribe("s", None).unwrap();
        publisher.restart(
            json!({"status":"running","revision":1}),
            vec![json!({"id":"new-item","kind":"agent-message","turn_id":"new-turn","content":"new owner"})],
            &[("new-turn".into(), vec!["new-item".into()])],
            &["old-turn".into()],
        );
        let event = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(event["type"], "snapshot");
        assert_eq!(event["subscriptionId"], baseline["subscriptionId"]);
        assert_ne!(event["epoch"], baseline["events"][0]["epoch"]);
        assert!(event["seq"].as_u64() > baseline["events"][0]["seq"].as_u64());
        assert_eq!(event["payload"]["removedTurnIds"], json!(["old-turn"]));
        assert_eq!(event["payload"]["preserveItemsOutsideCoverage"], true);
        assert_eq!(
            event["payload"]["authoritativeTurnIds"],
            json!(["new-turn"])
        );
        let restored = hub.subscribe("s", baseline["cursor"].as_str()).unwrap();
        assert_eq!(restored["events"][0]["type"], "snapshot");
        assert_eq!(restored["events"][0]["epoch"], event["epoch"]);
        assert_eq!(
            restored["events"][0]["payload"]["preserveItemsOutsideCoverage"],
            true
        );
        assert_eq!(
            restored["events"][0]["payload"]["items"],
            event["payload"]["items"]
        );
        assert_eq!(
            restored["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn hydrated_turn_identity_overflow_requires_history_recovery_and_stays_bounded() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "codex-managed");
        let retained: Vec<String> = (0..MAX_REMOVED_IDENTITIES + 1)
            .map(|index| format!("turn-{index}"))
            .collect();
        let turns: Vec<_> = retained.iter().map(|turn| (turn.clone(), vec![])).collect();
        publisher.hydrate(json!({"status":"idle"}), vec![], &turns, &retained);
        let first = hub.subscribe("s", None).unwrap();
        let first_payload = &first["events"][0]["payload"];
        assert!(first_payload["historyCacheEpoch"].is_string());
        assert_eq!(
            first_payload["authoritativeTurnIds"]
                .as_array()
                .unwrap()
                .len(),
            MAX_REMOVED_IDENTITIES
        );
        {
            let state = hub.0.state.lock().unwrap();
            let source = &state.sources["s"];
            assert!(source.hydrated_turns.len() <= MAX_REMOVED_IDENTITIES);
            assert!(source.hydrated_turn_bytes <= MAX_REMOVED_BYTES);
            assert!(source.hydrated_turns_overflow);
        }
        // The removed turn may have been the identity beyond the tracking
        // budget; silently keeping the previous cache generation is unsafe.
        publisher.hydrate(json!({"status":"idle"}), vec![], &[], &[]);
        let next = hub.subscribe("s", None).unwrap();
        assert_ne!(
            next["events"][0]["payload"]["historyCacheEpoch"],
            first_payload["historyCacheEpoch"]
        );
        publisher.hydrate(
            json!({"status":"idle"}),
            vec![],
            &[("turn-0".into(), vec![])],
            &["turn-0".into()],
        );
        let restored = hub.subscribe("s", None).unwrap();
        let payload = &restored["events"][0]["payload"];
        assert_eq!(payload["authoritativeTurnIds"], json!(["turn-0"]));
        assert!(
            !payload["removedTurnIds"]
                .as_array()
                .unwrap()
                .contains(&json!("turn-0"))
        );
    }
    #[test]
    fn hydrated_complete_turn_loses_coverage_when_live_output_exceeds_the_cache() {
        for truncated in [false, true] {
            let hub = Hub::new("boot".into(), |_| true);
            let publisher = hub.publisher("s", "codex-managed");
            let items: Vec<_> = (0..100).map(|index| json!({"id":format!("item-{index}"),"turn_id":"turn","content":"history"})).collect();
            let ids = items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned())
                .collect();
            publisher.hydrate(
                json!({"status":"running"}),
                items,
                &[("turn".into(), ids)],
                &["turn".into()],
            );
            let before = hub.subscribe("s", None).unwrap();
            assert_eq!(
                before["events"][0]["payload"]["authoritativeTurnIds"],
                json!(["turn"])
            );
            if truncated {
                publisher.item_text(
                    "item-99",
                    Some("turn"),
                    &"x".repeat(MAX_ITEM_TEXT_BYTES + 1),
                );
            } else {
                publisher.item(json!({"id":"item-100","turn_id":"turn","content":"new output"}));
            }
            let after = hub.subscribe("s", before["cursor"].as_str()).unwrap();
            let snapshot = after["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|event| event["type"] == "snapshot")
                .unwrap();
            assert_eq!(snapshot["payload"]["authoritativeTurnIds"], json!([]));
            assert_eq!(snapshot["payload"]["preserveItemsOutsideCoverage"], true);
            assert!(snapshot["payload"]["removedTurnIds"].is_null());
        }
    }
    #[test]
    fn event_delivery_replay_and_utf16_offsets() {
        let (tx, rx) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| tx.send(event).is_ok());
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running","turnId":"t","streamText":"🙂"}));
        publisher.item_text("message", Some("t"), "🙂");
        let first = hub.subscribe("s", None).unwrap();
        assert_eq!(first["events"][0]["type"], "snapshot");
        publisher.item_text("message", Some("t"), "🙂好");
        publisher.observe(json!({"status":"running","turnId":"t","streamText":"🙂好"}));
        let event = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(event["type"], "text-delta");
        assert_eq!(event["payload"]["offset"], 2);
        assert_eq!(event["payload"]["itemId"], "message");
        let replay = hub.subscribe("s", first["cursor"].as_str()).unwrap();
        assert_eq!(replay["events"][0]["seq"], event["seq"]);
        assert_eq!(
            hub.unsubscribe(first["subscriptionId"].as_str().unwrap())["removed"],
            true
        );
    }
    #[test]
    fn bootstrap_preserves_item_order_and_completion_identity() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        publisher.item_text("z", Some("t"), "one");
        publisher.item_text("a", Some("t"), "two");
        publisher.item(json!({"id":"z","kind":"agent-message","content":"one complete"}));
        let baseline = hub.subscribe("s", None).unwrap();
        assert_eq!(baseline["events"][0]["payload"]["items"][0]["id"], "z");
        assert_eq!(baseline["events"][0]["payload"]["items"][1]["id"], "a");
        assert_eq!(
            baseline["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for index in 0..120 {
            publisher.item(json!({"id":format!("item-{index}"),"content":"x".repeat(32768)}));
        }
        let state = hub.0.state.lock().unwrap();
        let source = &state.sources["s"];
        assert!(source.item_bytes <= MAX_ITEMS_BYTES);
        assert!(!source.items.contains_key("z"));
        assert_eq!(source.item_order.back().unwrap(), "item-119");
    }
    #[test]
    fn truncated_streams_are_explicit_and_rollback_replaces_only_known_turns() {
        let (tx, rx) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| tx.send(event).is_ok());
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        publisher.item_text("message", Some("turn"), &"x".repeat(128 * 1024));
        hub.subscribe("s", None).unwrap();
        publisher.item_text("message", Some("turn"), &"x".repeat(128 * 1024 + 1));
        let event = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(event["type"], "item-upsert");
        assert_eq!(event["payload"]["truncated"], true);
        publisher.authoritative_turns(&[("turn".into(), vec!["message".into()])]);
        let event = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(event["payload"]["authoritativeTurnIds"], json!([]));
        publisher.remove_turns(&["turn".into()]);
        let event = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(event["payload"]["removedTurnIds"], json!(["turn"]));
        assert_eq!(event["payload"]["preserveItemsOutsideCoverage"], true);
        assert_eq!(event["payload"]["items"], json!([]));
    }

    #[test]
    fn truncation_and_eviction_cannot_claim_complete_turn_coverage() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "codex-follower");
        publisher.observe(json!({"status":"running"}));
        let turns = vec![("turn".into(), vec!["message".into()])];
        publisher.item_text("message", Some("turn"), "complete preview");
        publisher.authoritative_turns(&turns);
        assert_eq!(
            hub.subscribe("s", None).unwrap()["events"][0]["payload"]["authoritativeTurnIds"],
            json!(["turn"])
        );
        publisher.item_text(
            "message",
            Some("turn"),
            &"界".repeat(MAX_ITEM_TEXT_BYTES / 3 + 1),
        );
        publisher.authoritative_turns(&turns);
        let truncated = hub.subscribe("s", None).unwrap();
        let payload = &truncated["events"][0]["payload"];
        assert_eq!(payload["authoritativeTurnIds"], json!([]));
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert_eq!(payload["items"][0]["truncated"], true);

        // Reconnect applies the byte limit before deciding whether it can
        // replace a turn, even when the incoming native item claims no clipping.
        publisher.restart(
            json!({"status":"idle"}),
            vec![json!({"id":"message","turn_id":"turn","content":"x".repeat(MAX_ITEM_TEXT_BYTES + 1),"truncated":false})],
            &turns,
            &[],
        );
        let restarted = hub.subscribe("s", None).unwrap();
        assert_eq!(
            restarted["events"][0]["payload"]["authoritativeTurnIds"],
            json!([])
        );
        assert_eq!(
            restarted["events"][0]["payload"]["items"][0]["truncated"],
            true
        );

        let mut ids = Vec::new();
        for index in 0..10 {
            let id = format!("large-{index}");
            publisher.item(json!({"id":id,"turn_id":"large-turn","content":"x".repeat(MAX_ITEM_TEXT_BYTES),"truncated":false}));
            ids.push(id);
        }
        publisher.authoritative_turns(&[("large-turn".into(), ids)]);
        let bounded = hub.subscribe("s", None).unwrap();
        let payload = &bounded["events"][0]["payload"];
        assert_eq!(payload["authoritativeTurnIds"], json!([]));
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert!(payload["items"].as_array().unwrap().len() < 10);
        assert!(serde_json::to_vec(&payload["items"]).unwrap().len() <= MAX_ITEMS_BYTES);
        assert!(payload["removedTurnIds"].is_null());
        let state = hub.0.state.lock().unwrap();
        assert!(state.sources["s"].item_bytes <= MAX_ITEMS_BYTES);
        assert!(state.sources["s"].bytes <= MAX_REPLAY_BYTES);
    }
    #[test]
    fn bounded_coverage_and_native_removal_are_distinct_from_identity_replacement() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "codex-follower");
        publisher.observe(json!({"status":"running"}));
        let mut first_turn = Vec::new();
        for index in 0..101 {
            let id = format!("item-{index}");
            publisher.item(json!({"id":id,"turn_id":"first","content":"old"}));
            first_turn.push(id);
        }
        publisher.item(json!({"id":"new","turn_id":"second","content":"new"}));
        let before = hub.subscribe("s", None).unwrap();
        publisher.authoritative_turns(&[
            ("first".into(), first_turn),
            ("second".into(), vec!["new".into()]),
        ]);
        let after = hub.subscribe("s", before["cursor"].as_str()).unwrap();
        let payload = &after["events"][0]["payload"];
        assert_eq!(payload["replaceItems"], true);
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert_eq!(payload["authoritativeTurnIds"], json!(["second"]));
        assert_eq!(payload["items"].as_array().unwrap().len(), 100);
        assert!(payload["removedTurnIds"].is_null());
        assert_eq!(
            hub.subscribe("s", None).unwrap()["events"][0]["payload"]["preserveItemsOutsideCoverage"],
            true
        );

        publisher.retain_turns(&["first"]);
        let retained = hub.subscribe("s", after["cursor"].as_str()).unwrap();
        let payload = &retained["events"][0]["payload"];
        assert_eq!(payload["removedTurnIds"], json!(["second"]));
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert_eq!(payload["items"].as_array().unwrap().len(), 99);

        publisher.alias_item("item-100", "canonical");
        let aliased = hub.subscribe("s", retained["cursor"].as_str()).unwrap();
        let payload = &aliased["events"][0]["payload"];
        assert_eq!(payload["replaceItems"], true);
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert_eq!(payload["removedItemIds"], json!(["item-100"]));
        let items = payload["items"].as_array().unwrap();
        assert!(items.iter().any(|item| item["id"] == "canonical"));
        assert!(!items.iter().any(|item| item["id"] == "item-100"));
    }
    #[test]
    fn complete_native_replay_keeps_more_than_one_hundred_items_in_delivery_and_baseline() {
        let (tx, rx) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| tx.send(event).is_ok());
        let publisher = hub.publisher("s", "acp-managed");
        publisher.observe(json!({"status":"running"}));
        for index in 0..150 {
            publisher.item(json!({"id":format!("live:old:{index}"),"kind":"agent-message","content":"temporary"}));
        }
        let before = hub.subscribe("s", None).unwrap();
        let native: Vec<_> = (0..200).map(|index| json!({"id":format!("native-{index}"),"kind":"agent-message","turn_id":format!("turn-{index}"),"content":if index == 0 { "x".repeat(160 * 1024) } else { "persisted".into() }})).collect();
        publisher.replace_items(native.clone()).unwrap();
        let event = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(event["type"], "snapshot");
        assert_eq!(event["payload"]["items"], json!(native));
        assert_eq!(event["payload"]["replaceItems"], true);
        assert_ne!(event["payload"]["preserveItemsOutsideCoverage"], true);
        assert!(serde_json::to_vec(&event).unwrap().len() < MAX_REPLAY_BYTES);
        hub.unsubscribe(before["subscriptionId"].as_str().unwrap());
        let baseline = hub.subscribe("s", None).unwrap();
        assert_eq!(baseline["events"][0]["payload"]["items"], json!(native));
        assert_eq!(baseline["events"][0]["payload"]["replaceItems"], true);
        publisher.item(json!({"id":"live:next:user","kind":"user-message","content":"next"}));
        publisher.alias_item("live:next:user", "native-user");
        let aliased = hub.subscribe("s", None).unwrap();
        let payload = &aliased["events"][0]["payload"];
        assert_eq!(payload["items"].as_array().unwrap().len(), 201);
        assert_eq!(payload["items"][0]["content"], native[0]["content"]);
        assert_eq!(payload["items"][200]["id"], "native-user");
        assert_eq!(payload["replaceItems"], true);
        assert_ne!(payload["preserveItemsOutsideCoverage"], true);
        assert!(
            payload["removedItemIds"]
                .as_array()
                .unwrap()
                .contains(&json!("live:next:user"))
        );
    }

    #[test]
    fn over_budget_complete_replay_preserves_the_existing_projection() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "acp-managed");
        publisher.observe(json!({"status":"idle"}));
        publisher.item_text("live:kept", Some("turn"), "still visible");
        let before = hub.subscribe("s", None).unwrap();
        for items in [
            (0..MAX_COMPLETE_ITEMS + 1)
                .map(|index| json!({"id":index.to_string()}))
                .collect(),
            vec![json!({"id":"large","content":"x".repeat(MAX_ITEMS_BYTES)})],
        ] {
            assert!(publisher.replace_items(items).is_err());
            let after = hub.subscribe("s", None).unwrap();
            assert_eq!(after["cursor"], before["cursor"]);
            assert_eq!(
                after["events"][0]["payload"]["items"],
                before["events"][0]["payload"]["items"]
            );
        }
        publisher
            .replace_items(
                (0..MAX_COMPLETE_ITEMS)
                    .map(|index| json!({"id":index.to_string(),"content":"canonical"}))
                    .collect(),
            )
            .unwrap();
        publisher.item(json!({"id":"newest","content":"live"}));
        let downgraded = hub.subscribe("s", None).unwrap();
        let payload = &downgraded["events"][0]["payload"];
        assert_eq!(payload["items"].as_array().unwrap().len(), 100);
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert!(payload["historyCacheEpoch"].is_string());
    }

    #[test]
    fn missed_deletions_remain_in_baselines_and_recovered_epochs() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "codex-follower");
        publisher.observe(json!({"status":"running"}));
        publisher.item(json!({"id":"deleted-item","turn_id":"deleted-turn"}));
        publisher.item(json!({"id":"temporary","turn_id":"kept-turn"}));
        publisher.remove_turns(&["deleted-turn".into()]);
        publisher.alias_item("temporary", "canonical");
        for recovered in [false, true] {
            if recovered {
                publisher.restart(
                    json!({"status":"idle"}),
                    vec![json!({"id":"canonical","turn_id":"kept-turn"})],
                    &[("kept-turn".into(), vec!["canonical".into()])],
                    &[],
                );
            }
            let baseline = hub.subscribe("s", None).unwrap();
            let payload = &baseline["events"][0]["payload"];
            assert_eq!(payload["removedTurnIds"], json!(["deleted-turn"]));
            assert_eq!(payload["removedItemIds"], json!(["temporary"]));
            assert_eq!(payload["items"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn removal_budget_overflow_advances_a_persistent_history_cache_epoch() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"idle"}));
        publisher.remove_turns(
            &(0..MAX_REMOVED_IDENTITIES + 1)
                .map(|index| format!("turn-{index}"))
                .collect::<Vec<_>>(),
        );
        let first = hub.subscribe("s", None).unwrap();
        let epoch = first["events"][0]["payload"]["historyCacheEpoch"].clone();
        assert!(epoch.is_string());
        assert!(first["events"][0]["payload"]["removedTurnIds"].is_null());
        publisher.remove_turns(&["next-deleted".into()]);
        let baseline = hub.subscribe("s", None).unwrap();
        assert_eq!(baseline["events"][0]["payload"]["historyCacheEpoch"], epoch);
        assert_eq!(
            baseline["events"][0]["payload"]["removedTurnIds"],
            json!(["next-deleted"])
        );
        // The byte limit is independent of the number of retained identities.
        publisher.remove_turns(
            &(0..1100)
                .map(|index| format!("{index}:{}", "x".repeat(250)))
                .collect::<Vec<_>>(),
        );
        let next = hub.subscribe("s", None).unwrap();
        assert_ne!(next["events"][0]["payload"]["historyCacheEpoch"], epoch);
        assert!(next["events"][0]["payload"]["removedTurnIds"].is_null());
        assert!(serde_json::to_vec(&next).unwrap().len() < 4 * 1024 * 1024);
    }

    #[test]
    fn slow_sink_cannot_block_native_updates_or_unsubscribe() {
        let (entered, sink) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let hub = Hub::new("boot".into(), move |event| {
            entered.send(event).is_ok() && wait.recv().is_ok()
        });
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"running"}));
        let first = hub.subscribe("s", None).unwrap();
        let second = hub.subscribe("s", None).unwrap();
        publisher.item_text("message", Some("t"), "first");
        sink.recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        // The dispatcher is blocked by stdout, but state and control threads
        // only append to a bounded replay. No native reader waits for output.
        for revision in 0..MAX_EVENTS + 10 {
            publisher.observe(json!({"status":"running","revision":revision}));
        }
        assert_eq!(
            hub.unsubscribe(first["subscriptionId"].as_str().unwrap())["removed"],
            true
        );
        release.send(()).unwrap();
        let overflow = sink
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        assert_eq!(overflow["subscriptionId"], second["subscriptionId"]);
        assert_eq!(overflow["type"], "resync-required");
        hub.unsubscribe(second["subscriptionId"].as_str().unwrap());
        release.send(()).unwrap();
        publisher.item_text("message", Some("t"), "first still executing");
        let recovered = hub.subscribe("s", None).unwrap();
        assert_eq!(
            recovered["events"][0]["payload"]["items"][0]["content"],
            "first still executing"
        );
    }
    #[test]
    fn overflow_bootstraps_without_a_persistent_token_log() {
        let hub = Hub::new("boot".into(), |_| true);
        let publisher = hub.publisher("s", "test");
        publisher.observe(json!({"status":"idle"}));
        let first = hub.subscribe("s", None).unwrap();
        hub.unsubscribe(first["subscriptionId"].as_str().unwrap());
        for revision in 0..MAX_EVENTS + 10 {
            publisher.observe(json!({"status":"idle","revision":revision}));
        }
        let next = hub.subscribe("s", first["cursor"].as_str()).unwrap();
        assert_eq!(next["events"][0]["type"], "snapshot");
        assert!(hub.0.state.lock().unwrap().sources["s"].replay.len() <= MAX_EVENTS);
    }
}
