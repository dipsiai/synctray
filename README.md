# SyncTray

A tray app that shares text and files between computers on the same local network. macOS and Windows, in any combination.

Paste some text or drop a file on one computer, open the tray on the other, and it is there: click a text to copy it, right-click a file to save it to the desktop. No account, no server, nothing leaves your network.

[Türkçe README](README.tr.md)

## Features

- Lives in the system tray (Windows) or menu bar (macOS)
- Devices on the same network find each other automatically
- Shares text snippets and files of any size, with a progress bar on both ends
- Everything on the wire is encrypted (AES-256-GCM) with a key derived from a pairing code
- Files are copied to the other device right away, so they stay available after the sender goes to sleep
- Keeps the last 50 items for 7 days, with "clear all" across every device
- Phones and tablets join from their browser by scanning a QR code, no app to install
- Global shortcuts: open the window or send the clipboard from any app
- Sleep button: turns the network off completely until you wake it
- English and Turkish UI, picked from the system language
- Two small runtime dependencies besides Electron (`@noble/ciphers`, `qrcode-generator`)

## Install

Download the latest build from [Releases](https://github.com/dipsiai/synctray/releases).

**Windows:** extract the zip anywhere and run `SyncTray.exe`. The build is unsigned, so SmartScreen warns on first launch: choose **More info → Run anyway**. When the firewall asks, allow access on **private networks**.

**macOS:** open the dmg (`arm64` for Apple Silicon, `x64` for Intel) and drag SyncTray to Applications. The build is not notarized by Apple, so the first launch is blocked: open **System Settings → Privacy & Security** and choose **Open Anyway**.

## Pairing two devices

Each device generates a random pairing code on first launch. Open **Settings** on one device and type its code into the other. Devices that share a code find each other; the header shows a green dot and the other device's name.

If they do not find each other (some routers and guest networks block broadcast), type the address shown under Settings into the other device's "If a device is not found automatically" box. Doing this on one side is enough.

## Usage

1. Click the tray icon.
2. Paste text and press **Send** (⌘↵ / Ctrl+Enter). For files: drop them on the window, use **Choose file**, or paste a file from the clipboard.
3. On the other computer, click the tray icon:
   - click a text to copy it
   - right-click a file for **Save to Desktop** or **Save as…**

**Shortcuts.** `Alt+Shift+V` opens the window and `Alt+Shift+C` sends whatever is on the clipboard (text, a copied file or an image) from any app. Change or clear them under Settings.

**Phone or tablet.** Open **Settings → Phone and tablet → Show QR code** and scan it with the camera of a phone on the same Wi-Fi. The page that opens shows the same list: tap to copy a text, save a file, or send text and files back. It keeps working from a bookmark until you change the pairing code. Files sent from the browser are limited to 300 MB.

**Sleep.** Press **Sleep** in the window (or tick it in the tray menu) to turn the network off: no broadcasts, no open port, nothing sent or received. It stays asleep across restarts. Anything you add meanwhile is kept and syncs when you press **Wake**.

The window closes when you click elsewhere; press **Pin** first if you want to drag files in from Finder or Explorer. On macOS you can also drop files straight onto the menu bar icon.

## Security

- All traffic between devices is encrypted and authenticated: texts, files, file names, device names and discovery packets. The key is derived from the pairing code with scrypt. Someone on the same network without the code cannot read, add, delete or alter anything. See [`src/crypto.js`](src/crypto.js).
- Security rests on the pairing code, so keep it private. New installs generate a 12-character code; you can set a longer one in Settings.
- Received files are stored under a random id with no extension. They only get their real name when you save them, and executable file types ask for confirmation first.
- The phone page is encrypted with the same strength, using a key carried in the QR code (it stays in the URL fragment, which browsers never send over the network). One limit: the page itself is loaded over plain HTTP, because browsers do not accept certificates for local addresses. Someone who can already alter traffic on your network could tamper with the page as it loads. Listening alone reveals nothing.
- Not covered: data at rest is not encrypted, and the code has not had an independent security audit. It is built for networks you trust (home, office). For use across the internet, put the devices on a VPN such as Tailscale and add the peer's VPN address manually.

## Run from source

Requires Node.js 20 or later.

```bash
npm install
npm start
```

To try it with a second fake device on the same machine: `SYNC_PROFILE=second npm start`. Set `SYNC_LANG=en` or `SYNC_LANG=tr` to force a language.

## Build

```bash
npm run dist:mac   # dmg files in dist/
npm run dist:win   # zip in dist/
```

## How it works

- [`src/store.js`](src/store.js): the item list and files, kept in the app's data folder. Limits (item count, age, inline text size) are constants at the top.
- [`src/net.js`](src/net.js): discovery over UDP broadcast (port 47801) and two-way sync over HTTP (port 47800).
- [`src/crypto.js`](src/crypto.js): key derivation, sealed messages and the chunked file stream.
- [`src/main.js`](src/main.js): tray icon, window, clipboard, saving files.
- [`src/ui/`](src/ui): the window's interface.
- [`src/web/`](src/web): the page phones and tablets open, and its copy of the encryption.
- [`src/i18n.js`](src/i18n.js): UI strings.

## Tests

```bash
npm test
npm run test:stress
```

`npm test` starts virtual devices on one machine and checks text, file, delete, late join and unauthorized access, then exercises the phone page's API with the same encryption code the browser runs. The stress suite covers bursts of hundreds of texts, both devices sending at once, a 300 MB file, devices restarting or freezing mid-transfer, deleting during a transfer, forged requests, and that nothing on the wire is readable.

## License

[MIT](LICENSE)
