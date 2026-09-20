use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use agentkib_protocol::{RpcRequest, RpcResponse};
use serde_json::{Value, json};

const QUEUE_CAPACITY: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

type Executor = dyn Fn(RpcRequest, Instant, &AtomicBool) -> RpcResponse + Send + 'static;

struct Work {
    request: RpcRequest,
    deadline: Instant,
}

pub(super) struct Worker {
    sender: Option<mpsc::SyncSender<Box<Work>>>,
    stopping: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    timeout: Duration,
}

impl Worker {
    pub(super) fn new(
        completed: impl Fn(RpcResponse) + Send + 'static,
        execute: impl Fn(RpcRequest, Instant, &AtomicBool) -> RpcResponse + Send + 'static,
    ) -> Self {
        Self::with_timeout(REQUEST_TIMEOUT, completed, execute)
    }

    fn with_timeout(
        timeout: Duration,
        completed: impl Fn(RpcResponse) + Send + 'static,
        execute: impl Fn(RpcRequest, Instant, &AtomicBool) -> RpcResponse + Send + 'static,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Box<Work>>(QUEUE_CAPACITY);
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = Arc::clone(&stopping);
        let execute: Box<Executor> = Box::new(execute);
        let handle = thread::spawn(move || {
            while let Ok(work) = receiver.recv() {
                if worker_stopping.load(Ordering::SeqCst) {
                    completed(unavailable_response(work.request.id));
                    continue;
                }
                if Instant::now() >= work.deadline {
                    completed(deadline_response(work.request.id));
                    continue;
                }
                completed(execute(work.request, work.deadline, &worker_stopping));
            }
        });
        Self {
            sender: Some(sender),
            stopping,
            handle: Some(handle),
            timeout,
        }
    }

    pub(super) fn submit(&self, request: RpcRequest) -> Option<RpcResponse> {
        let id = request.id.clone();
        if self.stopping.load(Ordering::SeqCst) {
            return Some(unavailable_response(id));
        }
        let work = Box::new(Work {
            request,
            deadline: Instant::now() + self.timeout,
        });
        match self.sender.as_ref().map(|sender| sender.try_send(work)) {
            Some(Ok(())) => None,
            Some(Err(mpsc::TrySendError::Full(_))) => Some(RpcResponse::error(
                id,
                -32000,
                "skill-busy",
                Some(json!({ "detail": "The Skill worker queue is full" })),
            )),
            _ => Some(unavailable_response(id)),
        }
    }

    pub(super) fn shutdown(&mut self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        self.sender.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn unavailable_response(id: Value) -> RpcResponse {
    RpcResponse::error(
        id,
        -32000,
        "skill-unavailable",
        Some(json!({ "detail": "The Skill worker is shutting down" })),
    )
}

fn deadline_response(id: Value) -> RpcResponse {
    RpcResponse::error(
        id,
        -32000,
        "AgentKib command failed",
        Some(json!({
            "detail": "Skill request exceeded the 180 second queue deadline"
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn request(id: u64) -> RpcRequest {
        RpcRequest {
            jsonrpc: "2.0".into(),
            id: id.into(),
            method: "skills.test".into(),
            params: Value::Null,
        }
    }

    fn success(request: RpcRequest) -> RpcResponse {
        RpcResponse::success(request.id, Value::Null)
    }

    #[test]
    fn worker_is_serial_and_submit_does_not_wait_for_execution() {
        let (completed_tx, completed_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let max_active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut worker = Worker::with_timeout(
            Duration::from_secs(1),
            move |response| completed_tx.send(response).unwrap(),
            {
                let release_rx = Arc::clone(&release_rx);
                let active = Arc::clone(&active);
                let max_active = Arc::clone(&max_active);
                move |request, _, _| {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(current, Ordering::SeqCst);
                    started_tx.send(request.id.clone()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                    success(request)
                }
            },
        );

        assert!(worker.submit(request(1)).is_none());
        assert_eq!(started_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        let before = Instant::now();
        assert!(worker.submit(request(2)).is_none());
        assert!(before.elapsed() < Duration::from_millis(100));
        release_tx.send(()).unwrap();
        assert_eq!(started_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
        release_tx.send(()).unwrap();
        let first = completed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let second = completed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first.id, 1);
        assert_eq!(second.id, 2);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        worker.shutdown();
    }

    #[test]
    fn worker_allows_one_running_and_eight_queued_requests() {
        let (completed_tx, _completed_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let mut worker = Worker::with_timeout(
            Duration::from_secs(1),
            move |response| completed_tx.send(response).unwrap(),
            move |request, _, _| {
                started_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
                success(request)
            },
        );

        assert!(worker.submit(request(0)).is_none());
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        for id in 1..=QUEUE_CAPACITY as u64 {
            assert!(worker.submit(request(id)).is_none());
        }
        let response = worker.submit(request(10)).expect("queue must be full");
        assert_eq!(response.error.unwrap().message, "skill-busy");

        for _ in 0..=QUEUE_CAPACITY {
            release_tx.send(()).unwrap();
        }
        worker.shutdown();
    }

    #[test]
    fn queued_deadline_is_measured_from_submission() {
        let (completed_tx, completed_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let mut worker = Worker::with_timeout(
            Duration::from_millis(40),
            move |response| completed_tx.send(response).unwrap(),
            move |request, deadline, _| {
                started_tx.send(request.id.clone()).unwrap();
                if request.id.as_u64() == Some(1) {
                    release_rx.lock().unwrap().recv().unwrap();
                }
                if Instant::now() >= deadline {
                    RpcResponse::error(request.id, -32000, "deadline", None)
                } else {
                    success(request)
                }
            },
        );

        assert!(worker.submit(request(1)).is_none());
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(worker.submit(request(2)).is_none());
        thread::sleep(Duration::from_millis(60));
        release_tx.send(()).unwrap();
        let _ = completed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let expired = completed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(expired.error.unwrap().message, "AgentKib command failed");
        assert!(started_rx.try_recv().is_err());
        worker.shutdown();
    }

    #[test]
    fn shutdown_cancels_running_work_and_rejects_the_queue_once() {
        let (completed_tx, completed_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let mut worker = Worker::with_timeout(
            Duration::from_secs(10),
            move |response| completed_tx.send(response).unwrap(),
            move |request, _, cancelled| {
                started_tx.send(()).unwrap();
                while !cancelled.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(2));
                }
                RpcResponse::error(request.id, -32000, "cancelled", None)
            },
        );

        assert!(worker.submit(request(1)).is_none());
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(worker.submit(request(2)).is_none());
        worker.shutdown();

        let responses = completed_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].error.as_ref().unwrap().message, "cancelled");
        assert_eq!(
            responses[1].error.as_ref().unwrap().message,
            "skill-unavailable"
        );
        assert!(worker.submit(request(3)).is_some());
    }

    #[test]
    fn shutdown_waits_for_a_started_local_operation() {
        let (completed_tx, completed_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut worker = Worker::with_timeout(
            Duration::from_secs(10),
            move |response| completed_tx.send(response).unwrap(),
            move |request, _, _| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                success(request)
            },
        );

        assert!(worker.submit(request(1)).is_none());
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let stopping = Arc::clone(&worker.stopping);
        let shutdown = thread::spawn(move || worker.shutdown());
        while !stopping.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        assert!(completed_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        shutdown.join().unwrap();

        let completed = completed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(completed.error.is_none());
        assert_eq!(completed.id, 1);
        assert!(completed_rx.try_recv().is_err());
    }
}
