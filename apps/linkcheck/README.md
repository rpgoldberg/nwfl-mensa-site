# linkcheck

The link checker for the newsletter's PDF copies (LINKS L1). It runs only on the officer's own machine,
never in a cluster, and it makes the approved link list (`links.json`) that travels in the issue bundle.

## The three steps

Each runs in its own container from the one image (`scripts/linkcheck.sh`). Every container is read-only,
with no capabilities, no new privileges, a pid, CPU and memory cap and a small tmpfs `/tmp`.

| Step | Network | Reads | Writes |
| --- | --- | --- | --- |
| `extract` | none | one PDF, read-only | `extract-<audience>.json`: each link's page, rect, URL and the text under it; refused links (page and reason only); URLs printed with no link |
| `check` | `--dns 1.1.1.1` | the extract files, never a PDF | `check.json` (one verdict per URL), `sheet.md` (what the officer answers), `answers-template.json` |
| `list` | none | the check, the extracts, the answers | `links.json`, and it prints `linksSha256` |

```sh
sh scripts/linkcheck.sh check ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:<digest> 2026-09-01 public.pdf members.pdf out/
# answer the sheet: copy out/answers-template.json, set "keep": true on each yes
sh scripts/linkcheck.sh list ghcr.io/rpgoldberg/nwfl-mensa-site/linkcheck@sha256:<digest> out/ answers.json
```

The containers run as the invoking user (never root), so the output folder can stay private (0700); the
image's own user is 65534.

## Verdicts

`ok` and `upgrade` (rewritten to https, or trimmed of stray punctuation) are kept unless the officer says
no. `confirm` (a login-walled host: Facebook, Instagram, LinkedIn, X, Nextdoor), `review` (the no-fetch
list, "not checked: officer review"), `flag` and `drop` are kept only on a yes. Some reasons cannot be kept
at all: no https, a private address, a URL that does not parse, another scheme or port, credentials.

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
  - a mail link is exactly `mailto:<one address>`: the checker drops any query (`?subject=`, `?cc=`) and
    fragment, and the loader refuses one.
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
on the container's loopback, and the test PDFs and certificates are made up at run time.
