# linkcheck

The link checker for the newsletter's PDF copies (LINKS L1). It runs only on the officer's own machine,
never in a cluster, and it makes the approved link list (`links.json`) that travels in the issue bundle.

## The three steps

Each runs in its own container from the one image (`scripts/linkcheck.sh`). Every container is read-only,
with no capabilities, no new privileges, a pid, CPU and memory cap and a small tmpfs `/tmp`.

| Step | Network | Reads | Writes |
| --- | --- | --- | --- |
| `extract` | none | one PDF, read-only | `extract-<audience>.json`: each link's page, rect, URL and the text under it; refused links (page and reason only); URLs printed with no link |
| `check` | `--dns 1.1.1.1` | the extract files, never a PDF; a remember file if given | `check.json` (one verdict per URL), `sheet.md` (what the officer answers), `answers-template.json` (earlier answers filled in) |
| `replace` | `--dns 1.1.1.1` | the check, the answers | `check-replacements.json`: each different link the officer gave, checked like any link |
| `list` | none | the check, the extracts, the answers, the checked replacements, a remember file if given | `links.json` and `remember.json`, and it prints `linksSha256` |

```sh
sh scripts/linkcheck.sh check ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:<digest> 2026-09-01 public.pdf members.pdf out/
# answer the sheet: copy out/answers-template.json, set "keep": true on each yes,
# or "replace": "https://..." in place of "keep" to give a different link over the same printed text
sh scripts/linkcheck.sh list ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:<digest> out/ answers.json
```

Both steps take an optional last argument, a remember file (`nwfl-link-remember/1`): `list` writes each
answer to it by URL, with the date, and the next issue's `check` fills the same answers in, except over a
fresh unsafe verdict (a certificate failure, parking, re-registration or an unrelated redirect), which asks
again. A different link goes in `links.json` only if its own check is `ok`, or `confirm` or `review` (never
fetched: the replace answer is the officer's yes); `links.json`'s format is unchanged.

The containers run as the invoking user (never root), so the output folder can stay private (0700); the
image's own user is 65534.

## Verdicts

`ok` and `upgrade` (rewritten to https, or trimmed of stray punctuation) are kept unless the officer says
no. `confirm` (a login-walled host: Facebook, Instagram, LinkedIn, X, Nextdoor), `review` (the no-fetch
list, "not checked: officer review"), `flag` and `drop` are kept only on a yes. Some reasons cannot be kept
at all: no https, a private address, a URL that does not parse, another scheme or port, credentials. A 404
or 410 that still shows a real page (its own title and a text body, not parked or a stock server page) is
`flag` ("the site says not found but shows a page"), not `drop`.

## Officer pieces: `items` (L-ITEM)

`linkcheck items` checks the links of the officers' pieces that wait for approval or are approved and not yet
published. It asks the API's `LinkCheckService` for the addresses (addresses only: no text, words or titles),
checks each by the rules above, and records a verdict on each. `ok` is stored as OK, which lets the link through
Approve for 7 days. `upgrade`, `confirm`, `review` and `flag` are stored as CONFIRM: a person looks. `drop` is
stored as DROP, and Approve then waits for a yes with a note. The API refuses OK on a link that needs a sign-in.
A piece is about now, so there is no issue date to compare a registration with: a domain registered in the last
90 days gets the reason `re-registered`, which is `flag`, and so is stored as CONFIRM.
It calls the website, not the API: `LINKCHECK_API_URL` is the site's origin (`https://nwflmensa.us`), whose
Connect route serves `LinkCheckService` and forwards each call to the API over the cluster mesh (the tunnel
carries no gRPC on a public hostname). The call is a plain HTTPS POST of the message, with the token as
`Authorization: Bearer`; the API still checks the token. A redirect is refused, never followed with the token.
Configuration is by environment: `LINKCHECK_API_URL`, `LINKCHECK_TOKEN_URL`, `LINKCHECK_PASSWORD_FILE` (the
service account's app password, in a file), and optionally `LINKCHECK_CLIENT_ID` (`nwfl-linkcheck`),
`LINKCHECK_USERNAME` (`svc-nwfl-linkcheck`) and `LINKCHECK_SCOPE` (`links.check`). It prints counts only.

`scripts/linkcheck.sh items <image>` runs it in one container, hardened as the others: read-only, no
capabilities, `--dns 1.1.1.1`, `--memory=512m`, no PDF and no folder of the machine. It runs only an image given
as a name, `@sha256:` and 64 hex characters, and nothing else: no tag alone, no bare image ID, and no name that
starts with a dash or holds a space (docker would read it as an option). The settings above come from the environment and go to the container by name.
`LINKCHECK_PASSWORD_FILE` names a file only its owner can read (0600); it is mounted read-only at
`/in/password`, so the password is in no argument and no environment value.

```sh
LINKCHECK_API_URL=https://... LINKCHECK_TOKEN_URL=https://... LINKCHECK_PASSWORD_FILE=/path/to/password \
  sh scripts/linkcheck.sh items ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:<digest>
```

`scripts/items-cron.sh` is the wrapper a crontab calls on the officer's machine. It takes no arguments. It
reads `LINKCHECK_IMAGE` (by digest), `LINKCHECK_API_URL`, `LINKCHECK_TOKEN_URL` and optionally `LINKCHECK_SCOPE`,
`BAO_ADDR` and `LINKCHECK_BAO_TOKEN_FILE` from `~/.config/nwfl-linkcheck/items.conf`, one `NAME=value` per
line. The file must be a plain file (not a link) of plain ASCII text with Unix line endings, and neither it nor its folder may be writable by
group or others: whoever can write it chooses the image that is handed the password. It lets one run go at a
time (flock). OpenBao is asked with the cron's own token only: a periodic (72 h), renewable token that can read
that one secret, kept in `LINKCHECK_BAO_TOKEN_FILE` (by its full path; by default
`~/.config/nwfl-linkcheck/bao.token`). That file must be a plain file (not a link, a folder or a pipe) of yours,
mode exactly 0600, in a folder that neither group nor others may write; otherwise the run ends with exit 1 and
the rule it breaks. The file holds the token alone, on one line: spaces and tabs around it are trimmed and
nothing else is, and a file with a Windows line ending, a second line, a blank inside the token or a character
outside ASCII is refused before OpenBao is asked, with exit 1 and words that name the file and the re-mint
step. The shell reads the token itself and gives it to each `bao` call in that call's environment
(`BAO_TOKEN`) only: never as an argument, never to docker, never printed; a variable named like one of the
wrapper's own in the caller's environment does not change that. A `BAO_TOKEN`, `BAO_TOKEN_PATH` or
`VAULT_TOKEN` (or a `VAULT_TOKEN_PATH`) the run inherits is dropped first, and `~/.vault-token` is not read,
so a token of another login is never used. After `bao status`, every run renews the token (`bao token renew`,
the renew-self endpoint), and gives the renewal 30 seconds; when the file is missing or empty, or the renewal
fails or does not end in time, the run ends with exit 1 and `the cron token is gone
or expired: re-mint: tenants/nwfl/APPLY.md step 35j (LINKCRON-TOKEN)`. It then reads `client_id`, `username`
and `password` at `secret/nwfl-mensa/linkcheck/client` with the OpenBao CLI, writes the password to a 0600
file in a fresh 0700 folder, and runs `linkcheck.sh items`; a run over 20 minutes is stopped. docker writes the container's id into that folder (`--cidfile`), and as the wrapper
ends it removes the container by that id (`docker rm -f`, ten seconds at most), so a container that ignored the
stop does not outlive the run or meet the next one; if docker cannot remove it, a `note:` line says so. The
password file is removed as soon as the container has ended, and the folder on every exit; a folder that a
killed run left behind is removed by the next run, with the container it names, which says so in the log. It
prints no secret. Each run appends one line to `~/.local/state/nwfl-linkcheck/items.log`: the time,
`exit=<code>`, and the counts or the reason. The reason is the checker's message only when it is one of its
fixed messages, or docker's own first line (printable ASCII only) when docker failed with exit 125 to 127
before it made a container; anything else is logged as `the run failed (unrecognised message)`, so nothing a
server or the container said reaches the log. Exit codes: 0 done; 1 the
run failed; 2 OpenBao is unreachable or sealed (and nothing else); 3 another run is still going.

Limits of the wrapper, known and left as they are:

- It checks the modes of its settings, lock and log, not who owns them (it does check the owner of the token
  file, though not of the token file's folder). A file or folder that another user
  owns, or a `~/.config` that others can write, is not noticed; placing one takes root or the officer's own
  write access.
- An exit of 137 is read by the clock: under 20 minutes it is logged as out of memory, at 20 minutes or more
  as the time limit. A clock that jumps, or a container that itself exits 124, is mislabelled.
- When docker fails to start a container it has already made (exit 126 or 127), its reason is not logged:
  the container is removed with its record, so the exit cannot be told from the container's own.

## Safety

- extract is the only part that parses a PDF. pdf.js runs in a worker thread with a 256 MiB heap and a
  deadline, so a hostile file (100 000 annotations, say) is refused, not fatal. Files over 10 MiB, over
  500 pages, over 500 links or over 1000 refused links are refused whole.
- The no-fetch list (us.mensa.org and everything under it, myfigurecollection, suruga-ya, hobby-genki, vndb)
  gets no request of any kind, not even DNS. Login-walled hosts are resolved, never fetched.
- check resolves every name itself and dials only global unicast addresses (no loopback, private,
  link-local, CGNAT, multicast, documentation, ULA or IPv4-mapped), pinned to the address it checked; TLS
  is verified against the name. Ports 80 and 443 only; redirects by hand, at most 5, each hop checked
  again; 10 s per hop; at most 256 KiB of a body (1 MiB for IANA's RDAP bootstrap file), inflated to at
  most the same; no cookies, no scripts, no forms; a User-Agent that names us. Page bodies are data: only the parked-page signals read them, and
  no body reaches the sheet or the report.
- Safe Browsing (Q4) is not consulted in this version; every fetched link notes it.

## links.json: the contract with the loader

```json
{
  "format": "nwfl-link-list/1",
  "sha256": { "public": "<sha256 of the public PDF>", "members": "<sha256 of the members PDF>" },
  "links": {
    "public": [{ "id": "<26 lower-case base32>", "page": 1, "rect": [72, 696, 150, 712], "url": "https://...", "kind": "web", "confirm": false }],
    "members": []
  },
  "linksSha256": "<hex>"
}
```

- `id`: 128 random bits as 26 lower-case base32 characters (RFC 4648 alphabet, no padding), never derived.
- `page` is 1-based; `rect` is in PDF points, clamped to the crop box, rounded to 0.01, x1 < x2, y1 < y2.
- `url` is its own kept form (`src/urls.ts` `keptForm`), the links contract shared with the loader:
  - the host is canonical: lower case, every trailing dot stripped, IDN in punycode; an empty label
    refuses the URL;
  - a web link is https, with no userinfo, no port (not even :80 or :443), no IP literal and no dotless
    host;
  - the host, or a mail domain, is a DNS name (the loader's HOST and the 0024 CHECK): two labels or
    more, each 1 to 63 of `a-z`, `0-9` and inner hyphens, the last starting with a letter, 4 to 253
    characters; anything else is refused (`host-name`);
  - a mail link is exactly `mailto:<one address>`: the checker drops any query (`?subject=`, `?cc=`) and
    fragment, and the loader refuses one. The local part holds no `#`, `%` or `?`, and does not start
    with `/`;
  - a kept URL is at most 2048 characters, and `check` refuses to write a check.json whose kept URL is not
    its own kept form.
  `test/fixtures/links-contract.json` pins the cases; the loader commits the same file, and both suites
  check its sha256.
- `kind` is `web` or `mail`; `confirm` is true when the officer's own yes kept it from the login-walled or
  no-fetch list.
- `linksSha256` = sha256 hex of `canonicalJson({ v: 2, sha256: { public, members }, links: { public,
  members } })`, each list sorted by id, `canonicalJson` exactly `apps/api/src/content/hash.ts`'s. The file
  sha256s are inside the hash, so links approved for one issue's files cannot attach to another's.
  `test/list.test.ts` pins a test vector, computed independently with Python.
- The sheet shows the text under each link from both files, the members file included. That text can
  name members, so the sheet stays on the officer's own machine and is never committed.

## Tests

`npm test` (`scripts/test-contained.sh`) runs the suite only in a capped container with no network
(`--memory=2g --pids-limit=512 --cpus=2 --network none`); the stand-in DNS, HTTP and HTTPS servers listen
on the container's loopback, and the test PDFs and certificates are made up at run time. The two scripts are
run for real against a stand-in `docker` and a stand-in `bao` on PATH.
