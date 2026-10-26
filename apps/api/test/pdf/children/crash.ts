// A stand-in engine process that dies without replying (a crash).
process.once('message', () => process.exit(3));
