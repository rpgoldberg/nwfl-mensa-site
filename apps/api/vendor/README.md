# vendor/

`figurecollecting-fc-shared-1.7.0.tgz` is `@figurecollecting/fc-shared` 1.7.0,
byte for byte the GitHub Packages artifact. Its sha512 matches the integrity
fc-coordinator's lockfile records for the registry download:

    sha512-fkCOaXErW3YfjipH9KN5PsHxbH5MTVzUxvvIutXheuJCS3uMHksfYUWv6QFGjDGxdcWidhDaHpmkTzagXAJcog==

It is vendored because this repo has no token for the FigureCollecting package
registry yet (the GitHub owner is undecided). Once a `read:packages` token
exists, switch `package.json` to the registry version, add the `.npmrc` scope
line fc-coordinator uses, and delete this folder. `src/platform/shared.ts` is
the only importer, so nothing else changes.
