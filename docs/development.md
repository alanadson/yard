# Desenvolvimento

## Setup do ambiente (Windows)

Execute num PowerShell com winget disponível:

```powershell
# 1) Rust (toolchain MSVC) + Build Tools do Visual Studio (obrigatório p/ linkar)
winget install Rustlang.Rustup
rustup default stable-msvc
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2) Node LTS (para o Vite/frontend)
winget install OpenJS.NodeJS.LTS

# 3) WebView2 — já vem no Windows 11 e no 10 atualizado.
#    (O instalador NSIS do Tauri embute o bootstrapper p/ máquinas sem ele.)

# 4) Rodar
npm install
npm run tauri dev    # desenvolvimento, com HMR
npm run tauri build  # instalador NSIS em src-tauri/target/release/bundle
```

Verificações rápidas se algo falhar: `rustup show` deve indicar
`stable-x86_64-pc-windows-msvc`; `cl.exe` precisa existir num "Developer
PowerShell"; erro de `link.exe` = Build Tools sem a workload C++.

> Rodar uma build de desenvolvimento ao lado de uma instalada? Defina
> `YARD_DATA_DIR` para a build de dev — sem isso as duas dividem o mesmo
> `app.db` e a mesma pasta de scrollback (ver README, variáveis de ambiente).

## Testes

```powershell
npm test                   # vitest: núcleo da ponte, canvas, markdown das notas
cd src-tauri
cargo test --lib           # motor de PTY, agentes, persistência, shims da ponte
```

Os testes de `pty::engine_tests` sobem PowerShell de verdade e verificam os
critérios de aceite da F1 (ver [roadmap](./specs/05-roadmap.md)). Detalhes do
que cada suíte cobre estão no [README](../README.md#testes).

## CI/CD — build e release por tag

`.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ["v*"]

jobs:
  build-windows:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Yard ${{ github.ref_name }}"
          releaseDraft: true
```

A chave `TAURI_SIGNING_PRIVATE_KEY` é a do **updater** (gere com
`npm run tauri signer generate`) — é separada da assinatura de código do
Windows ([armadilhas do Windows, item 7](./specs/04-windows-pitfalls.md)).
Fluxo de release: `git tag v0.1.0 && git push origin v0.1.0` → instalador
`.exe` + artefatos do updater no draft da release. Adicione depois um job de
CI comum (push/PR) rodando `cargo test`, `cargo clippy -- -D warnings` e
`npm run build`.

## Licença

**Sugerida: MIT ou Apache-2.0** — máxima adoção, compatível com receber
contribuições, e permite pivotar o modelo depois. Se quiser o efeito "quem me
clonar tem que abrir o código", use AGPL-3.0 conscientemente — o custo é
afastar uso corporativo. Decida **antes** do primeiro commit público.
