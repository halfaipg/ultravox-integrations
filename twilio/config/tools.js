/**
 * Ultravox Tools Configuration
 * 
 * This file contains the definitions for all custom tools used with Ultravox.
 * All tools are defined through environment variables.
 */

// Import environment variables
import dotenv from 'dotenv';
dotenv.config();

// Function to parse a tool definition from environment variables
function parseToolFromEnv(prefix) {
  const name = process.env[`${prefix}_NAME`];
  if (!name) return null;
  
  return {
    name,
    description: process.env[`${prefix}_DESCRIPTION`],
    http: {
      baseUrlPattern: process.env[`${prefix}_URL`],
      httpMethod: process.env[`${prefix}_METHOD`] || 'GET'
    },
    // Parse response schema if provided
    responseSchema: process.env[`${prefix}_RESPONSE_SCHEMA`] 
      ? JSON.parse(process.env[`${prefix}_RESPONSE_SCHEMA`])
      : undefined,
    // Parse examples if provided
    examples: process.env[`${prefix}_EXAMPLES`]
      ? JSON.parse(process.env[`${prefix}_EXAMPLES`])
      : undefined,
    // Parse dynamic parameters if provided
    dynamicParameters: process.env[`${prefix}_PARAMS`] 
      ? JSON.parse(process.env[`${prefix}_PARAMS`]) 
      : []
  };
}

// Parse tools from environment variables
const tools = {};

// Look for ULTRAVOX_TOOL_1, ULTRAVOX_TOOL_2, etc.
for (let i = 1; i <= 10; i++) {
  const toolPrefix = `ULTRAVOX_TOOL_${i}`;
  const tool = parseToolFromEnv(toolPrefix);
  if (tool) {
    tools[tool.name] = tool;
  }
}

// Remove logging statements to ensure clean output

export { tools }; 