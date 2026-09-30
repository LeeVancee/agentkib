//! macOS cleanup of a directly spawned child, including detached descendants.
//! IDs are bound to kernel birth timestamps. No command-name or orphan scan is used.
use std::{
    collections::BTreeMap,
    io, mem,
    process::Child,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    pid: i32,
    seconds: u64,
    micros: u64,
}
struct Info {
    identity: Identity,
    parent: i32,
    status: u32,
}
fn info(pid: i32) -> io::Result<Option<Info>> {
    let mut value: libc::proc_bsdinfo = unsafe { mem::zeroed() };
    let size = mem::size_of::<libc::proc_bsdinfo>();
    // libproc returns bytes, zero on error; do not treat a short read as absence.
    unsafe {
        *libc::__error() = 0;
    }
    let bytes = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut value as *mut libc::proc_bsdinfo).cast(),
            size as i32,
        )
    };
    if bytes == 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return Ok(None);
    }
    if bytes != size as i32 {
        return Err(io::Error::other("incomplete process identity"));
    }
    if value.pbi_pid != pid as u32
        || value.pbi_start_tvsec == 0
        || value.pbi_start_tvusec >= 1_000_000
    {
        return Err(io::Error::other("invalid process identity"));
    }
    Ok(Some(Info {
        identity: Identity {
            pid,
            seconds: value.pbi_start_tvsec,
            micros: value.pbi_start_tvusec,
        },
        parent: value.pbi_ppid as i32,
        status: value.pbi_status,
    }))
}
fn children(pid: i32) -> io::Result<Vec<i32>> {
    let mut capacity = 32;
    loop {
        let mut values = vec![0i32; capacity];
        unsafe {
            *libc::__error() = 0;
        }
        // proc_listchildpids takes bytes but returns a PID count (Apple libproc.c).
        let count = unsafe {
            libc::proc_listchildpids(
                pid,
                values.as_mut_ptr().cast(),
                (values.len() * mem::size_of::<i32>()) as i32,
            )
        };
        let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if count < 0 || (count == 0 && errno != 0) {
            return Err(io::Error::from_raw_os_error(if errno == 0 {
                libc::EIO
            } else {
                errno
            }));
        }
        if (count as usize) < values.len() {
            values.truncate(count as usize);
            if values.iter().any(|id| *id <= 1) {
                return Err(io::Error::other("invalid child PID"));
            }
            return Ok(values);
        }
        if capacity >= 4096 {
            return Err(io::Error::other("process tree exceeds cleanup capacity"));
        }
        capacity *= 2;
    }
}
fn alive(identity: &Identity) -> io::Result<bool> {
    Ok(info(identity.pid)?
        .is_some_and(|current| current.identity == *identity && current.status != libc::SZOMB))
}
fn signal(identity: &Identity, signal: i32) -> io::Result<()> {
    if !alive(identity)? {
        return Ok(());
    }
    if unsafe { libc::kill(identity.pid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

/// The root must be an unreaped `Child` owned by the caller. Birth checks reduce
/// PID reuse risk; macOS does not provide a pidfd-style atomic identity+signal API.
pub struct OwnedProcessTree {
    root: Identity,
    known: BTreeMap<i32, Identity>,
}
impl OwnedProcessTree {
    pub fn root_running(&self) -> io::Result<bool> {
        alive(&self.root)
    }

    pub fn attach(child: &Child) -> io::Result<Self> {
        let root = info(child.id() as i32)?
            .ok_or_else(|| io::Error::other("owned root disappeared"))?
            .identity;
        Ok(Self {
            known: BTreeMap::from([(root.pid, root.clone())]),
            root,
        })
    }
    /// Refresh while the parent is alive, before asking the CLI to interrupt.
    pub fn refresh(&mut self) -> io::Result<()> {
        if !alive(&self.root)? {
            return Err(io::Error::other(
                "owned root exited before complete capture",
            ));
        }
        let mut queue = vec![self.root.clone()];
        let mut offset = 0;
        while offset < queue.len() {
            let parent = queue[offset].clone();
            offset += 1;
            if !alive(&parent)? {
                return Err(io::Error::other("owned parent exited during capture"));
            }
            for pid in children(parent.pid)? {
                let Some(child) = info(pid)? else {
                    return Err(io::Error::other("child vanished during ownership capture"));
                };
                if child.parent != parent.pid || !alive(&parent)? {
                    return Err(io::Error::other("process parent changed during capture"));
                }
                self.known
                    .entry(pid)
                    .or_insert_with(|| child.identity.clone());
                if queue.iter().any(|id| id.pid == pid) {
                    continue;
                }
                queue.push(child.identity);
                if queue.len() > 4096 {
                    return Err(io::Error::other("process tree exceeds cleanup capacity"));
                }
            }
        }
        Ok(())
    }
    fn freeze(&mut self) -> io::Result<()> {
        // Freeze each verified parent before listing its children; once every
        // branch is frozen no member can fork between the final scan and kill.
        if !alive(&self.root)? {
            return Err(io::Error::other(
                "owned root exited before complete capture",
            ));
        }
        let mut queue = vec![self.root.clone()];
        queue.extend(
            self.known
                .values()
                .filter(|id| id.pid != self.root.pid)
                .cloned(),
        );
        let total_deadline = Instant::now() + Duration::from_secs(2);
        let mut frozen = BTreeMap::new();
        let mut offset = 0;
        while offset < queue.len() {
            if Instant::now() >= total_deadline {
                return Err(io::Error::other("process tree freeze deadline exceeded"));
            }
            let parent = queue[offset].clone();
            offset += 1;
            if frozen.contains_key(&parent.pid) {
                continue;
            }
            if !alive(&parent)? {
                return Err(io::Error::other(
                    "owned parent exited before frozen capture",
                ));
            }
            signal(&parent, libc::SIGSTOP)?;
            let deadline = total_deadline.min(Instant::now() + Duration::from_millis(300));
            loop {
                let current = info(parent.pid)?
                    .ok_or_else(|| io::Error::other("process disappeared before freeze"))?;
                if current.identity != parent {
                    return Err(io::Error::other("process identity changed before freeze"));
                }
                if current.status == libc::SSTOP {
                    break;
                }
                if current.status == libc::SZOMB || Instant::now() >= deadline {
                    return Err(io::Error::other("process freeze unconfirmed"));
                }
                thread::sleep(Duration::from_millis(5));
            }
            frozen.insert(parent.pid, parent.clone());
            for pid in children(parent.pid)? {
                let child = info(pid)?
                    .ok_or_else(|| io::Error::other("child vanished during frozen capture"))?;
                if child.parent != parent.pid {
                    return Err(io::Error::other("child ownership changed"));
                }
                if let Some(previous) = self.known.get(&pid) {
                    if *previous != child.identity {
                        return Err(io::Error::other("child PID reused"));
                    }
                } else {
                    self.known.insert(pid, child.identity.clone());
                }
                if !frozen.contains_key(&pid) {
                    queue.push(child.identity);
                }
                if self.known.len() > 4096 || queue.len() > 8192 {
                    return Err(io::Error::other("process tree exceeds cleanup capacity"));
                }
            }
        }
        Ok(())
    }
    /// Never reports success until every captured identity stopped executing.
    /// On a capture failure it still cleans known identities, but returns failure.
    pub fn terminate(&mut self, child: &mut Child) -> io::Result<()> {
        let mut failure = self.freeze().err();
        for identity in self.known.values().filter(|id| id.pid != self.root.pid) {
            if let Err(error) = signal(identity, libc::SIGKILL) {
                failure.get_or_insert(error);
            }
        }
        if let Err(error) = signal(&self.root, libc::SIGKILL) {
            failure.get_or_insert(error);
        }
        if let Err(error) = self.confirm_exit(Instant::now() + Duration::from_secs(2), || {
            child.try_wait().map(|status| status.is_some())
        }) {
            failure.get_or_insert(error);
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn confirm_exit(
        &self,
        deadline: Instant,
        mut root_reaped: impl FnMut() -> io::Result<bool>,
    ) -> io::Result<()> {
        let mut failure = None;
        loop {
            let mut any = false;
            for identity in self.known.values() {
                match alive(identity) {
                    Ok(true) => any = true,
                    Ok(false) => {}
                    Err(error) => {
                        failure.get_or_insert(error);
                        any = true;
                    }
                }
            }
            // A kernel zombie observation may precede waitpid readiness. Both
            // proofs must arrive within the same deadline; neither substitutes
            // for the other, and we must keep polling after execution stops.
            let reaped = match root_reaped() {
                Ok(reaped) => reaped,
                Err(error) => {
                    failure.get_or_insert(error);
                    false
                }
            };
            if !any && reaped {
                break;
            }
            if Instant::now() >= deadline {
                failure.get_or_insert(io::Error::other(if reaped {
                    "owned process exit unconfirmed"
                } else {
                    "owned root exit unconfirmed"
                }));
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };
    #[test]
    fn kills_detached_descendant_and_preserves_unrelated_process() {
        let temp = tempfile::tempdir().unwrap();
        let pidfile = temp.path().join("child");
        let mut outsider = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let script = "import os,subprocess,sys,time\np=subprocess.Popen(['/bin/sleep','30'],start_new_session=True)\nopen(sys.argv[1],'w').write(str(p.pid))\ntime.sleep(30)";
        let mut child = Command::new("/usr/bin/python3")
            .args(["-c", script])
            .arg(&pidfile)
            .process_group(0)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut tree = OwnedProcessTree::attach(&child).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let detached = loop {
            if let Ok(pid) = fs::read_to_string(&pidfile)
                && let Ok(pid) = pid.parse::<i32>()
            {
                break info(pid).unwrap().unwrap().identity;
            }
            assert!(Instant::now() < deadline);
            thread::yield_now();
        };
        tree.refresh().unwrap();
        tree.terminate(&mut child).unwrap();
        assert!(!alive(&detached).unwrap());
        assert!(outsider.try_wait().unwrap().is_none());
        outsider.kill().unwrap();
        outsider.wait().unwrap();
    }
    #[test]
    fn freeze_captures_detached_grandchild_created_after_initial_refresh() {
        let temp = tempfile::tempdir().unwrap();
        let ready = temp.path().join("ready");
        let gate = temp.path().join("gate");
        let grand = temp.path().join("grand");
        let inner = "import os,pathlib,subprocess,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\nwhile not pathlib.Path(sys.argv[2]).exists(): time.sleep(.005)\np=subprocess.Popen(['/bin/sleep','30'],start_new_session=True)\npathlib.Path(sys.argv[3]).write_text(str(p.pid))\ntime.sleep(30)";
        let script = "import subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c',sys.argv[1],*sys.argv[2:]],start_new_session=True)\ntime.sleep(30)";
        let mut child = Command::new("/usr/bin/python3")
            .args(["-c", script, inner])
            .args([&ready, &gate, &grand])
            .process_group(0)
            .spawn()
            .unwrap();
        let mut tree = OwnedProcessTree::attach(&child).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        tree.refresh().unwrap();
        fs::write(&gate, "go").unwrap();
        let descendant = loop {
            if let Ok(value) = fs::read_to_string(&grand)
                && let Ok(pid) = value.parse::<i32>()
            {
                break info(pid).unwrap().unwrap().identity;
            }
            assert!(Instant::now() < deadline);
            thread::yield_now();
        };
        assert!(!tree.known.contains_key(&descendant.pid));
        tree.terminate(&mut child).unwrap();
        assert!(!alive(&descendant).unwrap());
    }

    #[test]
    fn stopped_root_waits_for_reap_readiness_within_same_deadline() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let tree = OwnedProcessTree::attach(&child).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        let mut polls = 0;
        tree.confirm_exit(Instant::now() + Duration::from_secs(1), || {
            polls += 1;
            // Deterministically emulate waitpid lagging the nonexecuting
            // identity observation, without relying on scheduler timing.
            if polls == 1 {
                Ok(false)
            } else {
                child.try_wait().map(|status| status.is_some())
            }
        })
        .unwrap();
        assert_eq!(polls, 2);
        let error = tree.confirm_exit(Instant::now(), || Ok(false)).unwrap_err();
        assert_eq!(error.to_string(), "owned root exit unconfirmed");
    }

    #[test]
    fn root_exit_cannot_certify_tree_cleanup() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut tree = OwnedProcessTree::attach(&child).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(tree.refresh().is_err());
        assert!(tree.terminate(&mut child).is_err());
    }

    #[test]
    fn changed_birth_identity_is_not_signalled() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut stale = info(child.id() as i32).unwrap().unwrap().identity;
        stale.micros = (stale.micros + 1) % 1_000_000;
        signal(&stale, libc::SIGKILL).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
