//! Windows Job Objects (§5.5) — the safety net against orphaned processes.
//!
//! An agent spawns an entire tree (`powershell -> node -> mcp servers -> git`).
//! `child.kill()` only kills the root and leaves `node.exe` wandering in Task
//! Manager — complaint number 1 of terminal apps on Windows. A Job Object
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` covers both cases:
//!
//! - `kill_pty` -> `TerminateJobObject` kills the entire tree, atomically;
//! - Yard crash -> the handle closes -> the OS itself kills the tree.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Job Object handle. `HANDLE` is a raw pointer, so `Send`/`Sync` is
    /// asserted here: the only operations performed on it (assign/terminate/close)
    /// are thread-safe in Win32.
    pub struct JobHandle(HANDLE);

    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        /// Creates a job with KILL_ON_JOB_CLOSE and associates the root process.
        /// Returns `None` if any step fails — the caller then falls back
        /// to the process-tree kill.
        pub fn create_and_assign(pid: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }

                // PROCESS_SET_QUOTA + PROCESS_TERMINATE is the minimum that
                // AssignProcessToJobObject requires.
                let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if proc.is_null() {
                    CloseHandle(job);
                    return None;
                }

                let assigned = AssignProcessToJobObject(job, proc);
                CloseHandle(proc);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(JobHandle(job))
            }
        }

        /// Kills the entire tree in one shot.
        pub fn terminate(&self) -> bool {
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }

        /// The PIDs of every process in the job right now: the terminal's
        /// whole tree, straight from the kernel, with no walk over the
        /// machine's process table. `None` when the query fails.
        pub fn pids(&self) -> Option<Vec<u32>> {
            // The struct is a header and a variable array of `usize`: a
            // buffer of `usize` words keeps it aligned. Room for `room`
            // entries, grown when the job has more than that.
            let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
            let word = std::mem::size_of::<usize>();
            let mut room = 64usize;
            // A job that keeps growing between two asks gets a few more
            // tries, not a loop without end.
            for _ in 0..4 {
                let mut buf = vec![0usize; header.div_ceil(word) + room];
                let bytes = (buf.len() * word) as u32;
                let ok = unsafe {
                    QueryInformationJobObject(
                        self.0,
                        JobObjectBasicProcessIdList,
                        buf.as_mut_ptr() as *mut c_void,
                        bytes,
                        std::ptr::null_mut(),
                    )
                };
                let list = buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST;
                let (assigned, listed) = unsafe {
                    ((*list).NumberOfAssignedProcesses, (*list).NumberOfProcessIdsInList)
                };
                // Too small a buffer fails with ERROR_MORE_DATA and still
                // says how many there are: ask again with room for them.
                if assigned as usize > room {
                    room = assigned as usize + 16;
                    continue;
                }
                if ok == 0 {
                    return None;
                }
                let first = unsafe { (list as *const u8).add(header) as *const usize };
                let ids = unsafe { std::slice::from_raw_parts(first, (listed as usize).min(room)) };
                return Some(ids.iter().map(|&id| id as u32).collect());
            }
            None
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE: closing the handle already kills whoever is left.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// Stub for non-Windows platforms: kill falls back to the process tree.
    pub struct JobHandle;

    impl JobHandle {
        pub fn create_and_assign(_pid: u32) -> Option<Self> {
            None
        }
        pub fn terminate(&self) -> bool {
            false
        }
        pub fn pids(&self) -> Option<Vec<u32>> {
            None
        }
    }
}

pub use imp::JobHandle;

#[cfg(all(test, windows))]
mod tests {
    //! The resources tick reads a terminal's processes from its Job Object
    //! instead of scanning every process on the machine. That is only right
    //! if the job really lists them: the process it was given and whatever
    //! that one starts afterwards (children join their parent's job).
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn the_job_lists_its_process_and_the_child_that_process_starts() {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // The first `ping` waits a second before the one that stays: that one
        // is started well after the assignment below, so it is the job's.
        let mut child = Command::new("cmd")
            .args(["/D", "/C", "ping -n 2 127.0.0.1 >NUL & ping -n 30 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn cmd");
        let root = child.id();
        let job = JobHandle::create_and_assign(root).expect("job");

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut pids = Vec::new();
        while Instant::now() < deadline {
            pids = job.pids().expect("the job answers");
            if pids.contains(&root) && pids.len() >= 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(pids.contains(&root), "{pids:?} misses cmd {root}");
        assert!(pids.len() >= 2, "{pids:?} has no child of cmd");

        // KILL_ON_JOB_CLOSE takes the tree down with the handle.
        drop(job);
        let _ = child.wait();
    }
}
