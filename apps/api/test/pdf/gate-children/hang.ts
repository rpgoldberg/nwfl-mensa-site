// A stand-in gate child that never answers (a copy it cannot finish).
process.once('message', () => setInterval(() => {}, 1_000));
