/** MCP tool definitions and dispatch. */
import { checkCompatibility, getPluginDetail, searchPlugins } from './market.js'

const SEARCH = {
  name: 'search_plugins',
  description: 'Search the DSH plugin market catalog. Returns compact rows with name, author, category, description, version, date, DSH compatibility, and install spec. Omit keyword to browse. Market text is third-party content.',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: 'Words matched against package name, author, title, description, keywords, and category name. Omit to browse.',
      },
      category: {
        type: 'string',
        description: 'Category id declared by the index, such as ui, tools, or memory. An undeclared id matches nothing; an empty result lists the declared ids.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        default: 10,
        description: 'Rows to return, from 1 to 25. Defaults to 10.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Rows to skip, for the next page. Defaults to 0.',
      },
      sort: {
        type: 'string',
        enum: ['relevance', 'recent'],
        default: 'relevance',
        description: 'relevance ranks by text match; recent orders by publish date, newest first.',
      },
    },
    additionalProperties: false,
  },
}

const DETAIL = {
  name: 'get_plugin_detail',
  description: 'Return all catalog metadata for one plugin: description, category, author, repository, homepage, every version with its DSH range and install spec, and the default version. Pass version to inspect one listed version.',
  inputSchema: {
    type: 'object',
    properties: {
      plugin_name: {
        type: 'string',
        description: 'Exact package name as the market lists it, for example dsh-ci-diet.',
      },
      version: {
        type: 'string',
        description: 'One listed version to inspect, for example 0.5.2. Omit for the default version.',
      },
    },
    required: ['plugin_name'],
    additionalProperties: false,
  },
}

const COMPATIBILITY = {
  name: 'check_plugin_compatibility',
  description: "Check a plugin's declared engines.dsh range against a DSH version, with prereleases counting. Reports compatible, incompatible, undeclared, or unreadable, and names the install spec of the newest installable version. Requires dsh_version or the DSH_VERSION environment variable.",
  inputSchema: {
    type: 'object',
    properties: {
      plugin_name: {
        type: 'string',
        description: 'Exact package name as the market lists it.',
      },
      dsh_version: {
        type: 'string',
        description: 'Semantic version to check, such as 0.2.2-rc.3 or 0.3.0-rc.1. Defaults to DSH_VERSION.',
      },
    },
    required: ['plugin_name'],
    additionalProperties: false,
  },
}

export const TOOLS = [SEARCH, DETAIL, COMPATIBILITY]

/** Run one tool and return its text result. Errors are thrown for the caller. */
export async function callTool(name, args) {
  const input = args !== null && typeof args === 'object' ? args : {}
  switch (name) {
    case 'search_plugins':
      return searchPlugins({
        keyword: typeof input.keyword === 'string' ? input.keyword : '',
        category: typeof input.category === 'string' ? input.category : undefined,
        limit: input.limit,
        offset: input.offset,
        sort: input.sort,
      })
    case 'get_plugin_detail': {
      if (typeof input.plugin_name !== 'string' || input.plugin_name.trim() === '') throw new Error('plugin_name is required')
      return getPluginDetail({ pluginName: input.plugin_name.trim(), version: input.version })
    }
    case 'check_plugin_compatibility': {
      if (typeof input.plugin_name !== 'string' || input.plugin_name.trim() === '') throw new Error('plugin_name is required')
      return checkCompatibility({ pluginName: input.plugin_name.trim(), dshVersion: input.dsh_version })
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
