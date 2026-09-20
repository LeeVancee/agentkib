//! Dedicated I/O thread adapter for synchronous runtime/provider consumers.
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

use tokio::sync::mpsc as async_mpsc;

use crate::{Error, Event, Result, RpcId, StdioClient};

enum Operation {
    Initialize,
    List {
        cwd: Option<PathBuf>,
        cursor: Option<String>,
    },
    New(PathBuf),
    Load {
        id: String,
        cwd: PathBuf,
        replay: bool,
    },
    Prompt {
        id: String,
        text: String,
    },
    Cancel(String),
    Permission {
        id: RpcId,
        option: Option<String>,
    },
    Shutdown,
}

struct Command {
    operation: Operation,
    deadline: Instant,
    reply: mpsc::SyncSender<Result<Option<RpcId>>>,
}

/// Cloneable command handle with a single shared event stream.
///
/// One consumer must continuously drain `next_event`, including during prompts.
/// Responses are correlated by request ID; session/load replay precedes its reply.
/// The queue is bounded: an undrained stream closes the worker rather than losing
/// events or approving tools. Callers own durable transcript/snapshot persistence.
#[derive(Clone)]
pub struct BlockingClient {
    commands: async_mpsc::Sender<Command>,
    events: Arc<Mutex<mpsc::Receiver<Result<Event>>>>,
    timeout: Duration,
}

impl BlockingClient {
    /// Spawns only the given executable, without downloading or logging in.
    /// Initialization is explicit so callers can inspect its full response.
    pub fn spawn(
        executable: &Path,
        args: &[OsString],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Self> {
        if timeout.is_zero() {
            return Err(Error::Invalid("timeout must be positive"));
        }
        let executable = executable.to_owned();
        let args = args.to_vec();
        let cwd = cwd.to_owned();
        let (commands, receiver) = async_mpsc::channel::<Command>(32);
        let (event_sender, events) = mpsc::sync_channel(128);
        let (started, ready) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("antigravity-acp".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = started.send(Err(Error::Io(error)));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let client = match StdioClient::spawn(&executable, &args, &cwd) {
                        Ok(client) => client,
                        Err(error) => {
                            let _ = started.send(Err(error));
                            return;
                        }
                    };
                    if started.send(Ok(())).is_err() {
                        return;
                    }
                    run(client, receiver, event_sender, timeout).await;
                });
            })?;
        ready.recv_timeout(timeout).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => Error::Timeout,
            mpsc::RecvTimeoutError::Disconnected => Error::Closed,
        })??;
        Ok(Self {
            commands,
            events: Arc::new(Mutex::new(events)),
            timeout,
        })
    }

    pub fn initialize(&self) -> Result<RpcId> {
        self.request(Operation::Initialize)
    }
    pub fn list_sessions(&self, cwd: Option<&Path>, cursor: Option<&str>) -> Result<RpcId> {
        self.request(Operation::List {
            cwd: cwd.map(Path::to_owned),
            cursor: cursor.map(str::to_owned),
        })
    }
    pub fn new_session(&self, cwd: &Path) -> Result<RpcId> {
        self.request(Operation::New(cwd.to_owned()))
    }
    pub fn load_session(&self, id: &str, cwd: &Path) -> Result<RpcId> {
        self.request(Operation::Load {
            id: id.to_owned(),
            cwd: cwd.to_owned(),
            replay: true,
        })
    }
    pub fn resume_session(&self, id: &str, cwd: &Path) -> Result<RpcId> {
        self.request(Operation::Load {
            id: id.to_owned(),
            cwd: cwd.to_owned(),
            replay: false,
        })
    }
    pub fn prompt(&self, id: &str, text: &str) -> Result<RpcId> {
        self.request(Operation::Prompt {
            id: id.to_owned(),
            text: text.to_owned(),
        })
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.dispatch(Operation::Cancel(id.to_owned())).map(|_| ())
    }
    pub fn respond_permission(&self, id: &RpcId, option: Option<&str>) -> Result<()> {
        self.dispatch(Operation::Permission {
            id: id.clone(),
            option: option.map(str::to_owned),
        })
        .map(|_| ())
    }
    pub fn shutdown(&self) -> Result<()> {
        self.dispatch(Operation::Shutdown).map(|_| ())
    }

    /// `None` means no event arrived during the timeout, not session completion.
    pub fn next_event(&self, timeout: Duration) -> Result<Option<Event>> {
        let receiver = self.events.lock().map_err(|_| Error::Closed)?;
        match receiver.recv_timeout(timeout) {
            Ok(event) => event.map(Some),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(Error::Closed),
        }
    }

    fn request(&self, operation: Operation) -> Result<RpcId> {
        self.dispatch(operation)?
            .ok_or(Error::Protocol("missing request id"))
    }

    fn dispatch(&self, operation: Operation) -> Result<Option<RpcId>> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.commands
            .try_send(Command {
                operation,
                deadline: Instant::now() + self.timeout,
                reply,
            })
            .map_err(|error| match error {
                async_mpsc::error::TrySendError::Full(_) => Error::Invalid("command queue is full"),
                async_mpsc::error::TrySendError::Closed(_) => Error::Closed,
            })?;
        receive
            .recv_timeout(self.timeout)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => Error::Timeout,
                mpsc::RecvTimeoutError::Disconnected => Error::Closed,
            })?
    }
}

async fn run(
    mut client: StdioClient,
    mut commands: async_mpsc::Receiver<Command>,
    events: mpsc::SyncSender<Result<Event>>,
    timeout: Duration,
) {
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break; };
                if command.deadline <= Instant::now() {
                    let _ = command.reply.send(Err(Error::Timeout));
                    break;
                }
                let stop = matches!(command.operation, Operation::Shutdown);
                let duration = command.deadline.saturating_duration_since(Instant::now());
                let result = tokio::time::timeout(duration, execute(&mut client, command.operation)).await.unwrap_or(Err(Error::Timeout));
                let timed_out = matches!(result, Err(Error::Timeout));
                if command.reply.send(result).is_err() || stop || timed_out { break; }
            }
            event = client.next_event() => {
                let failed = event.is_err();
                if events.try_send(event).is_err() || failed { break; }
            }
        }
    }
    let _ = tokio::time::timeout(timeout, client.shutdown()).await;
}

async fn execute(client: &mut StdioClient, operation: Operation) -> Result<Option<RpcId>> {
    match operation {
        Operation::Initialize => client.initialize().await.map(Some),
        Operation::List { cwd, cursor } => client
            .list_sessions(cwd.as_deref(), cursor.as_deref())
            .await
            .map(Some),
        Operation::New(cwd) => client.new_session(&cwd).await.map(Some),
        Operation::Load { id, cwd, replay } => {
            if replay {
                client.load_session(&id, &cwd).await.map(Some)
            } else {
                client.resume_session(&id, &cwd).await.map(Some)
            }
        }
        Operation::Prompt { id, text } => client.prompt(&id, &text).await.map(Some),
        Operation::Cancel(id) => client.cancel(&id).await.map(|_| None),
        Operation::Permission { id, option } => client
            .respond_permission(&id, option.as_deref())
            .await
            .map(|_| None),
        Operation::Shutdown => client.shutdown().await.map(|_| None),
    }
}
