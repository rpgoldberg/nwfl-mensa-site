// A stand-in gate child that dies without answering (a crash).
process.once('message', () => process.exit(3));
