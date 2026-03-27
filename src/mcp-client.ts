import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FunctionDeclaration, FunctionDeclarationSchema } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";

interface McpClientOptions {
  workingDir?: string;
}

export class McpClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(options?: McpClientOptions) {
    const workingDir = options?.workingDir;
    const env =
      workingDir && process.env
        ? {
            ...process.env,
            TMP: workingDir,
            TEMP: workingDir,
            TMPDIR: workingDir,
          }
        : undefined;

    this.transport = new StdioClientTransport({
      command: "npx",
      args: [
        "@playwright/mcp@latest",
        "--browser", "chromium",
        "--user-data-dir", workingDir ?? "",
      ],
      cwd: workingDir,
      env,
      stderr: "inherit",
    });

    this.client = new Client(
      { name: "exploratory-tester", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    console.log("Connected to Playwright MCP server");
  }

  async listTools() {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    try {
      await this.client.callTool({ name: "browser_close", arguments: {} });
    } catch {
      // browser may already be closed
    }
    await this.client.close();
    await this.transport.close();
    console.log("Disconnected from Playwright MCP server");
  }

  /**
   * Convert MCP tool schemas to Gemini FunctionDeclaration format.
   */
  async getGeminiFunctionDeclarations(): Promise<FunctionDeclaration[]> {
    const tools = await this.listTools();
    return tools.map((tool) => {
      const decl: FunctionDeclaration = {
        name: tool.name,
        description: tool.description ?? "",
      };

      if (tool.inputSchema && tool.inputSchema.properties) {
        decl.parameters = convertJsonSchemaToGemini(tool.inputSchema);
      }

      return decl;
    });
  }
}

/**
 * Convert a JSON Schema object (from MCP) to Gemini's FunctionDeclarationSchema.
 * Handles nested objects and arrays recursively.
 */
function convertJsonSchemaToGemini(
  schema: Record<string, unknown>
): FunctionDeclarationSchema {
  const properties: Record<string, unknown> = (schema.properties ??
    {}) as Record<string, unknown>;
  const converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    converted[key] = convertPropertySchema(value as Record<string, unknown>);
  }

  return {
    type: SchemaType.OBJECT,
    properties: converted as FunctionDeclarationSchema["properties"],
    required: (schema.required as string[]) ?? undefined,
    description: (schema.description as string) ?? undefined,
  };
}

function convertPropertySchema(
  prop: Record<string, unknown>
): Record<string, unknown> {
  const type = prop.type as string;
  const result: Record<string, unknown> = {};

  switch (type) {
    case "string":
      result.type = SchemaType.STRING;
      break;
    case "number":
      result.type = SchemaType.NUMBER;
      break;
    case "integer":
      result.type = SchemaType.INTEGER;
      break;
    case "boolean":
      result.type = SchemaType.BOOLEAN;
      break;
    case "array":
      result.type = SchemaType.ARRAY;
      if (prop.items) {
        result.items = convertPropertySchema(
          prop.items as Record<string, unknown>
        );
      }
      break;
    case "object":
      result.type = SchemaType.OBJECT;
      if (prop.properties) {
        const nested: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(
          prop.properties as Record<string, unknown>
        )) {
          nested[k] = convertPropertySchema(v as Record<string, unknown>);
        }
        result.properties = nested;
      }
      if (prop.required) {
        result.required = prop.required;
      }
      break;
    default:
      result.type = SchemaType.STRING;
      break;
  }

  if (prop.description) {
    result.description = prop.description;
  }
  if (prop.enum) {
    result.enum = prop.enum;
  }

  return result;
}
