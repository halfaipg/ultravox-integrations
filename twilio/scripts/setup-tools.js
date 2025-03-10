/**
 * Tool Setup Script
 * 
 * This script registers all tools defined in the config/tools.js file with Ultravox.
 * It creates tools that don't exist yet and skips those that do.
 * 
 * Usage: node scripts/setup-tools.js
 */

import dotenv from 'dotenv';
import axios from 'axios';
import { tools } from '../config/tools.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Setup ES modules compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the twilio directory
dotenv.config({ path: join(__dirname, '..', '.env') });

// Configuration from environment
const ultravoxApiKey = process.env.ULTRAVOX_API_KEY;

// Normalize the API URL
function normalizeApiUrl(url = 'https://api.ultravox.ai') {
  // Remove trailing slashes
  url = url.replace(/\/+$/, '');
  
  // Remove /calls if present
  url = url.replace(/\/calls$/, '');
  
  // Remove /api if present at the end
  url = url.replace(/\/api$/, '');
  
  // Ensure the URL has a protocol
  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  
  return url;
}

const ultravoxApiUrl = normalizeApiUrl(process.env.ULTRAVOX_API_URL);

if (!ultravoxApiKey) {
  console.error('Error: ULTRAVOX_API_KEY environment variable is not set');
  console.error('Make sure you have a .env file in the twilio directory');
  process.exit(1);
}

/**
 * Create or update a tool in Ultravox
 * @param {Object} toolConfig - The tool configuration
 */
async function registerTool(toolConfig) {
  try {
    const url = `${ultravoxApiUrl}/tools`;
    console.log(`Registering tool ${toolConfig.name} at ${url}...`);
    console.log('Tool configuration:', JSON.stringify(toolConfig, null, 2));
    
    const response = await axios({
      method: 'POST',
      url,
      headers: {
        'Authorization': `Bearer ${ultravoxApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: toolConfig,
      validateStatus: null // Allow us to handle all status codes
    });
    
    console.log(`✅ Successfully registered tool: ${toolConfig.name}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error(`❌ Error registering tool ${toolConfig.name}:`, {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        headers: error.response.headers,
        url: error.config.url,
        method: error.config.method,
        requestHeaders: error.config.headers
      });
      
      if (error.response.status === 409) {
        console.log(`⚠️ Tool ${toolConfig.name} already exists`);
        return { exists: true };
      }
    } else if (error.request) {
      console.error(`❌ No response received for tool ${toolConfig.name}:`, error.message);
      console.error('Request details:', {
        url: error.config.url,
        method: error.config.method,
        headers: error.config.headers
      });
    } else {
      console.error(`❌ Error setting up request for tool ${toolConfig.name}:`, error.message);
    }
    return null;
  }
}

/**
 * Setup all tools defined in the configuration
 */
async function setupTools() {
  console.log('🔧 Setting up Ultravox tools...');
  console.log(`Using API URL: ${ultravoxApiUrl}`);
  console.log('API Key present:', !!ultravoxApiKey);
  console.log('Current directory:', __dirname);
  console.log('Env file path:', join(__dirname, '..', '.env'));
  
  // Get tool names from environment or use all available tools
  const toolsToSetup = process.env.ULTRAVOX_TOOLS_TO_REGISTER
    ? process.env.ULTRAVOX_TOOLS_TO_REGISTER.split(',').map(t => t.trim())
    : Object.keys(tools);
  
  console.log(`📋 Registering ${toolsToSetup.length} tools:`, toolsToSetup.join(', '));
  
  const results = [];
  for (const name of toolsToSetup) {
    if (tools[name]) {
      const result = await registerTool(tools[name]);
      results.push(result);
    } else {
      console.warn(`⚠️ Tool "${name}" not found in configuration`);
    }
  }
  
  console.log('🎉 Tool setup complete!');
  return results;
}

// Run the setup if this script is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupTools().catch(error => {
    console.error('Failed to set up tools:', error);
    process.exit(1);
  });
}

export { setupTools, registerTool }; 