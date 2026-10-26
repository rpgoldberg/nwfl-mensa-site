// A stand-in engine process that never answers.
process.once('message', () => setInterval(() => {}, 1_000));
