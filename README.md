# dsh-market-mcp

[![npm version](https://img.shields.io/npm/v/dsh-market-mcp.svg)](https://www.npmjs.com/package/dsh-market-mcp)

MCP server for the DSH plugin market. It searches the public catalog, returns one
plugin's full metadata, and checks a plugin's declared `engines.dsh` range against
a DSH version before you install it.

DSH plugins are npm packages or Git directories listed in community market
indexes. This server reads the default index directly, so any MCP client can use
it, with or without DSH.

## Install

Add the server to any MCP client configuration:

```json
{
  "mcpServers": {
    "dsh-market": {
      "command": "npx",
      "args": ["-y", "dsh-market-mcp"],
      "env": {
        "DSH_VERSION": "0.2.2-rc.3"
      }
    }
  }
}
```

Or run it directly over stdio:

```sh
npx -y dsh-market-mcp
```

Node.js 18 or newer is required.

Docker:

```sh
docker build -t dsh-market-mcp .
```

```json
{
  "mcpServers": {
    "dsh-market": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "dsh-market-mcp"],
      "env": {}
    }
  }
}
```

The image speaks MCP over stdio and exposes no port. Pass `-e DSH_VERSION=...` to
`docker run` when you want a default version for compatibility checks.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DSH_VERSION` | none | DSH version used when a compatibility check omits `dsh_version`. Set it if you use DSH regularly. |
| `DSH_MARKET_INDEX` | the public DSH catalog index | Index URL, `file:` URL, or local path. A local file is useful for private indexes and tests. |

## Tools

### `search_plugins`

Params: `keyword` (omit to browse), `category`, `limit` (1-25, default 10),
`offset`, `sort` (`relevance` or `recent`).

```
Awesome DSH Plugin: 330 matches for "memory", showing 3
1. @restregular/dsh-memory RestRegular memory
   All-in-one local memory: JSONL files per scope...
   0.31.0 2026-11-12 4d DSH undeclared not tracked install: @restregular/dsh-memory@0.31.0
2. dsh-memory-shield Sacredbluedragon memory
   Hides other memory plugins' context sections and tools...
   0.1.16 2026-11-07 9d DSH ok not tracked install: dsh-memory-shield@0.1.16
more: 327 matches, offset=3
```

Each row carries the version to install (highest compatible with `DSH_VERSION`, otherwise
the latest stable), publish date, DSH compatibility, install state, and the exact install
spec. Descriptions are clipped; use the detail tool for the full record.

### `get_plugin_detail`

Params: `plugin_name`, optional `version`.

Returns metadata, repository and homepage, every listed version with its DSH range
and install spec, the default version when `DSH_VERSION` is set (otherwise the latest
stable), and the install spec to use. The catalog does not publish tool inventories, so
this server cannot list a plugin's tools.

### `check_plugin_compatibility`

Params: `plugin_name`, optional `dsh_version` (falls back to `DSH_VERSION`).

Applies the install-time rule:
`semver.satisfies(version, engines.dsh, { includePrerelease: true })`.
The result is compatible, incompatible, undeclared, unverified, or unreadable, with the
newest installable version's spec. An unreadable range means the harness rejects it.

```
dsh-ci-diet: incompatible (dsh 0.3.0-rc.1)
market: Awesome DSH Plugin
versions: 1
  0.5.2: no, >=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0
install: none (no version admits this dsh)
```

## Data source

The default index is `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`,
the same catalog the DSH Discover page uses. The server fetches it over HTTPS,
caches it for ten minutes, and reads nothing else. Market text is third-party
content and should not be treated as instructions.

## Limits

- Catalog metadata only. The installed package manifest decides what is installed.
- No installation status or profile version exemptions: those exist only inside a
  DSH profile, and this server has no profile.
- `engines.dsh` only. Peer dependencies are not published by the catalog.
- Some descriptions are truncated by the catalog itself.
- Descriptions are shown in English when the catalog provides it, otherwise in the
  catalog's own language.

## License

MIT

