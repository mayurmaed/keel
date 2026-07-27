# Demo script — 60–90s terminal recording (local Docker target)

Money path only: no AWS account needed, no cost, ~90 seconds of real command
output. Uses the included `sample-app/` (a tiny Node HTTP server with a
`Dockerfile`).

Every command below was dry-run against this repo's actual CLI
(`node dist/cli.js ...`) to confirm the output shown. See **Verified** notes.

## Setup (off-camera, before recording)

```bash
npm install && npm run build
cd sample-app
```

`sample-app/bareboat.json` is already committed with `target: local`, `port:
3000`. If port 3000 is already bound on the recording machine, either free it
or pick a different port for `--port` below and also `bareboat env set
PORT=<port>` so the in-container app listens on the same port Docker maps
(see **Verified** note on step 3 — the local target maps `host:container`
1:1 on `cfg.port`, so both must match).

## Recording

### 1. `bareboat new` — register the app

```bash
bareboat new --name hello --port 3000 --target local
```
**Expected output:**
```
wrote bareboat.json for "hello" — deploy with: bareboat deploy
```
**Caption:** "One command to register an app — writes bareboat.json."

**Verified:** ran exactly this; output matches.

### 2. `bareboat deploy` — build and run

```bash
bareboat deploy
```
**Expected output:** Docker BuildKit progress (image layers, mostly `CACHED`
after the first run), then:
```
live: http://localhost:3000
```
**Caption:** "docker build, docker run — done. Live URL printed."

**Verified:** ran exactly this (on a free port); build + run succeeded,
final line was `live: http://localhost:<port>`.

### 3. `bareboat status` — see it running

```bash
bareboat status
```
**Expected output:**
```
bareboat-hello	Up X seconds	0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp
```
**Caption:** "bareboat status shows the running container — same command works
against AWS."

**Verified:** ran exactly this; output format matches (container name,
uptime, port mapping).

### 4. Hit the running app

```bash
curl http://localhost:3000
```
**Expected output:**
```
hello from bareboat
```
**Caption:** "It's live — a real request, a real response."

**Verified:** ran exactly this; got `hello from bareboat`.

### 5. `bareboat logs` — tail container logs

```bash
bareboat logs
```
**Expected output:**
```
listening on 3000
```
**Caption:** "Logs stream straight from the container."

**Verified:** ran exactly this (without `-f`, which streams and blocks —
fine live on camera, cut it short with Ctrl-C for the recording).

### 6. `bareboat destroy` — clean teardown

```bash
bareboat destroy
```
**Expected output:**
```
destroyed hello
```
**Caption:** "One command, fully torn down — nothing left running."

**Verified:** ran exactly this; output matches.

## Recording & converting to GIF

```bash
# record (asciinema not installed on this machine — install before recording)
brew install asciinema
asciinema rec demo/bareboat-demo.cast --command "bash demo/run.sh" --idle-time-limit 2

# convert the .cast to a GIF for READMEs/social posts
brew install agg
agg demo/bareboat-demo.cast demo/bareboat-demo.gif
```

`demo/run.sh` (not included — write a thin wrapper that runs steps 1–6 above
in sequence with `sleep 1` between them) keeps the recording deterministic;
record interactively instead if you'd rather narrate live.

## Note on what wasn't verified

`asciinema` and `agg` are not installed on this machine, so the record/convert
commands above are documented but not dry-run. Install and run them manually
before the actual recording session.
