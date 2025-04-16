#!/usr/bin/env node

const AVAILABLE_RESOURCES = "Available Resources";
const AVAILABLE_FILES = "available-files";
const SEARCH_FOR_SPACE = "search-spaces";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { VERSION } from "./version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Remove mime import and treatAsText import as they're now handled in WorkingDirectory
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EndpointWrapper } from "./endpoint_wrapper.js";
import { parseConfig } from "./config.js";
import { WorkingDirectory } from "./working_directory.js";

// Create MCP server
const server = new Server(
  {
    name: "mcp-hfspace",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {
        list: true,
      },
    },
  }
);
// Parse configuration
const config = parseConfig();

// Change to configured working directory
process.chdir(config.workDir);

const workingDir = new WorkingDirectory(
  config.workDir,
  config.claudeDesktopMode
);

// Create a map to store endpoints by their tool names
const endpoints = new Map<string, EndpointWrapper>();

// Create endpoints with working directory
for (const spacePath of config.spacePaths) {
  try {
    const endpoint = await EndpointWrapper.createEndpoint(
      spacePath,
      workingDir
    );
    endpoints.set(endpoint.toolDefinition().name, endpoint);
  } catch (e) {
    if (e instanceof Error) {
      console.error(`Error loading ${spacePath}: ${e.message}`);
    } else {
      throw e;
    }
    continue;
  }
}

if (endpoints.size === 0) {
  throw new Error("No valid endpoints found in any of the provided spaces");
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: AVAILABLE_FILES,
        description:
          "A list of available file and resources. " +
          "If the User requests things like 'most recent image' or 'the audio' use " +
          "this tool to identify the intended resource." +
          "This tool returns 'resource uri', 'name', 'size', 'last modified'  and 'mime type' in a markdown table",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: SEARCH_FOR_SPACE,
        description: "Search for a space",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
            },
          },
        },
      },
      ...Array.from(endpoints.values()).map((endpoint) =>
        endpoint.toolDefinition()
      ),
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (AVAILABLE_FILES === request.params.name) {
    return {
      content: [
        {
          type: `resource`,
          resource: {
            uri: `resource://mcp-hfspace/available-files`,
            mimeType: `text/markdown`,
            text: await workingDir.generateResourceTable(),
          },
        },
      ],
    };
  }

  const endpoint = endpoints.get(request.params.name);

  if (!endpoint) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  try {
    return await endpoint.call(request, server);
  } catch (error) {
    if (error instanceof Error) {
      return {
        content: [
          {
            type: `text`,
            text: `mcp-hfspace error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: AVAILABLE_RESOURCES,
        description: "List of available resources.",
        arguments: [],
      },
      ...Array.from(endpoints.values()).map((endpoint) =>
        endpoint.promptDefinition()
      ),
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const promptName = request.params.name;

  if (AVAILABLE_RESOURCES === promptName) {
    return availableResourcesPrompt();
  }

  const endpoint = endpoints.get(promptName);

  if (!endpoint) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }

  return await endpoint.getPromptTemplate(request.params.arguments);
});

async function availableResourcesPrompt() {
  const tableText = await workingDir.generateResourceTable();

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: tableText,
        },
      },
    ],
  };
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const resources = await workingDir.getSupportedResources();
    return {
      resources: resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        mimetype: resource.mimeType,
      })),
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to list resources: ${error.message}`);
    }
    throw error;
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const contents = await workingDir.readResource(request.params.uri);
    return {
      contents: [contents],
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read resource: ${error.message}`);
    }
    throw error;
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
