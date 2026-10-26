// A stand-in engine process killed by the kernel, as the OOM killer would.
process.once('message', () => process.kill(process.pid, 'SIGKILL'));
