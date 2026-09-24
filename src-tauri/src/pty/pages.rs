//! PTY events to the pages that show them, over one ordered IPC channel per page.
//!
//! **Why not `app.emit`.** Tauri 2 turns every emit into JSON pasted into a
//! script that the WebView compiles and runs on its main thread. For terminal
//! output that is the worst shape there is: every ESC byte turns into a
//! six-character JSON escape, a 256 KB chunk becomes a script of more than
//! 256 KB, and a visible terminal does it up to sixty times a second. A
//! `tauri::ipc::Channel` hands a payload of `RAW_FROM` bytes or more over as
//! the bytes themselves, which the page fetches as an `ArrayBuffer`: no
//! escaping here, nothing to compile there. A smaller one still goes as a
//! short script, because under that size a script is cheaper than a fetch
//! (and raw bytes that small would be pasted as a JSON array of numbers).
//!
//! **Why output, exit, heartbeat and idle share one channel.** A channel
//! delivers in order, but a fetched payload lands later than a script sent
//! after it. On the event bus nothing could overtake anything (one queue of
//! scripts); split across the bus and a channel, the exit that clears the
//! prompt tail and the announced addresses could run before the last chunk
//! that fed them, and the idle that reads that tail could read it short. On
//! one channel the page puts every message back in the order it was sent
//! (the channel's own index), so every listener sees what it saw before, in
//! the order it saw it.
//!
//! **Who gets what.** Every listener on the page is a subscription here, with
//! a number the page picked, and each message names the subscriptions it is
//! for (`to`): exactly the ones that held when it was sent. That is how the
//! event bus decided too (the listener ids were fixed at emit time, and the
//! page only skipped the ones that had unlistened since), and it matters: a
//! view that mounts while a chunk is on its way to the view it replaces must
//! not get that chunk, which its own snapshot already holds. A terminal no
//! subscription asks about costs nothing, as an event nobody listened to.
//!
//! **Pages come and go.** A reload is a new page with a new token: the first
//! link it opens closes the links the old page left behind on that webview.
//! A module reloaded in place (HMR) keeps the page's token, so its second
//! link lives next to the first.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::InvokeResponseBody;

use super::emit::PtyEvents;
use crate::events;

/// From this many bytes of text on, a chunk goes as raw bytes; under it, as
/// JSON. Tauri's own cut (`MAX_RAW_DIRECT_EXECUTE_THRESHOLD` in
/// `tauri::ipc::channel`): raw bytes under it are pasted into a script as a
/// JSON array of numbers, which is worse than the JSON string.
pub const RAW_FROM: usize = 1024;

/// Where a page's messages go. The real one is the page's `Channel`; the tests
/// plug in one that keeps what it was sent.
pub trait PageLink: Send + Sync + 'static {
    fn send(&self, body: InvokeResponseBody);
}

impl PageLink for tauri::ipc::Channel<InvokeResponseBody> {
    fn send(&self, body: InvokeResponseBody) {
        // Fails only once the webview is gone, and then nobody is listening.
        let _ = tauri::ipc::Channel::send(self, body);
    }
}

/// What one subscription listens to, as the page names it:
/// `{ "kind": "output", "id": "t1" }`, `{ "kind": "idle" }`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
pub enum Topic {
    Output(String),
    Exit(String),
    Activity(String),
    /// Idle is for every terminal, as the `pty://idle` event was.
    Idle,
}

/// Every open link, by the number `open` handed out.
#[derive(Default)]
pub struct Pages {
    links: Mutex<Links>,
}

#[derive(Default)]
struct Links {
    last: u64,
    open: HashMap<u64, Link>,
}

struct Link {
    /// Label of the webview the page lives in.
    webview: String,
    /// The page's token: one per document, the same across HMR.
    page: String,
    to: Box<dyn PageLink>,
    /// Subscription number (the page picks it) -> what it listens to.
    subs: HashMap<u64, Topic>,
}

impl Link {
    /// The subscriptions `wants` picks, in the order they were numbered.
    fn listening(&self, wants: impl Fn(&Topic) -> bool) -> Vec<u64> {
        let mut to: Vec<u64> = self
            .subs
            .iter()
            .filter(|(_, topic)| wants(topic))
            .map(|(sub, _)| *sub)
            .collect();
        to.sort_unstable();
        to
    }
}

/// What a message says. Externally tagged, so each payload keeps the exact
/// shape the event bus gave it (`"exit": { "id", "code", "reason" }`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Message<'a> {
    Output { id: &'a str, data: &'a str },
    Exit(&'a events::ExitPayload),
    Activity(&'a events::ActivityPayload),
    Idle(&'a events::IdlePayload),
}

/// A JSON message: the subscriptions it is for, next to what it says.
#[derive(Serialize)]
struct Envelope<'a> {
    to: &'a [u64],
    #[serde(flatten)]
    message: &'a Message<'a>,
}

/// The trailer of a raw chunk: who it is for and whose output it is.
#[derive(Serialize)]
struct Trailer<'a> {
    to: &'a [u64],
    id: &'a str,
}

impl Pages {
    /// Opens a link to `page` in `webview` and returns its number. Links that
    /// another page left in the same webview are closed: that page is gone.
    pub fn open(&self, webview: &str, page: &str, to: Box<dyn PageLink>) -> u64 {
        let mut links = self.links.lock();
        links
            .open
            .retain(|_, link| link.webview != webview || link.page == page);
        links.last += 1;
        let number = links.last;
        links.open.insert(
            number,
            Link {
                webview: webview.to_string(),
                page: page.to_string(),
                to,
                subs: HashMap::new(),
            },
        );
        number
    }

    /// Subscription `sub` of the page behind `link` listens to `topic` from
    /// now on. The page numbers it before asking, as `listen` made its
    /// callback id first: a message sent the moment this returns can reach the
    /// page before this answer does, and the page must already know who it is
    /// for.
    pub fn subscribe(&self, link: u64, sub: u64, topic: Topic) -> Result<(), String> {
        let mut links = self.links.lock();
        let Some(open) = links.open.get_mut(&link) else {
            return Err(format!("canal de eventos {link} nao existe mais"));
        };
        open.subs.insert(sub, topic);
        Ok(())
    }

    /// Subscription `sub` stops listening. Nothing to undo on a link that is
    /// already gone.
    pub fn unsubscribe(&self, link: u64, sub: u64) -> Result<(), String> {
        if let Some(open) = self.links.lock().open.get_mut(&link) {
            open.subs.remove(&sub);
        }
        Ok(())
    }

    /// `message` to the subscriptions `wants` picks, on every link that has any.
    fn to_listeners(&self, wants: impl Fn(&Topic) -> bool, message: &Message<'_>) {
        let links = self.links.lock();
        for link in links.open.values() {
            let to = link.listening(&wants);
            if to.is_empty() {
                continue;
            }
            // Cannot fail for these types; if it ever did, sending nothing
            // keeps the channel's order intact.
            if let Ok(json) = serde_json::to_string(&Envelope { to: &to, message }) {
                link.to.send(InvokeResponseBody::Json(json));
            }
        }
    }
}

/// One chunk of `id`'s output for the subscriptions `to` (see `RAW_FROM`), or
/// `None` in the one case serialization could fail, where sending nothing
/// keeps the channel's order intact.
///
/// The raw layout is the text's bytes, then the JSON `Trailer`, then the
/// trailer's length as a little-endian `u32`: the trailer goes after the text
/// so the text never moves, and the buffer the pump filled is the one that is
/// sent (appending a few bytes nearly always fits in the room it already has).
fn output_body(id: &str, data: String, to: &[u64]) -> Option<InvokeResponseBody> {
    if data.len() < RAW_FROM {
        let message = Message::Output { id, data: &data };
        let json = serde_json::to_string(&Envelope { to, message: &message }).ok()?;
        return Some(InvokeResponseBody::Json(json));
    }
    let trailer = serde_json::to_string(&Trailer { to, id }).ok()?;
    let mut bytes = data.into_bytes();
    bytes.extend_from_slice(trailer.as_bytes());
    bytes.extend_from_slice(&(trailer.len() as u32).to_le_bytes());
    Some(InvokeResponseBody::Raw(bytes))
}

impl PtyEvents for Pages {
    fn output(&self, id: &str, data: String) -> bool {
        let links = self.links.lock();
        let targets: Vec<(&Link, Vec<u64>)> = links
            .open
            .values()
            .map(|link| (link, link.listening(|topic| matches!(topic, Topic::Output(of) if of == id))))
            .filter(|(_, to)| !to.is_empty())
            .collect();
        // Nobody shows it: no body is built at all. The text itself goes to
        // the last link (nearly always the only one); the others get a copy.
        let Some(((last, last_to), rest)) = targets.split_last() else {
            return false;
        };
        for (link, to) in rest {
            if let Some(body) = output_body(id, data.clone(), to) {
                link.to.send(body);
            }
        }
        if let Some(body) = output_body(id, data, last_to) {
            last.to.send(body);
        }
        true
    }
    fn exit(&self, payload: events::ExitPayload) {
        let wants = |topic: &Topic| matches!(topic, Topic::Exit(of) if *of == payload.id);
        self.to_listeners(wants, &Message::Exit(&payload));
    }
    fn activity(&self, payload: events::ActivityPayload) {
        let wants = |topic: &Topic| matches!(topic, Topic::Activity(of) if *of == payload.id);
        self.to_listeners(wants, &Message::Activity(&payload));
    }
    fn idle(&self, payload: events::IdlePayload) {
        self.to_listeners(|topic| *topic == Topic::Idle, &Message::Idle(&payload));
    }
}

#[cfg(test)]
mod tests {
    //! What a page receives is the whole contract of this module: the text a
    //! terminal wrote, exact to the byte, in the order the engine produced it,
    //! and addressed to exactly the subscriptions that held when it was sent.
    //! A page that got a byte more, a byte less, a message out of order or one
    //! meant for a view already gone paints a broken screen, and nothing on
    //! the Rust side would ever notice.

    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    /// A page that keeps everything it was sent.
    #[derive(Clone, Default)]
    struct Page(Arc<Mutex<Vec<InvokeResponseBody>>>);

    impl PageLink for Page {
        fn send(&self, body: InvokeResponseBody) {
            self.0.lock().push(body);
        }
    }

    /// One message as the page received it, comparable in an assertion. A raw
    /// one is split along its layout: the text's bytes, and the JSON trailer.
    #[derive(Debug, PartialEq)]
    enum Got {
        Json(serde_json::Value),
        Raw { text: Vec<u8>, meta: serde_json::Value },
    }

    impl Page {
        fn got(&self) -> Vec<Got> {
            self.0
                .lock()
                .iter()
                .map(|body| match body {
                    InvokeResponseBody::Json(text) => {
                        Got::Json(serde_json::from_str(text).expect("a JSON message"))
                    }
                    InvokeResponseBody::Raw(bytes) => {
                        let (rest, len) = bytes.split_at(bytes.len() - 4);
                        let len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
                        let (text, meta) = rest.split_at(rest.len() - len);
                        Got::Raw {
                            text: text.to_vec(),
                            meta: serde_json::from_slice(meta).expect("a JSON trailer"),
                        }
                    }
                })
                .collect()
        }
    }

    fn output_of(id: &str) -> Topic {
        Topic::Output(id.to_string())
    }

    /// `head` padded with `x` to exactly `len` bytes.
    fn text_of(head: &str, len: usize) -> String {
        let mut text = head.to_string();
        text.push_str(&"x".repeat(len - head.len()));
        text
    }

    /// Everything a terminal paints that JSON has to escape, plus characters
    /// of every width.
    const AWKWARD: &str = "ação 😀 € \u{1b}[1;32mverde\u{1b}[0m \u{0}\u{7}\t\"\\\r\n\u{feff}";

    #[test]
    fn a_chunk_under_a_kibibyte_goes_as_json_naming_its_terminal_and_who_it_is_for() {
        let pages = Pages::default();
        let page = Page::default();
        let link = pages.open("main", "p1", Box::new(page.clone()));
        pages.subscribe(link, 5, output_of("t1")).unwrap();

        let text = text_of(AWKWARD, RAW_FROM - 1);
        pages.output("t1", text.clone());

        assert_eq!(
            page.got(),
            vec![Got::Json(json!({ "to": [5], "output": { "id": "t1", "data": text } }))]
        );
    }

    /// The layout the page parses (`ptyStream.ts`): the text's own bytes, then
    /// a JSON trailer naming the terminal and the subscriptions, then the
    /// trailer's length as a little-endian `u32`. The trailer goes after the
    /// text so the text never moves: the buffer the pump filled is the one
    /// that is sent.
    #[test]
    fn a_chunk_of_a_kibibyte_or_more_goes_as_its_own_bytes_with_who_it_is_for_after_them() {
        let pages = Pages::default();
        let page = Page::default();
        let link = pages.open("main", "p1", Box::new(page.clone()));
        pages.subscribe(link, 9, output_of("térm-1")).unwrap();

        let text = text_of(AWKWARD, RAW_FROM);
        pages.output("térm-1", text.clone());

        assert_eq!(
            page.got(),
            vec![Got::Raw { text: text.into_bytes(), meta: json!({ "to": [9], "id": "térm-1" }) }]
        );
    }

    /// A terminal nobody shows costs nothing, as an event nobody listened to
    /// did. And a message names the subscriptions that held **when it was
    /// sent**, as the event bus fixed its listeners at emit time: a view that
    /// mounts while a chunk is on its way to the view it replaces must not
    /// paint that chunk, which its own snapshot already holds.
    #[test]
    fn output_is_addressed_to_the_subscriptions_to_that_terminal_that_hold_when_it_is_sent() {
        let pages = Pages::default();
        let (a, b) = (Page::default(), Page::default());
        let one = pages.open("main", "p1", Box::new(a.clone()));
        let two = pages.open("main", "p1", Box::new(b.clone()));
        pages.subscribe(one, 1, output_of("t1")).unwrap();
        pages.subscribe(one, 2, output_of("t1")).unwrap();
        pages.subscribe(one, 3, Topic::Exit("t1".into())).unwrap();
        pages.subscribe(two, 1, output_of("t2")).unwrap();

        pages.output("t1", "um".into());
        pages.unsubscribe(one, 1).unwrap();
        pages.output("t1", "dois".into());
        pages.unsubscribe(one, 2).unwrap();
        pages.output("t1", "tres".into());
        pages.output("t9", "ninguem".into());

        assert_eq!(
            a.got(),
            vec![
                Got::Json(json!({ "to": [1, 2], "output": { "id": "t1", "data": "um" } })),
                Got::Json(json!({ "to": [2], "output": { "id": "t1", "data": "dois" } })),
            ]
        );
        assert_eq!(b.got(), vec![]);
    }

    /// Each payload inside is the event's own serialization, field for field:
    /// what the listeners read off the bus is what they read here.
    #[test]
    fn exit_activity_and_idle_reach_the_subscriptions_to_them_with_the_payload_the_event_carried() {
        let pages = Pages::default();
        let (a, b) = (Page::default(), Page::default());
        let one = pages.open("main", "p1", Box::new(a.clone()));
        let two = pages.open("main", "p1", Box::new(b.clone()));
        pages.subscribe(one, 1, Topic::Exit("t1".into())).unwrap();
        pages.subscribe(one, 2, Topic::Activity("t1".into())).unwrap();
        pages.subscribe(one, 3, Topic::Idle).unwrap();
        pages.subscribe(one, 4, Topic::Exit("t2".into())).unwrap();
        pages.subscribe(two, 1, Topic::Idle).unwrap();

        let exit = events::ExitPayload { id: "t1".into(), code: Some(3), reason: "normal".into() };
        let beat = events::ActivityPayload { id: "t1".into(), last_byte_at: 1_700_000_000_123, idle_ms: 450 };
        let idle = events::IdlePayload { id: "t9".into(), title: "claude: ação".into(), idle_ms: 4_600 };
        let (exit_json, beat_json, idle_json) = (
            serde_json::to_value(&exit).unwrap(),
            serde_json::to_value(&beat).unwrap(),
            serde_json::to_value(&idle).unwrap(),
        );
        pages.exit(exit);
        pages.activity(beat);
        pages.idle(idle);
        pages.activity(events::ActivityPayload { id: "t3".into(), last_byte_at: 1, idle_ms: 2 });

        // The shape the listeners read, spelled out once.
        assert_eq!(exit_json, json!({ "id": "t1", "code": 3, "reason": "normal" }));
        assert_eq!(
            a.got(),
            vec![
                Got::Json(json!({ "to": [1], "exit": exit_json })),
                Got::Json(json!({ "to": [2], "activity": beat_json })),
                Got::Json(json!({ "to": [3], "idle": idle_json })),
            ]
        );
        assert_eq!(b.got(), vec![Got::Json(json!({ "to": [1], "idle": idle_json }))]);
    }

    /// A reloaded page never says goodbye: its old callbacks are simply gone,
    /// and everything still sent to them lands in the new page as a warning
    /// about a callback it does not know. The new page's first link is the
    /// moment the old ones are known to be dead.
    #[test]
    fn a_new_page_on_the_same_webview_closes_the_links_of_the_page_before_it() {
        let pages = Pages::default();
        let (old, new, elsewhere) = (Page::default(), Page::default(), Page::default());
        let stale = pages.open("main", "antes", Box::new(old.clone()));
        pages.subscribe(stale, 1, output_of("t1")).unwrap();
        let other = pages.open("portal", "q1", Box::new(elsewhere.clone()));
        pages.subscribe(other, 1, output_of("t1")).unwrap();

        let fresh = pages.open("main", "depois", Box::new(new.clone()));
        pages.subscribe(fresh, 1, output_of("t1")).unwrap();
        pages.output("t1", "oi".into());

        let said = || Got::Json(json!({ "to": [1], "output": { "id": "t1", "data": "oi" } }));
        assert_eq!(old.got(), vec![]);
        assert_eq!(new.got(), vec![said()]);
        assert_eq!(elsewhere.got(), vec![said()]);
    }

    /// A module replaced in place (HMR) opens a second link from a page that
    /// is still alive, and whatever still holds the first copy of the module
    /// keeps listening through the first link.
    #[test]
    fn a_second_link_from_the_same_page_lives_next_to_the_first() {
        let pages = Pages::default();
        let (first, second) = (Page::default(), Page::default());
        let one = pages.open("main", "p1", Box::new(first.clone()));
        pages.subscribe(one, 1, output_of("t1")).unwrap();
        pages.open("main", "p1", Box::new(second.clone()));

        pages.output("t1", "oi".into());

        assert_eq!(
            first.got(),
            vec![Got::Json(json!({ "to": [1], "output": { "id": "t1", "data": "oi" } }))]
        );
        assert_eq!(second.got(), vec![]);
    }

    /// A subscription that succeeded on a closed link would leave a view
    /// waiting for messages that can no longer come; refused, it fails where
    /// the view can see it. Letting go of a closed link has nothing to undo.
    #[test]
    fn subscribing_through_a_link_that_is_gone_is_refused() {
        let pages = Pages::default();
        let gone = pages.open("main", "antes", Box::new(Page::default()));
        pages.open("main", "depois", Box::new(Page::default()));

        assert!(pages.subscribe(gone, 1, output_of("t1")).is_err());
        assert!(pages.subscribe(gone + 100, 1, Topic::Idle).is_err());
        assert!(pages.unsubscribe(gone, 1).is_ok());
    }

    /// The spelling `ptyStream.ts` sends to `pty_events_subscribe`.
    #[test]
    fn a_topic_is_read_as_the_page_spells_it() {
        let read = |text: &str| serde_json::from_str::<Topic>(text).ok();
        assert_eq!(read(r#"{"kind":"output","id":"t1"}"#), Some(output_of("t1")));
        assert_eq!(read(r#"{"kind":"exit","id":"t1"}"#), Some(Topic::Exit("t1".into())));
        assert_eq!(read(r#"{"kind":"activity","id":"t1"}"#), Some(Topic::Activity("t1".into())));
        assert_eq!(read(r#"{"kind":"idle"}"#), Some(Topic::Idle));
        assert_eq!(read(r#"{"kind":"output"}"#), None);
        assert_eq!(read(r#"{"kind":"nada","id":"t1"}"#), None);
    }
}
