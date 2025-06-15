/**
 * Neon FastMCP server demonstrating database operations with SSE transport.
 *
 * Features demonstrated:
 * - Neon database connection management
 * - SQL query execution with streaming results
 * - Database schema inspection
 * - SSE transport for real-time updates
 *
 * Prerequisites:
 * - Install @neondatabase/serverless: npm install @neondatabase/serverless
 * - Set NEON_DATABASE_URL in .env.local file
 */
import { readFileSync } from "fs";
import { z } from "zod";
import { FastMCP, UserError } from "../FastMCP.js";

// Load environment variables from .env.local
try {
  const envLocal = readFileSync(".env.local", "utf8");
  const envVars = envLocal.split("\n").filter(line => line.trim() && !line.startsWith("#"));
  
  envVars.forEach(line => {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) {
      const value = valueParts.join("=").trim();
      // Remove quotes if present
      const cleanValue = value.replace(/^["']|["']$/g, "");
      process.env[key.trim()] = cleanValue;
    }
  });
  
  console.log("✅ Loaded environment variables from .env.local");
} catch (error) {
  console.log("ℹ️  No .env.local file found or error reading it. Using system environment variables.");
}

// Neon database imports (you'll need to install @neondatabase/serverless)
let neon: any;

try {
  const neonModule = await import("@neondatabase/serverless");
  neon = neonModule.neon;
} catch {
  console.warn(
    "Neon database module not found. Install with: npm install @neondatabase/serverless"
  );
}

const server = new FastMCP({
  name: "Neon Database MCP",
  version: "1.0.0",
  instructions:
    "This server provides tools for interacting with Neon PostgreSQL databases. Use the query tool to execute SQL statements and the schema tools to inspect database structure.",
  ping: {
    enabled: true,
    intervalMs: 10000,
    logLevel: "debug",
  },
});

// Database connection helper
function getDatabaseConnection() {
  const databaseUrl = process.env.NEON_DATABASE_URL;
  if (!databaseUrl) {
    throw new UserError("NEON_DATABASE_URL environment variable is required");
  }

  if (!neon) {
    throw new UserError(
      "@neondatabase/serverless package is not installed. Run: npm install @neondatabase/serverless"
    );
  }

  return neon(databaseUrl);
}

// --- Database Query Tool ---
server.addTool({
  name: "query",
  description: "Execute a SQL query against the Neon database",
  annotations: {
    title: "Database Query",
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    sql: z.string().describe("The SQL query to execute"),
    limit: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum number of rows to return"),
  }),
  execute: async (args, { log, streamContent }) => {
    try {
      const db = getDatabaseConnection();

      log.info("Executing SQL query", {
        query: args.sql.substring(0, 100) + "...",
      });

      // Stream the query execution status
      await streamContent({
        type: "text",
        text: `🔄 Executing query: ${args.sql.substring(0, 50)}...\n`,
      });

      const startTime = Date.now();
      // For dynamic SQL, we need to use unsafe() method
      // Note: This allows arbitrary SQL execution - use with caution
      const result = await db.unsafe(args.sql);
      const executionTime = Date.now() - startTime;

      await streamContent({
        type: "text",
        text: `✅ Query completed in ${executionTime}ms\n`,
      });

      // Limit results if needed
      const limitedResult = Array.isArray(result)
        ? result.slice(0, args.limit)
        : result;

      log.info("Query executed successfully", {
        rowCount: Array.isArray(result) ? result.length : 1,
        executionTime,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Query Results (${Array.isArray(result) ? result.length : 1} rows, ${executionTime}ms):\n\n` +
              JSON.stringify(limitedResult, null, 2),
          },
        ],
      };
    } catch (error) {
      log.error("Query execution failed", { error: error.message });
      throw new UserError(`Database query failed: ${error.message}`);
    }
  },
});

// --- Schema Inspection Tool ---
server.addTool({
  name: "list-tables",
  description: "List all tables in the database",
  annotations: {
    title: "List Database Tables",
    readOnlyHint: true,
    openWorldHint: true,
  },
  execute: async (args, { log }) => {
    try {
      const db = getDatabaseConnection();

      log.info("Fetching database tables");

      const result = await db`
        SELECT table_name, table_schema, table_type
        FROM information_schema.tables 
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
        ORDER BY table_schema, table_name
      `;

      return {
        content: [
          {
            type: "text",
            text:
              `Database Tables (${result.length} found):\n\n` +
              result
                .map(
                  (row) =>
                    `${row.table_schema}.${row.table_name} (${row.table_type})`
                )
                .join("\n"),
          },
        ],
      };
    } catch (error) {
      log.error("Failed to list tables", { error: error.message });
      throw new UserError(`Failed to list tables: ${error.message}`);
    }
  },
});

// --- Table Schema Tool ---
server.addTool({
  name: "describe-table",
  description: "Get the schema/structure of a specific table",
  annotations: {
    title: "Describe Table Schema",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    table_name: z.string().describe("Name of the table to describe"),
    schema: z
      .string()
      .optional()
      .default("public")
      .describe("Schema name (defaults to 'public')"),
  }),
  execute: async (args, { log }) => {
    try {
      const db = getDatabaseConnection();

      log.info("Describing table schema", {
        table: `${args.schema}.${args.table_name}`,
      });

      const result = await db`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default,
          character_maximum_length,
          numeric_precision,
          numeric_scale
        FROM information_schema.columns 
        WHERE table_name = ${args.table_name} AND table_schema = ${args.schema}
        ORDER BY ordinal_position
      `;

      if (result.length === 0) {
        throw new UserError(
          `Table '${args.schema}.${args.table_name}' not found`
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Schema for ${args.schema}.${args.table_name}:\n\n` +
              result
                .map(
                  (col) =>
                    `${col.column_name}: ${col.data_type}` +
                    (col.character_maximum_length
                      ? `(${col.character_maximum_length})`
                      : "") +
                    (col.is_nullable === "NO" ? " NOT NULL" : "") +
                    (col.column_default ? ` DEFAULT ${col.column_default}` : "")
                )
                .join("\n"),
          },
        ],
      };
    } catch (error) {
      log.error("Failed to describe table", { error: error.message });
      throw new UserError(`Failed to describe table: ${error.message}`);
    }
  },
});

// --- Database Resource for Connection Status ---
server.addResource({
  uri: "neon://connection/status",
  name: "Database Connection Status",
  mimeType: "application/json",
  async load() {
    try {
      const databaseUrl = process.env.NEON_DATABASE_URL;
      const hasNeonModule = !!neon;
      
      return {
        text: JSON.stringify({
          status: databaseUrl && hasNeonModule ? "ready" : "not_configured",
          hasCredentials: !!databaseUrl,
          hasNeonModule,
          timestamp: new Date().toISOString(),
        }, null, 2),
      };
    } catch (error) {
      return {
        text: JSON.stringify({
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
          timestamp: new Date().toISOString(),
        }, null, 2),
      };
    }
  },
});

// --- Streaming Query Results Tool ---
server.addTool({
  name: "stream-query-results",
  description: "Execute a query and stream results in batches for large datasets",
  annotations: {
    title: "Stream Query Results",
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    streamingHint: true,
  },
  parameters: z.object({
    sql: z.string().describe("The SQL query to execute"),
    batchSize: z.number().optional().default(10).describe("Number of rows per batch"),
  }),
  execute: async (args, { log, streamContent, reportProgress }) => {
    try {
      const db = getDatabaseConnection();
      
      log.info("Executing streaming query", { query: args.sql.substring(0, 100) + "..." });
      
      await streamContent({
        type: "text",
        text: `🔄 Starting streaming query: ${args.sql.substring(0, 50)}...\n\n`,
      });

      const startTime = Date.now();
      // For dynamic SQL, we need to use unsafe() method
      const result = await db.unsafe(args.sql);
      const executionTime = Date.now() - startTime;
      
      if (!Array.isArray(result)) {
        await streamContent({
          type: "text",
          text: `✅ Query completed (${executionTime}ms):\n${JSON.stringify(result, null, 2)}\n`,
        });
        return;
      }

      const totalRows = result.length;
      await streamContent({
        type: "text",
        text: `📊 Query returned ${totalRows} rows (${executionTime}ms). Streaming in batches of ${args.batchSize}...\n\n`,
      });

      // Stream results in batches
      for (let i = 0; i < totalRows; i += args.batchSize) {
        const batch = result.slice(i, i + args.batchSize);
        const batchNumber = Math.floor(i / args.batchSize) + 1;
        const totalBatches = Math.ceil(totalRows / args.batchSize);
        
        await reportProgress({
          progress: i + batch.length,
          total: totalRows,
        });

        await streamContent({
          type: "text",
          text: `📦 Batch ${batchNumber}/${totalBatches} (rows ${i + 1}-${i + batch.length}):\n${JSON.stringify(batch, null, 2)}\n\n`,
        });

        // Small delay to simulate streaming
        if (i + args.batchSize < totalRows) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      await streamContent({
        type: "text",
        text: `✅ Streaming complete! Total: ${totalRows} rows in ${executionTime}ms\n`,
      });

    } catch (error) {
      log.error("Streaming query failed", { error: error instanceof Error ? error.message : "Unknown error" });
      throw new UserError(`Streaming query failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

// Select transport type - prioritize SSE, then HTTP Stream, then stdio
const transportType = process.argv.includes("--sse")
  ? "sse"
  : process.argv.includes("--http-stream")
  ? "httpStream"
  : "stdio";

if (transportType === "sse") {
  // Start with SSE transport - optimal for streaming database operations
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  server.start({
    httpStream: {
      port: PORT,
    },
    transportType: "httpStream",
  });

  console.log(`🚀 Neon Database MCP Server (SSE Mode)`);
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`🔗 HTTP Stream endpoint: http://localhost:${PORT}/mcp`);
  console.log(`💾 Database: ${process.env.NEON_DATABASE_URL ? "✅ Configured" : "❌ Not configured"}`);
  console.log("\n📋 Usage Examples:");
  console.log("For SSE connection:");
  console.log(`
  import { Client } from "@modelcontextprotocol/sdk/client/index.js";
  import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
  
  const client = new Client({
    name: "neon-client",
    version: "1.0.0",
  }, { capabilities: {} });
  
  const transport = new SSEClientTransport(
    new URL("http://localhost:${PORT}/sse")
  );
  
  await client.connect(transport);
  `);
  
} else if (transportType === "httpStream") {
  // Start with HTTP streaming transport
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  server.start({
    httpStream: {
      port: PORT,
    },
    transportType: "httpStream",
  });

  console.log(`🚀 Neon Database MCP Server (HTTP Stream Mode)`);
  console.log(`🔗 HTTP Stream endpoint: http://localhost:${PORT}/mcp`);
  console.log(`💾 Database: ${process.env.NEON_DATABASE_URL ? "✅ Configured" : "❌ Not configured"}`);
  console.log("\n📋 Usage Example:");
  console.log(`
  import { Client } from "@modelcontextprotocol/sdk/client/index.js";
  import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
  
  const client = new Client({
    name: "neon-client",
    version: "1.0.0",
  }, { capabilities: {} });
  
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:${PORT}/mcp")
  );
  
  await client.connect(transport);
  `);
  
} else {
  // Default to stdio transport
  server.start({
    transportType: "stdio",
  });

  console.log(`🚀 Neon Database MCP Server (STDIO Mode)`);
  console.log(`💾 Database: ${process.env.NEON_DATABASE_URL ? "✅ Configured" : "❌ Not configured"}`);
  console.log("\n📋 Available Tools:");
  console.log("  • query - Execute SQL queries with streaming results");
  console.log("  • list-tables - List all database tables");
  console.log("  • describe-table - Get table schema information");
  console.log("  • stream-query-results - Stream large query results in batches");
  console.log("\nUsage: Set NEON_DATABASE_URL environment variable to connect to your database");
}
