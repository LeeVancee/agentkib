//! One stdout owner prevents JSON frames interleaving and keeps session events
//! flowing while the main request dispatcher performs synchronous work.
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    sync::mpsc,
};

pub(crate) struct Output {
    responses: mpsc::SyncSender<Frame>,
    notifications: mpsc::SyncSender<Frame>,
    wake: mpsc::SyncSender<()>,
    frame: Vec<u8>,
}
struct Frame {
    bytes: Vec<u8>,
    flushed: Option<mpsc::SyncSender<io::Result<()>>>,
}
impl Output {
    pub fn new() -> Self {
        Self::with_writer(io::stdout)
    }
    fn with_writer<W: Write>(writer: impl FnOnce() -> W + Send + 'static) -> Self {
        let (responses, response_rx) = mpsc::sync_channel::<Frame>(1);
        let (notifications, notification_rx) = mpsc::sync_channel::<Frame>(32);
        let (wake, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut stdout = writer();
            while receiver.recv().is_ok() {
                loop {
                    // Control receipts must not wait behind a token burst.
                    let frame = response_rx
                        .try_recv()
                        .or_else(|_| notification_rx.try_recv());
                    let Ok(frame) = frame else { break };
                    let result = stdout.write_all(&frame.bytes).and_then(|_| stdout.flush());
                    let failed = result.is_err();
                    if let Some(flushed) = frame.flushed {
                        let _ = flushed.send(result);
                    }
                    if failed {
                        return;
                    }
                }
            }
        });
        Self {
            responses,
            notifications,
            wake,
            frame: Vec::new(),
        }
    }
    pub fn notifications(&self) -> impl Fn(Value) -> bool + Send + 'static {
        let sender = self.notifications.clone();
        let wake = self.wake.clone();
        move |event| {
            let frame = json!({"jsonrpc":"2.0","method":agentkib_protocol::SESSION_EVENT_NOTIFICATION,"params":event});
            let Ok(mut bytes) = serde_json::to_vec(&frame) else {
                return false;
            };
            bytes.push(b'\n');
            let sent = sender
                .send(Frame {
                    bytes,
                    flushed: None,
                })
                .is_ok();
            let _ = wake.try_send(());
            sent
        }
    }
}
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.frame.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.frame.is_empty() {
            return Ok(());
        }
        let (flushed, result) = mpsc::sync_channel(1);
        self.responses
            .send(Frame {
                bytes: std::mem::take(&mut self.frame),
                flushed: Some(flushed),
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "runtime output closed"))?;
        let _ = self.wake.try_send(());
        result
            .recv()
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "runtime output closed"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Sink(mpsc::Sender<Vec<u8>>);
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.send(bytes.to_vec()).unwrap();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn independent_writer_prioritizes_receipts_and_keeps_frames_whole() {
        let (start, waiting) = mpsc::channel();
        let (written, output) = mpsc::channel();
        let writer = Output::with_writer(move || {
            waiting.recv().unwrap();
            Sink(written)
        });
        let notify = writer.notifications();
        assert!(notify(json!({"seq":1})));
        assert!(notify(json!({"seq":2})));
        let (ack, received) = mpsc::sync_channel(1);
        writer
            .responses
            .send(Frame {
                bytes: b"{\"id\":1}\n".to_vec(),
                flushed: Some(ack),
            })
            .unwrap();
        start.send(()).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(
                &output
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .unwrap()
            )
            .unwrap()["id"],
            1
        );
        received
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap();
        for seq in [1, 2] {
            let frame = output
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap();
            assert_eq!(frame.last(), Some(&b'\n'));
            let json: Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(
                json["method"],
                agentkib_protocol::SESSION_EVENT_NOTIFICATION
            );
            assert_eq!(json["params"]["seq"], seq);
        }
    }
}
