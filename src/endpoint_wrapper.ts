import { Client, handle_file } from "@gradio/client";
import { ApiStructure, ApiEndpoint, ApiReturn } from "./gradio_api.js";
import {
  convertApiToSchema,
  isFileParameter,
  ParameterSchema,
} from "./gradio_convert.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as fs from "fs/promises";
import type {
  CallToolResult,
  GetPromptResult,
  CallToolRequest,
} from "@modelcontextprotocol/sdk/types.d.ts";
import type {
  TextContent,
  ImageContent,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.d.ts";
import { createProgressNotifier } from "./progress_notifier.js";
import { GradioConverter, GradioResourceValue } from "./content_converter.js";
import { config } from "./config.js";
import type { StatusMessage, Payload } from "@gradio/client";
import { WorkingDirectory } from "./working_directory.js";

type GradioEvent = StatusMessage | Payload;

export interface EndpointPath {
  owner: string;
  space: string;
  endpoint: string | number;
  mcpToolName: string;
  mcpDisplayName: string;
}

export function endpointSpecified(path: string) {
  const parts = path.replace(/^\//, "").split("/");
  return parts.length === 3;
}

export function parsePath(path: string): EndpointPath {
  const parts = path.replace(/^\//, "").split("/");

  if (parts.length != 3) {
    throw new Error(
      `Invalid Endpoint path format [${path}]. Use or vendor/space/endpoint`,
    );
  }

  const [owner, space, rawEndpoint] = parts;
  return {
    owner,
    space,
    endpoint: isNaN(Number(rawEndpoint))
      ? `/${rawEndpoint}`
      : parseInt(rawEndpoint),
    mcpToolName: formatMcpToolName(space, rawEndpoint),
    mcpDisplayName: formatMcpDisplayName(space, rawEndpoint),
  };

  function formatMcpToolName(space: string, endpoint: string | number) {
    return `${space}-${endpoint}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  }

  function formatMcpDisplayName(space: string, endpoint: string | number) {
    return `${space} endpoint /${endpoint}`;
  }
}

export class EndpointWrapper {
  private converter: GradioConverter;

  constructor(
    private endpointPath: EndpointPath,
    private endpoint: ApiEndpoint,
    private client: Client,
    private workingDir: WorkingDirectory,
  ) {
    this.converter = new GradioConverter(workingDir);
  }

  static async createEndpoint(
    configuredPath: string,
    workingDir: WorkingDirectory,
  ): Promise<EndpointWrapper> {
    const pathParts = configuredPath.split("/");
    if (pathParts.length < 2 || pathParts.length > 3) {
      throw new Error(
        `Invalid space path format [${configuredPath}]. Use: vendor/space or vendor/space/endpoint`,
      );
    }

    const spaceName = `${pathParts[0]}/${pathParts[1]}`;
    const endpointTarget = pathParts[2] ? `/${pathParts[2]}` : undefined;

    const preferredApis = [
      "/predict",
      "/infer",
      "/generate",
      "/complete",
      "/model_chat",
      "/lambda",
      "/generate_image",
      "/process_prompt",
      "/on_submit",
      "/add_text",
    ];

    const gradio: Client = await Client.connect(spaceName, {
      events: ["data", "status"],
      hf_token: config.hfToken,
    });
    const api = (await gradio.view_api()) as ApiStructure;
    if (config.debug) {
      await fs.writeFile(
        `${pathParts[0]}_${pathParts[1]}_debug_api.json`,
        JSON.stringify(api, null, 2),
      );
    }
    // Try chosen API if specified
    if (endpointTarget && api.named_endpoints[endpointTarget]) {
      return new EndpointWrapper(
        parsePath(configuredPath),
        api.named_endpoints[endpointTarget],
        gradio,
        workingDir,
      );
    }

    // Try preferred APIs
    const preferredApi = preferredApis.find(
      (name) => api.named_endpoints[name],
    );
    if (preferredApi) {
      return new EndpointWrapper(
        parsePath(`${configuredPath}${preferredApi}`),
        api.named_endpoints[preferredApi],
        gradio,
        workingDir,
      );
    }

    // Try first named endpoint
    const firstNamed = Object.entries(api.named_endpoints)[0];
    if (firstNamed) {
      return new EndpointWrapper(
        parsePath(`${configuredPath}${firstNamed[0]}`),
        firstNamed[1],
        gradio,
        workingDir,
      );
    }

    // Try unnamed endpoints
    const validUnnamed = Object.entries(api.unnamed_endpoints).find(
      ([, endpoint]) =>
        endpoint.parameters.length > 0 && endpoint.returns.length > 0,
    );

    if (validUnnamed) {
      return new EndpointWrapper(
        parsePath(`${configuredPath}/${validUnnamed[0]}`),
        validUnnamed[1],
        gradio,
        workingDir,
      );
    }

    throw new Error(`No valid endpoints found for ${configuredPath}`);
  }

  async validatePath(filePath: string): Promise<string> {
    return this.workingDir.validatePath(filePath);
  }

  /* Endpoint Wrapper */
  private mcpDescriptionName(): string {
    return this.endpointPath.mcpDisplayName;
  }

  get mcpToolName() {
    return this.endpointPath.mcpToolName;
  }

  toolDefinition() {
    return {
      name: this.mcpToolName,
      description: `Call the ${this.mcpDescriptionName()}`,
      inputSchema: convertApiToSchema(this.endpoint),
    };
  }

  async call(
    request: CallToolRequest,
    server: Server,
  ): Promise<CallToolResult> {
    const progressToken = request.params._meta?.progressToken as
      | string
      | number
      | undefined;

    const parameters = request.params.arguments as Record<string, unknown>;

    // Get the endpoint parameters to check against
    const endpointParams = this.endpoint.parameters;

    // Process each parameter, applying handle_file for file inputs
    for (const [key, value] of Object.entries(parameters)) {
      const param = endpointParams.find(
        (p) => p.parameter_name === key || p.label === key,
      );
      if (param && isFileParameter(param) && typeof value === "string") {
        const file = await this.validatePath(value);
        parameters[key] = handle_file(file);
      }
    }

    const normalizedToken =
      typeof progressToken === "number"
        ? progressToken.toString()
        : progressToken;

    return this.handleToolCall(parameters, normalizedToken, server);
  }

  async handleToolCall(
    parameters: Record<string, unknown>,
    progressToken: string | undefined,
    server: Server,
  ): Promise<CallToolResult> {
    const events = [];
    try {
      let result = null;
      const submission: AsyncIterable<GradioEvent> = this.client.submit(
        this.endpointPath.endpoint,
        parameters,
      ) as AsyncIterable<GradioEvent>;
      const progressNotifier = createProgressNotifier(server);
      for await (const msg of submission) {
        if (config.debug) events.push(msg);
        if (msg.type === "data") {
          if (Array.isArray(msg.data)) {
            const hasContent = msg.data.some(
              (item: unknown) => typeof item !== "object",
            );

            if (hasContent) result = msg.data;
            if (null === result) result = msg.data;
          }
        } else if (msg.type === "status") {
          if (msg.stage === "error") {
            throw new Error(`Gradio error: ${msg.message || "Unknown error"}`);
          }
          if (progressToken) await progressNotifier.notify(msg, progressToken);
        }
      }

      if (!result) {
        throw new Error("No data received from endpoint");
      }

      return await this.convertPredictResults(
        this.endpoint.returns,
        result,
        this.endpointPath,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Error calling endpoint: ${errorMessage}`);
    } finally {
      if (config.debug && events.length > 0) {
        await fs.writeFile(
          `${this.mcpToolName}_status_${crypto
            .randomUUID()
            .substring(0, 5)}.json`,
          JSON.stringify(events, null, 2),
        );
      }
    }
  }

  private async convertPredictResults(
    returns: ApiReturn[],
    predictResults: unknown[],
    endpointPath: EndpointPath,
  ): Promise<CallToolResult> {
    const content: (TextContent | ImageContent | EmbeddedResource)[] = [];

    for (const [index, output] of returns.entries()) {
      const value = predictResults[index];
      const converted = await this.converter.convert(
        output,
        value as GradioResourceValue,
        endpointPath,
      );
      content.push(converted);
    }

    return {
      content,
      isError: false,
    };
  }

  promptName() {
    return this.mcpToolName;
  }

  promptDefinition() {
    const schema = convertApiToSchema(this.endpoint);
    return {
      name: this.promptName(),
      description: `Use the ${this.mcpDescriptionName()}.`,
      arguments: Object.entries(schema.properties).map(
        ([name, prop]: [string, ParameterSchema]) => ({
          name,
          description: prop?.description || name,
          required: schema.required?.includes(name) || false,
        }),
      ),
    };
  }

  async getPromptTemplate(
    args?: Record<string, string>,
  ): Promise<GetPromptResult> {
    const schema = convertApiToSchema(this.endpoint);
    let promptText = `Using the ${this.mcpDescriptionName()}:\n\n`;

    promptText += Object.entries(schema.properties)
      .map(([name, prop]: [string, ParameterSchema]) => {
        const defaultHint =
          prop?.default !== undefined ? ` - default: ${prop.default}` : "";
        const value =
          args?.[name] ||
          `[Provide ${prop?.description || name}${defaultHint}]`;
        return `${name}: ${value}`;
      })
      .join("\n");

    return {
      description: this.promptDefinition().description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: promptText,
          },
        },
      ],
    };
  }
}
