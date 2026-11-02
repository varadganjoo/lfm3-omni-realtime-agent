# Local-network testing

The default app is host-only at `http://127.0.0.1:8787/`. Enable LAN mode only on a network whose users you trust. This prototype has **no login or access code**, and notes/memory are shared by everyone using the instance.

## Enable

Run these commands on the host in PowerShell 7.3 or newer:

```powershell
.\scripts\enable-lan.ps1
.\scripts\stop.ps1
.\scripts\start.ps1
```

The script finds a private IPv4 address on an active gateway interface. The launcher prints the addresses for your machine:

- `https://<LAN_IP>:8443/`: the agent UI and encrypted media.
- `http://<LAN_IP>:8789/`: certificate help and the public certificate only.

Replace `<LAN_IP>` with the address printed by the launcher. Do not use HTTP on port 8443.

The script generates a local CA and server certificate under ignored `runtime/tls/`. It does not install a trusted root or change the firewall. Re-running it with the same address preserves the certificate and client trust. It refuses to silently replace the configuration when the address changes.

## Camera, microphone and certificate trust

Browsers restrict device capture to secure contexts such as HTTPS or localhost. On another device, open the HTTPS address in a browser that can reach your host. The local certificate may trigger a browser warning until you trust its issuer. A browser-specific exception may behave differently across browsers; installing the public CA is the repeatable setup provided here.

The HTTP help page includes instructions for Android, iOS/iPadOS, Windows and macOS. Compare its public certificate fingerprint with `runtime/lan.json` on the host before trusting it. Never copy the server's private key to client devices.

Official references: [browser media requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [Apple certificate trust](https://support.apple.com/en-us/102390), [Android certificate installation](https://support.google.com/pixelphone/answer/2844832).

## Troubleshooting

1. Verify that the host app opens at the original localhost address.
2. On the other device, try the plain HTTP help address. If that also fails, investigate connectivity before certificate trust.
3. Compare the devices' Wi-Fi network and IPv4 subnet. A guest network may isolate clients.
4. If one browser fails, try another installed browser. Check its app-level local-network permission, VPN/proxy routing and the exact error code.
5. Allow inbound TCP 8443 and 8789 for the host's Node executable from the intended home subnet if Windows blocks them. Keep 8081 and 8788 private. The script does not open firewall ports automatically.
6. Keep the host awake. Browser permission, speaker echo and camera availability require a real-device test.

No public tunnel, router port forwarding or cloud inference is needed. Host-side tests alone do not establish reachability or media permissions on another device.

## Boundaries and removal

The app binds HTTPS/help to the configured LAN IP and checks the client subnet and exact Host. Browser writes and media also require the matching Origin. Browser cookies are HttpOnly, SameSite=Strict and Secure on HTTPS. They separate conversation context, not shared storage or user identity.

The help listener has no conversation API, media endpoint or private-key download. Pipecat and llama.cpp remain on loopback behind an internal service key. The CA signing key is discarded after issuance; the server key stays under `runtime/tls/` on the host. The script requests owner/SYSTEM directory permissions on Windows. Keep the runtime folder private and use a filesystem that supports access controls when local OS-user isolation matters.

The server certificate lasts one year. To change addresses or renew: stop the app, move `runtime/lan.json` and `runtime/tls/` into a private backup, run `scripts/enable-lan.ps1`, and start again. Remove the old companion CA from client trust settings and trust the replacement. A DHCP reservation can keep the host's address stable.

To disable LAN mode, stop the app, move `runtime/lan.json` out of `runtime/`, and start again. The localhost app remains available. Remove the companion CA from client trust settings when finished testing.
