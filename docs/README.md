# Documentação do Yard

O [README da raiz](../README.md) descreve o que o app faz e o estado atual.
Aqui vive o resto:

## Specs

Nasceram do blueprint de arranque do projeto (agosto/2026) e foram revisados
conforme a implementação avançou. O código é a verdade final; os specs
registram o desenho, os contratos e o porquê das decisões.

| Spec                                                        | Conteúdo                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| [01 — Visão e stack](./specs/01-vision-and-stack.md)           | O que estamos construindo; por que Tauri 2 + Rust + xterm.js; versões-alvo  |
| [02 — Arquitetura](./specs/02-architecture.md)               | Módulos Rust e frontend, contrato IPC, ponte agente↔app, persistência       |
| [03 — Motor de PTY](./specs/03-pty-engine.md)                | ConPTY, scrollback, UTF-8/coalescing, gate de RAM, Job Objects, suspensão   |
| [04 — Armadilhas do Windows](./specs/04-windows-pitfalls.md) | Checklist de sobrevivência: shims do npm, SmartScreen, HiDPI, antivírus… |
| [05 — Roadmap](./specs/05-roadmap.md)                       | Fases F0–F7 com critérios de aceite e estado; canvas e ponte (§8.1)         |

## Guias

- [Desenvolvimento](./development.md) — setup do ambiente, testes, CI/CD de
  release, licença.

## Contratos de produto e design

- [`PRODUCT.md`](./PRODUCT.md) — contrato de produto (usuários, propósito,
  princípios, restrições).
- [`DESIGN.md`](./DESIGN.md) — o design system como foi construído (tokens,
  materiais, regras nomeadas). A implementação vive em `src/styles.css`; o
  comentário de direção no `index.html` aponta para cá.
