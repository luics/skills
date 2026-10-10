# Transfermarkt OpenCLI plugin

Provides a browser-backed command for the public Transfermarkt player market-value ranking.

## Install

```bash
opencli plugin install github:luics/skills/transfermarkt
```

Each device needs the OpenCLI browser extension connected to Chrome. Confirm the connection with:

```bash
opencli doctor
```

## Usage

```bash
opencli transfermarkt top-players --page 1 --limit 25 -f json
```

`page` accepts 1 through 20, and `limit` accepts 1 through 25.
