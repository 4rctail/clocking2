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

### Troubleshooting

If you see:

```
Error! No available node version satisfies 'node20'
```

that means `pkg` does not have a `node20` runtime for your installed version. This repository is configured to target `node18-win-x64` so local release builds work with `pkg@5.8.1`.


If you see:

```
Error: Cannot find module 'C:\snapshot\clocking\index.js'
```

rebuild after pulling the latest changes in this repo. The project now includes explicit `pkg` bundling config in `package.json` so `index.js`, command files, and JSON assets are included in the executable.

Then run:

```bash
npm install
npm run build:win
npm run checksum:win
```

If it still fails, clear stale build/cache artifacts and rebuild:

```powershell
Remove-Item -Recurse -Force .\dist, .\release -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.pkg-cache" -ErrorAction SilentlyContinue
npm install
npm run build:win
npm run checksum:win
```

This project now builds from `pkg package.json` with `"main": "index.js"` and `"bin": "index.js"` in `package.json`, which ensures the executable entrypoint is bundled correctly.


If you see:

```
Error! --no-bytecode and no source breaks final executable
```

remove `--no-bytecode` from the build command and run:

```bash
npm run build:win
npm run checksum:win
```


If you still see `Cannot find module 'C:\snapshot\clocking\index.js'` after rebuild:

1. Confirm `package.json` has both `"main": "index.js"` and `"bin": "index.js"`.
2. Confirm build command is `pkg package.json --targets node18-win-x64 --output dist/clocking-bot.exe`.
3. Delete old EXE copies outside the repo and run the newly generated one in `dist/`.
