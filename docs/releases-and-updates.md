# Releases and Auto-Update: Step-by-Step

This project now includes a Windows release workflow that builds `clocking-bot.exe`, creates a SHA256 checksum, and uploads release assets when you push a `v*` tag.

## 1) One-time GitHub setup

1. Push this repository to GitHub.
2. In repo settings, ensure GitHub Actions are enabled.
3. (Optional but recommended) Protect your `main` branch.

## 2) Prepare a new version

1. Update `package.json` version (example `1.0.1`).
2. Commit your changes.

## 3) Build locally (optional validation)

```bash
npm install
npm run release:local
```

Expected outputs:
- `dist/clocking-bot.exe`
- `release/checksums.txt`
- `release/latest.json`

## 4) Publish a GitHub Release (automated)

1. Create and push a version tag:

```bash
git tag v1.0.1
git push origin v1.0.1
```

2. GitHub Action `.github/workflows/release.yml` will:
   - build the Windows EXE,
   - generate checksum + `latest.json`,
   - create a GitHub Release and upload artifacts.

## 5) What to send securely to other users

Recommended options:
- Send the release URL directly, OR
- Encrypt `clocking-bot.exe` before sharing.

Example encryption commands:

### 7-Zip (password protected archive)
```bash
7z a -t7z -mhe=on -pYOUR_STRONG_PASSWORD clocking-bot.7z dist/clocking-bot.exe
```

### OpenSSL (AES-256)
```bash
openssl enc -aes-256-cbc -salt -in dist/clocking-bot.exe -out clocking-bot.exe.enc
```

## 6) Update model (how updates work)

The intended update flow for the app is:
1. App checks release `latest.json` periodically.
2. If remote version is newer, app downloads the new EXE.
3. App validates SHA256 against `latest.json`.
4. App swaps/restarts using a helper process (Windows cannot overwrite a running exe reliably).

This repository currently includes release artifact generation and publishing; if you want, the next implementation step is adding an in-app updater module that consumes `latest.json`.
