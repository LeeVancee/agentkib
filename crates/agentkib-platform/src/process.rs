#[cfg(target_os = "macos")]
pub mod owned_tree;

use std::io;
use std::process::{Child, Command};

/// Configure a background command before spawning it.
///
/// Unix children become process-group leaders so timeouts can terminate their
/// descendants. Windows children run without creating a visible console; their
/// descendants are supervised through a [`ProcessTree`] job object.
pub fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
    }
}

/// Owns the operating-system primitive that contains a child process tree.
/// Dropping the guard terminates the Job Object or configured Unix process group.
pub struct ProcessTree {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    unix_pid: libc::pid_t,
    #[cfg(unix)]
    owns_process_group: bool,
}

impl ProcessTree {
    pub fn attach(child: &Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            windows::attach(child)
        }
        #[cfg(unix)]
        {
            unix::attach_pid(child.id())
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    /// Attach an already-spawned process by id. This is useful for process
    /// wrappers that expose only a pid rather than the underlying `Child`.
    pub fn attach_pid(pid: u32) -> io::Result<Self> {
        #[cfg(windows)]
        {
            windows::attach_pid(pid)
        }
        #[cfg(unix)]
        {
            unix::attach_pid(pid)
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            Ok(Self {})
        }
    }

    pub fn terminate(&self) -> io::Result<()> {
        #[cfg(windows)]
        {
            windows::terminate(self.job)
        }
        #[cfg(unix)]
        {
            unix::terminate(self.unix_pid, self.owns_process_group)
        }
        #[cfg(not(any(windows, unix)))]
        {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if self.owns_process_group {
            let _ = unix::terminate(self.unix_pid, true);
        }
    }
}

#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

#[cfg(unix)]
mod unix {
    use std::io;

    use super::ProcessTree;

    pub(super) fn attach_pid(pid: u32) -> io::Result<ProcessTree> {
        let pid = libc::pid_t::try_from(pid)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "process id is too large"))?;
        let process_group = unsafe { libc::getpgid(pid) };
        if process_group < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ProcessTree {
            unix_pid: pid,
            owns_process_group: process_group == pid,
        })
    }

    pub(super) fn terminate(pid: libc::pid_t, owns_process_group: bool) -> io::Result<()> {
        let target = if owns_process_group { -pid } else { pid };
        if unsafe { libc::kill(target, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::mem;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    use super::ProcessTree;

    pub(super) fn attach(child: &Child) -> io::Result<ProcessTree> {
        attach_handle(child.as_raw_handle() as HANDLE)
    }

    pub(super) fn attach_pid(pid: u32) -> io::Result<ProcessTree> {
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = attach_handle(process);
        unsafe { CloseHandle(process) };
        result
    }

    fn attach_handle(process: HANDLE) -> io::Result<ProcessTree> {
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const _,
                mem::size_of_val(&information) as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        if unsafe { AssignProcessToJobObject(job, process) } == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(ProcessTree { job })
    }

    pub(super) fn terminate(job: HANDLE) -> io::Result<()> {
        if unsafe { TerminateJobObject(job, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::io;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use tempfile::tempdir;

    use super::{ProcessTree, configure_process_group};

    fn process_is_running(pid: libc::pid_t) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        if result < 0 {
            return io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        }
        #[cfg(target_os = "linux")]
        {
            let path = format!("/proc/{pid}/stat");
            let Ok(stat) = fs::read_to_string(path) else {
                return false;
            };
            let state = stat
                .rsplit_once(") ")
                .and_then(|(_, fields)| fields.as_bytes().first().copied());
            if matches!(state, Some(b'Z' | b'X')) {
                return false;
            }
        }
        true
    }

    #[test]
    fn configured_child_can_be_terminated_as_a_process_group() {
        let directory = tempdir().unwrap();
        let descendant_pid_path = directory.path().join("descendant.pid");
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & echo $! > \"$1\"; wait", "sh"])
            .arg(&descendant_pid_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = ProcessTree::attach(&child).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        let descendant_pid = loop {
            if let Ok(value) = fs::read_to_string(&descendant_pid_path)
                && let Ok(pid) = value.trim().parse::<libc::pid_t>()
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "descendant process did not start"
            );
            std::thread::sleep(Duration::from_millis(10));
        };

        tree.terminate().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "child process did not terminate");
            std::thread::sleep(Duration::from_millis(10));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if !process_is_running(descendant_pid) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "descendant process remained alive"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn unconfigured_child_falls_back_to_direct_termination() {
        let mut child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        tree.terminate().unwrap();
        assert!(child.wait().unwrap().code().is_none());
    }
}
