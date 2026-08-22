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
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
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
    }
}

pub use imp::JobHandle;
